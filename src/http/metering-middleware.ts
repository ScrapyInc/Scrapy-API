import type { FastifyRequest, FastifyReply } from 'fastify';
import { HttpError } from '../http/errors.ts';
import { createServiceStore } from '../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../logger/types.ts';
import type { RedisInstance } from '../db/redis.ts';
import type { Tier } from '../db/service/types.ts';
import {
  checkMetering,
  incrementCounters,
  type MeteringResult,
} from '../metering/index.ts';

declare module 'fastify' {
  interface FastifyRequest {
    meteringResult?: MeteringResult;
    meteringCost?: number;
    meteringTier?: Tier;
  }
}

export interface MeteringDeps {
  servicePool: pg.Pool;
  redis: RedisInstance;
  logger: Logger;
}

/**
 * Calculates the credit cost for a request based on the endpoint and tier.
 */
export function calculateCost(
  endpoint: string,
  queryCount: number,
  tier: Tier
): number {
  if (endpoint === '/v1/search' || endpoint === '/v1/chains' || endpoint.startsWith('/v1/refreshes')) {
    return tier.creditPerSearch;
  }
  if (endpoint === '/v1/search/batch') {
    return tier.creditPerBatchQuery * queryCount;
  }
  return 0;
}

/**
 * Creates the metering middleware that enforces tier caps and credit balances.
 */
export function createMeteringMiddleware(deps: MeteringDeps) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    // Skip metering for unauthenticated endpoints
    // These are handled by the API key middleware which runs first
    const apiKeyUser = request.apiKeyUser;
    if (!apiKeyUser) {
      // No API key user - should have been caught by auth middleware
      // But we allow through for endpoints that don't require auth
      return;
    }

    const { servicePool, redis, logger } = deps;
    const store = createServiceStore(servicePool, logger);

    // Get user's tier
    const tier = await store.withSnapshot(async (reader) => reader.findTierById(apiKeyUser.tier));
    if (!tier) {
      throw new HttpError(500, 'INTERNAL_ERROR', 'Tier not found');
    }

    // Get user's credit balance
    const balance = await store.withSnapshot(async (reader) => reader.getCreditBalance(apiKeyUser.id));
    const currentBalance = balance?.balance ?? 0;

    // Calculate cost based on endpoint
    const queryCount = request.routeOptions?.url === '/v1/search/batch'
      ? (request.body as { queries?: unknown[] } | undefined)?.queries?.length ?? 1
      : 1;
    const cost = calculateCost(request.routeOptions?.url ?? request.url, queryCount, tier);

    // Check metering limits
    const result = await checkMetering(
      {
        redis,
        tier,
        apiKeyId: apiKeyUser.apiKeyId,
        userId: apiKeyUser.id,
        cost,
      },
      currentBalance
    );

    // Set response headers
    reply.header('x-credits-remaining', String(result.creditsRemaining));
    if (result.tierCapRemaining >= 0) {
      reply.header('x-tier-cap-remaining', String(result.tierCapRemaining));
    }
    reply.header('x-tier-reset-at', result.tierResetAt);

    if (!result.allowed) {
      const retryAfter = result.retryAfterSeconds ?? 60;
      reply.header('retry-after', String(retryAfter));
      throw new HttpError(
        429,
        result.errorCode ?? 'TIER_CAP_EXCEEDED',
        result.errorCode === 'INSUFFICIENT_CREDITS'
          ? 'Insufficient credits to complete this request'
          : 'Tier cap exceeded',
        undefined,
        retryAfter
      );
    }

    // Store the metering result for use after the request succeeds
    request.meteringResult = result;
    request.meteringCost = cost;
    request.meteringTier = tier;
  };
}

/**
 * Call this after a successful request to deduct credits and increment counters.
 */
export async function finalizeMetering(
  deps: MeteringDeps,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const meteringResult = request.meteringResult;
  const cost = request.meteringCost;
  const tier = request.meteringTier;
  const apiKeyUser = request.apiKeyUser;

  if (!meteringResult || !cost || !tier || !apiKeyUser) {
    return;
  }

  const { servicePool, redis, logger } = deps;
  const store = createServiceStore(servicePool, logger);

  try {
    // Deduct credits and create ledger entry
    await store.applyCreditTransaction(
      apiKeyUser.id,
      -cost,
      'api_call',
      `${request.routeOptions?.url ?? request.url}:${request.id}`
    );

    // Increment Redis counters
    await incrementCounters(redis, apiKeyUser.apiKeyId, tier);

    // Update credits remaining header with actual balance after deduction
    const newBalance = await store.withSnapshot(async (reader) => reader.getCreditBalance(apiKeyUser.id));
    reply.header('x-credits-remaining', String(newBalance?.balance ?? meteringResult.creditsRemaining));
  } catch (error) {
    logger.error('Failed to finalize metering', {
      requestId: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - the request already succeeded
  }
}