import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RedisInstance } from '../../src/db/redis.ts';
import type { Tier } from '../../src/db/service/types.ts';
import {
  getDailyCounterKey,
  getMonthlyCounterKey,
  getEndOfDay,
  getEndOfMonth,
  getSecondsUntilReset,
  isTierCapExceeded,
  isCreditSufficient,
  incrementCounters,
  getCounters,
  checkMetering,
} from '../../src/metering/index.ts';

// Mock Redis client
function createMockRedis(): RedisInstance {
  const store = new Map<string, string>();
  
  const pipelineCommands: Array<{ cmd: string; key: string }> = [];
  
  const pipeline = () => {
    pipelineCommands.length = 0;
    return {
      incr: (key: string) => {
        pipelineCommands.push({ cmd: 'incr', key });
        return {
          incr: (key: string) => {
            pipelineCommands.push({ cmd: 'incr', key });
            return {
              expire: (_key: string) => {
                pipelineCommands.push({ cmd: 'expire', key: _key });
                return { exec: async () => [] };
              },
              get: (key: string) => {
                pipelineCommands.push({ cmd: 'get', key });
                return { expire: () => ({ exec: async () => [] }) };
              },
            };
          },
          get: (key: string) => {
            pipelineCommands.push({ cmd: 'get', key });
            return { expire: () => ({ exec: async () => [] }) };
          },
          expire: (key: string) => {
            pipelineCommands.push({ cmd: 'expire', key });
            return { exec: async () => [] };
          },
        };
      },
      get: (key: string) => {
        pipelineCommands.push({ cmd: 'get', key });
        return {
          get: (key: string) => {
            pipelineCommands.push({ cmd: 'get', key });
            return { expire: () => ({ exec: async () => [] }) };
          },
          expire: (key: string) => {
            pipelineCommands.push({ cmd: 'expire', key });
            return { exec: async () => [] };
          },
        };
      },
      expire: (key: string) => {
        pipelineCommands.push({ cmd: 'expire', key });
        return { exec: async () => [] };
      },
      exec: async () => {
        const results: Array<[null, number | string | null]> = [];
        for (const { cmd, key } of pipelineCommands) {
          if (cmd === 'incr') {
            const current = Number(store.get(key) ?? '0');
            const next = current + 1;
            store.set(key, String(next));
            results.push([null, next]);
          } else if (cmd === 'get') {
            results.push([null, store.get(key) ?? null]);
          } else if (cmd === 'expire') {
            results.push([null, 1]);
          }
        }
        return results;
      },
    };
  };
  
  const mockRedis: RedisInstance = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    incr: async (key: string) => {
      const current = Number(store.get(key) ?? '0');
      const next = current + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    pipeline,
    quit: async () => {},
    on: () => {},
    options: { lazyConnect: true, retryStrategy: () => null },
  };
  return mockRedis;
}

function createTier(overrides: Partial<Tier> = {}): Tier {
  return {
    id: 'free',
    name: 'Free',
    dailySearchCap: 100,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

test('getDailyCounterKey returns correct format', () => {
  const date = new Date('2026-11-07T12:00:00.000Z');
  const key = getDailyCounterKey('abc123', date);
  assert.equal(key, 'metering:daily:abc123:2026-11-07');
});

test('getMonthlyCounterKey returns correct format', () => {
  const date = new Date('2026-11-07T12:00:00.000Z');
  const key = getMonthlyCounterKey('abc123', date);
  assert.equal(key, 'metering:monthly:abc123:2026-11');
});

test('getEndOfDay returns end of day ISO string', () => {
  const date = new Date('2026-11-07T12:00:00.000Z');
  const end = getEndOfDay(date);
  assert.match(end, /^2026-11-07T23:59:59/);
});

test('getEndOfMonth returns end of month ISO string', () => {
  const date = new Date('2026-11-07T12:00:00.000Z');
  const end = getEndOfMonth(date);
  // Function returns UTC timestamp ending with Z
  assert.match(end, /^2026-11-30T/);
  assert.ok(end.endsWith('Z'));
});

test('getSecondsUntilReset returns positive seconds for daily cap', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const seconds = getSecondsUntilReset(tier, new Date('2026-11-07T12:00:00.000Z'));
  assert.ok(seconds > 0);
  assert.ok(seconds <= 24 * 60 * 60);
});

test('getSecondsUntilReset returns positive seconds for monthly cap', () => {
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: 1000 });
  const seconds = getSecondsUntilReset(tier, new Date('2026-11-07T12:00:00.000Z'));
  assert.ok(seconds > 0);
});

test('getSecondsUntilReset returns 1 second when both caps are null', () => {
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: null });
  const seconds = getSecondsUntilReset(tier);
  assert.equal(seconds, 1);
});

test('isTierCapExceeded returns not exceeded when under daily cap', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = isTierCapExceeded(99, 0, tier);
  assert.equal(result.exceeded, false);
  assert.equal(result.capType, null);
});

