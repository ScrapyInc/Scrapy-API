import type { RedisInstance } from '../db/redis.ts';
import type { Tier } from '../db/service/types.ts';

export interface MeteringConfig {
  redis: RedisInstance;
  tier: Tier;
  apiKeyId: string;
  userId: string;
  cost: number;
}

export interface MeteringResult {
  allowed: boolean;
  errorCode?: 'TIER_CAP_EXCEEDED' | 'INSUFFICIENT_CREDITS';
  retryAfterSeconds?: number;
  creditsRemaining: number;
  tierCapRemaining: number;
  tierResetAt: string;
}

/**
 * Generates Redis key for daily counter.
 * Format: metering:daily:{apiKeyId}:{YYYY-MM-DD}
 */
export function getDailyCounterKey(apiKeyId: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().split('T')[0];
  return `metering:daily:${apiKeyId}:${dateStr}`;
}

/**
 * Generates Redis key for monthly counter.
 * Format: metering:monthly:{apiKeyId}:{YYYY-MM}
 */
export function getMonthlyCounterKey(apiKeyId: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 7);
  return `metering:monthly:${apiKeyId}:${dateStr}`;
}

/**
 * Gets the end of the current day as ISO timestamp.
 */
export function getEndOfDay(date: Date = new Date()): string {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end.toISOString();
}

/**
 * Gets the end of the current month as ISO timestamp.
 */
export function getEndOfMonth(date: Date = new Date()): string {
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
  return end.toISOString();
}

/**
 * Calculates seconds until the next reset (day or month, whichever comes first).
 */
export function getSecondsUntilReset(tier: Tier, date: Date = new Date()): number {
  const now = date.getTime();
  const dailyReset = tier.dailySearchCap !== null
    ? new Date(date).setUTCHours(24, 0, 0, 0)
    : Infinity;
  const monthlyReset = tier.monthlySearchCap !== null
    ? new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime()
    : Infinity;
  const nextReset = Math.min(dailyReset, monthlyReset);
  if (!Number.isFinite(nextReset)) return 1;
  return Math.max(1, Math.ceil((nextReset - now) / 1000));
}

/**
 * Checks if the tier cap is exceeded for the given counters.
 * Returns true if the next request would exceed the cap.
 */
export function isTierCapExceeded(
  dailyCount: number,
  monthlyCount: number,
  tier: Tier
): { exceeded: boolean; capType: 'daily' | 'monthly' | null; retryAfterSeconds: number } {
  if (tier.dailySearchCap !== null && dailyCount >= tier.dailySearchCap) {
    return { exceeded: true, capType: 'daily', retryAfterSeconds: getSecondsUntilReset(tier) };
  }
  if (tier.monthlySearchCap !== null && monthlyCount >= tier.monthlySearchCap) {
    return { exceeded: true, capType: 'monthly', retryAfterSeconds: getSecondsUntilReset(tier) };
  }
  return { exceeded: false, capType: null, retryAfterSeconds: 0 };
}

/**
 * Checks if the credit balance is sufficient for the cost.
 */
export function isCreditSufficient(balance: number, cost: number): boolean {
  return balance >= cost;
}

/**
 * Increments the Redis counters for the API key.
 * Returns the new counter values.
 */
export async function incrementCounters(
  redis: RedisInstance,
  apiKeyId: string,
  tier: Tier
): Promise<{ dailyCount: number; monthlyCount: number }> {
  const dailyKey = getDailyCounterKey(apiKeyId);
  const monthlyKey = getMonthlyCounterKey(apiKeyId);

  const pipeline = redis.pipeline();
  const hasDaily = tier.dailySearchCap !== null;
  const hasMonthly = tier.monthlySearchCap !== null;

  if (hasDaily) {
    pipeline.incr(dailyKey);
    // Set expiry to end of day + 1 hour buffer
    const ttlSeconds = getSecondsUntilReset(tier) + 3600;
    pipeline.expire(dailyKey, ttlSeconds);
  }

  if (hasMonthly) {
    pipeline.incr(monthlyKey);
    // Set expiry to end of month + 1 hour buffer
    const ttlSeconds = getSecondsUntilReset(tier) + 3600;
    pipeline.expire(monthlyKey, ttlSeconds);
  }

  const results = await pipeline.exec();
  let resultIndex = 0;
  const dailyCount = hasDaily ? Number(results?.[resultIndex++]?.[1] ?? 0) : 0;
  const monthlyCount = hasMonthly ? Number(results?.[resultIndex]?.[1] ?? 0) : 0;

  return { dailyCount, monthlyCount };
}

/**
 * Gets the current counter values without incrementing.
 */
export async function getCounters(
  redis: RedisInstance,
  apiKeyId: string,
  tier: Tier
): Promise<{ dailyCount: number; monthlyCount: number }> {
  const dailyKey = getDailyCounterKey(apiKeyId);
  const monthlyKey = getMonthlyCounterKey(apiKeyId);

  const pipeline = redis.pipeline();
  const hasDaily = tier.dailySearchCap !== null;
  const hasMonthly = tier.monthlySearchCap !== null;

  if (hasDaily) {
    pipeline.get(dailyKey);
  }
  if (hasMonthly) {
    pipeline.get(monthlyKey);
  }

  const results = await pipeline.exec();
  let resultIndex = 0;
  const dailyCount = hasDaily ? Number(results?.[resultIndex++]?.[1] ?? 0) : 0;
  const monthlyCount = hasMonthly ? Number(results?.[resultIndex]?.[1] ?? 0) : 0;

  return { dailyCount, monthlyCount };
}

/**
 * Main metering check function - verifies tier caps and credit balance.
 * Does NOT increment counters or deduct credits - just checks.
 */
export async function checkMetering(
  config: MeteringConfig,
  currentBalance: number
): Promise<MeteringResult> {
  const { redis, tier, apiKeyId, cost } = config;

  // Get current counters
  const { dailyCount, monthlyCount } = await getCounters(redis, apiKeyId, tier);

  // Check tier caps
  const capCheck = isTierCapExceeded(dailyCount, monthlyCount, tier);
  if (capCheck.exceeded) {
    return {
      allowed: false,
      errorCode: 'TIER_CAP_EXCEEDED',
      retryAfterSeconds: capCheck.retryAfterSeconds,
      creditsRemaining: currentBalance,
      tierCapRemaining: 0,
      tierResetAt: capCheck.capType === 'daily' ? getEndOfDay() : getEndOfMonth(),
    };
  }

  // Check credit balance
  if (!isCreditSufficient(currentBalance, cost)) {
    return {
      allowed: false,
      errorCode: 'INSUFFICIENT_CREDITS',
      retryAfterSeconds: 0,
      creditsRemaining: currentBalance,
      tierCapRemaining: tier.dailySearchCap !== null
        ? Math.max(0, tier.dailySearchCap - dailyCount)
        : tier.monthlySearchCap !== null
          ? Math.max(0, tier.monthlySearchCap - monthlyCount)
          : -1,
      tierResetAt: tier.dailySearchCap !== null ? getEndOfDay() : getEndOfMonth(),
    };
  }

  // All checks passed
  const tierCapRemaining = tier.dailySearchCap !== null
    ? Math.max(0, tier.dailySearchCap - dailyCount)
    : tier.monthlySearchCap !== null
      ? Math.max(0, tier.monthlySearchCap - monthlyCount)
      : -1;

  return {
    allowed: true,
    creditsRemaining: currentBalance - cost,
    tierCapRemaining,
    tierResetAt: tier.dailySearchCap !== null ? getEndOfDay() : getEndOfMonth(),
  };
}