import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../../src/app.ts';
import { CHAIN_IDS } from '../../src/contracts/chains.ts';
import type { AppConfig } from '../../src/config.ts';
import { createRateLimiter } from '../../src/http/rate-limit.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';
import type { DispatchOutcome } from '../../src/refresh/dispatch.ts';
import type { RefreshStore } from '../../src/refresh/store.ts';

function config(github = false): AppConfig {
  return {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'error',
    logEnv: 'test',
    appVersion: 'test',
    staleAfterHours: 48,
    databaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test',
    serviceDatabaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test_service',
    redisUrl: 'redis://localhost:6379',
    apiKeyPepper: 'test-pepper-32-characters-minimum-length',
    githubRepository: github ? 'osherz80/Scrapy-API' : '',
    githubWorkflowId: github ? 'refresh.yml' : '',
    githubRef: github ? 'refs/heads/main' : '',
    githubToken: github ? 't'.repeat(24) : '',
    dbQueryTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    searchRateLimitPerMinute: 60,
    refreshRateLimitPerMinute: 5,
    dbConcurrency: 2,
  };
}

function store(overrides: Partial<RefreshStore> = {}): RefreshStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async admit(chains) {
      calls.push(`admit:${chains.join(',')}`);
      return { runId: '00000000-0000-4000-8000-000000000001' };
    },
    async recordDispatch(_runId, outcome) {
      calls.push(`dispatch:${outcome}`);
    },
    async getRun() {
      return null;
    },
    async listChains() {
      return [];
    },
    ...overrides,
  };
}

function appFor(refreshStore: RefreshStore, github = true, dispatch?: (runId: string) => Promise<DispatchOutcome>) {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();
  return buildApp({
    config: config(github),
    logger,
    refresh: { store: refreshStore, ...(dispatch ? { dispatch } : {}) },
  });
}

test('refresh rejects a bad chain list and does not admit when dispatch is not configured', async () => {
  const refreshStore = store();
  const app = appFor(refreshStore, false);
  const unknown = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: { chains: [] } });
  assert.equal(unknown.statusCode, 400);
  const unconfigured = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: {} });
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.json<{ error: { code: string } }>().error.code, 'DISPATCH_UNAVAILABLE');
  assert.deepEqual(refreshStore.calls, []);
  await app.close();
});

test('refresh returns 202, 409, or 503 from admission and dispatch without calling GitHub', async () => {
  const accepted = store();
  const app = appFor(accepted, true, async () => 'acknowledged');
  const created = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: { chains: ['victory', 'victory'] } });
  assert.equal(created.statusCode, 202);
  const createdBody = created.json<{ status: string; dispatchState: string; statusUrl: string }>();
  assert.equal(createdBody.status, 'PENDING');
  assert.equal(createdBody.dispatchState, 'ACKNOWLEDGED');
  assert.equal(createdBody.statusUrl, '/v1/refreshes/00000000-0000-4000-8000-000000000001');
  assert.equal(accepted.calls[0], 'admit:victory');

  const uncertainApp = appFor(store(), true, async () => 'uncertain');
  const uncertain = await uncertainApp.inject({ method: 'POST', url: '/v1/refreshes', payload: { chains: ['yochananof'] } });
  assert.equal(uncertain.statusCode, 202);
  assert.equal(uncertain.json<{ dispatchState: string }>().dispatchState, 'UNCERTAIN');

  const everyone = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: {} });
  assert.equal(everyone.statusCode, 202);
  const expected = [...CHAIN_IDS].sort((left, right) => left.localeCompare(right)).join(',');
  assert.equal(accepted.calls.at(-2), `admit:${expected}`);

  const conflicted = store({
    async admit() {
      return { conflicts: [{ chainId: 'victory', runId: '00000000-0000-4000-8000-000000000009' }] };
    },
  });
  const conflictApp = appFor(conflicted, true, async () => 'acknowledged');
  const conflict = await conflictApp.inject({ method: 'POST', url: '/v1/refreshes', payload: {} });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json<{ error: { details: Array<{ runId?: string }> } }>().error.details[0]?.runId,
    '00000000-0000-4000-8000-000000000009');

  const rejected = store();
  const rejectApp = appFor(rejected, true, async () => 'rejected');
  const rejection = await rejectApp.inject({ method: 'POST', url: '/v1/refreshes', payload: { chains: ['rami-levy'] } });
  assert.equal(rejection.statusCode, 503);
  assert.equal(rejected.calls[1], 'dispatch:rejected');
  await app.close();
  await uncertainApp.close();
  await conflictApp.close();
  await rejectApp.close();
});

test('an unknown run is 404 and readiness fails closed', async () => {
  const app = appFor(store(), true, async () => 'uncertain');
  const missing = await app.inject({
    method: 'GET',
    url: '/v1/refreshes/00000000-0000-4000-8000-000000000099',
  });
  assert.equal(missing.statusCode, 404);
  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.headers['retry-after'], '5');
  const live = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  await app.close();
});

test('refresh trigger limit returns 429 before admission', async () => {
  const refreshStore = store();
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();
  const app = buildApp({
    config: config(false),
    logger,
    refresh: { store: refreshStore },
    rateLimit: createRateLimiter({ searchPerMinute: 60, refreshPerMinute: 1, now: () => 1_000 }),
  });
  const first = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: {} });
  const second = await app.inject({ method: 'POST', url: '/v1/refreshes', payload: {} });
  assert.equal(first.statusCode, 503);
  assert.equal(second.statusCode, 429);
  assert.equal(second.headers['retry-after'], '60');
  assert.deepEqual(refreshStore.calls, []);
  await app.close();
});