test('isTierCapExceeded returns exceeded when at daily cap (next request would exceed)', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = isTierCapExceeded(100, 0, tier);
  // At cap (100) means 100 requests made, next request would exceed
  assert.equal(result.exceeded, true);
  assert.equal(result.capType, 'daily');
  assert.ok(result.retryAfterSeconds > 0);
});

test('isTierCapExceeded returns exceeded when over daily cap (101)', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = isTierCapExceeded(101, 0, tier);
  assert.equal(result.exceeded, true);
  assert.equal(result.capType, 'daily');
  assert.ok(result.retryAfterSeconds > 0);
});

test('isTierCapExceeded returns exceeded when over daily cap', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = isTierCapExceeded(101, 0, tier);
  assert.equal(result.exceeded, true);
  assert.equal(result.capType, 'daily');
  assert.ok(result.retryAfterSeconds > 0);
});

test('isTierCapExceeded returns exceeded when over monthly cap', () => {
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: 1000 });
  const result = isTierCapExceeded(0, 1001, tier);
  assert.equal(result.exceeded, true);
  assert.equal(result.capType, 'monthly');
  assert.ok(result.retryAfterSeconds > 0);
});

test('isTierCapExceeded checks daily cap first when both exist', () => {
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: 1000 });
  const result = isTierCapExceeded(101, 500, tier);
  assert.equal(result.exceeded, true);
  assert.equal(result.capType, 'daily');
});

test('isCreditSufficient returns true when balance >= cost', () => {
  assert.equal(isCreditSufficient(5, 3), true);
  assert.equal(isCreditSufficient(3, 3), true);
});

test('isCreditSufficient returns false when balance < cost', () => {
  assert.equal(isCreditSufficient(2, 3), false);
  assert.equal(isCreditSufficient(0, 1), false);
});

test('incrementCounters increments daily counter when daily cap exists', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = await incrementCounters(redis, 'key1', tier);
  assert.equal(result.dailyCount, 1);
  assert.equal(result.monthlyCount, 0);
});

test('incrementCounters increments monthly counter when monthly cap exists', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: 1000 });
  const result = await incrementCounters(redis, 'key1', tier);
  assert.equal(result.dailyCount, 0);
  assert.equal(result.monthlyCount, 1);
});

test('incrementCounters increments both counters when both caps exist', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: 1000 });
  const result = await incrementCounters(redis, 'key1', tier);
  assert.equal(result.dailyCount, 1);
  assert.equal(result.monthlyCount, 1);
});

test('getCounters returns current counter values', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: 1000 });
  await incrementCounters(redis, 'key1', tier);
  await incrementCounters(redis, 'key1', tier);
  const result = await getCounters(redis, 'key1', tier);
  assert.equal(result.dailyCount, 2);
  assert.equal(result.monthlyCount, 2);
});

test('checkMetering allows request when under cap and sufficient credits', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 1 },
    10
  );
  assert.equal(result.allowed, true);
  assert.equal(result.creditsRemaining, 9);
  assert.equal(result.tierCapRemaining, 100);
  assert.ok(result.tierResetAt);
});

test('checkMetering denies when daily cap exceeded', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 10, monthlySearchCap: null });
  // Set counter to 10 (at cap)
  await incrementCounters(redis, 'key1', tier);
  for (let i = 0; i < 9; i++) {
    await incrementCounters(redis, 'key1', tier);
  }
  // Next request would be 11th, which exceeds the cap of 10
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 1 },
    10
  );
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'TIER_CAP_EXCEEDED');
  assert.equal(result.creditsRemaining, 10);
  assert.equal(result.tierCapRemaining, 0);
});

test('checkMetering denies when monthly cap exceeded', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: 10 });
  for (let i = 0; i < 10; i++) {
    await incrementCounters(redis, 'key1', tier);
  }
  // Next request would be 11th, which exceeds the cap of 10
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 1 },
    10
  );
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'TIER_CAP_EXCEEDED');
  assert.equal(result.tierCapRemaining, 0);
});

test('checkMetering denies when insufficient credits', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 5 },
    3
  );
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'INSUFFICIENT_CREDITS');
  assert.equal(result.creditsRemaining, 3);
});

test('checkMetering allows when credits exactly equal cost', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 100, monthlySearchCap: null });
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 5 },
    5
  );
  assert.equal(result.allowed, true);
  assert.equal(result.creditsRemaining, 0);
});

test('checkMetering tierCapRemaining is -1 when no caps', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: null, monthlySearchCap: null });
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 1 },
    10
  );
  assert.equal(result.allowed, true);
  assert.equal(result.tierCapRemaining, -1);
});

test('checkMetering uses daily cap for tierCapRemaining when both caps exist', async () => {
  const redis = createMockRedis();
  const tier = createTier({ dailySearchCap: 10, monthlySearchCap: 1000 });
  await incrementCounters(redis, 'key1', tier);
  const result = await checkMetering(
    { redis, tier, apiKeyId: 'key1', userId: 'user1', cost: 1 },
    10
  );
  assert.equal(result.tierCapRemaining, 9);
});