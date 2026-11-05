import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    githubRepository: '',
    githubWorkflowId: '',
    githubRef: '',
    githubToken: '',
    dbQueryTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    searchRateLimitPerMinute: 60,
    refreshRateLimitPerMinute: 5,
    dbConcurrency: 2,
    ...overrides,
  };
}

function createMockCatalogStore(healthy = true) {
  return {
    async withSnapshot<T>(fn: (reader: unknown) => Promise<T>): Promise<T> {
      if (!healthy) throw new Error('Database unavailable');
      return fn({});
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function createMockServiceStore(healthy = true) {
  return {
    async withSnapshot<T>(fn: (reader: unknown) => Promise<T>): Promise<T> {
      if (!healthy) throw new Error('Service database unavailable');
      return fn({});
    },
    async createUser() { throw new Error('Not implemented'); },
    async createApiKey() { throw new Error('Not implemented'); },
    async revokeApiKey() { throw new Error('Not implemented'); },
    async updateRefreshToken() { throw new Error('Not implemented'); },
    async createCreditTransaction() { throw new Error('Not implemented'); },
    async updateCreditBalance() { throw new Error('Not implemented'); },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function createMockRedis(healthy = true) {
  return {
    ping: async () => (healthy ? 'PONG' : { throw: new Error('Redis unavailable') }),
    quit: async () => {},
    on: () => {},
    options: { lazyConnect: true, retryStrategy: () => null },
  };
}

test('GET /health/ready returns 200 when all dependencies are healthy', async () => {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();

  const app = buildApp({
    config: testConfig(),
    logger,
    readyCheck: async () => true,
  });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  await app.close();
});

test('GET /health/ready returns 503 when readyCheck fails', async () => {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();

  const app = buildApp({
    config: testConfig(),
    logger,
    readyCheck: async () => false,
  });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  await app.close();
});

test('GET /health/ready returns 503 with Retry-After when catalog DB is unhealthy', async () => {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();

  const app = buildApp({
    config: testConfig(),
    logger,
    catalog: createMockCatalogStore(false),
    serviceStore: createMockServiceStore(true),
    redis: createMockRedis(true),
    readyCheck: async () => {
      try {
        await (app as unknown as { catalog: { withSnapshot: (fn: unknown) => Promise<unknown> } }).catalog.withSnapshot(async () => {});
      } catch {
        return false;
      }
      try {
        await (app as unknown as { serviceStore: { withSnapshot: (fn: unknown) => Promise<unknown> } }).serviceStore.withSnapshot(async () => {});
      } catch {
        return false;
      }
      const redis = (app as unknown as { redis: { ping: () => Promise<string> } }).redis;
      const ping = await redis.ping();
      if (ping !== 'PONG') return false;
      return true;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  await app.close();
});

test('GET /health/ready returns 503 with Retry-After when service DB is unhealthy', async () => {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();

  const app = buildApp({
    config: testConfig(),
    logger,
    catalog: createMockCatalogStore(true),
    serviceStore: createMockServiceStore(false),
    redis: createMockRedis(true),
    readyCheck: async () => {
      try {
        await (app as unknown as { catalog: { withSnapshot: (fn: unknown) => Promise<unknown> } }).catalog.withSnapshot(async () => {});
      } catch {
        return false;
      }
      try {
        await (app as unknown as { serviceStore: { withSnapshot: (fn: unknown) => Promise<unknown> } }).serviceStore.withSnapshot(async () => {});
      } catch {
        return false;
      }
      const redis = (app as unknown as { redis: { ping: () => Promise<string> } }).redis;
      const ping = await redis.ping();
      if (ping !== 'PONG') return false;
      return true;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  await app.close();
});

test('GET /health/ready returns 503 with Retry-After when Redis is unhealthy', async () => {
  const logger = createLoggerFactory({
    level: 'error',
    environment: 'test',
    version: 'test',
    transports: [createMemoryTransport()],
  }).create();

  const app = buildApp({
    config: testConfig(),
    logger,
    catalog: createMockCatalogStore(true),
    serviceStore: createMockServiceStore(true),
    redis: createMockRedis(false),
    readyCheck: async () => {
      try {
        await (app as unknown as { catalog: { withSnapshot: (fn: unknown) => Promise<unknown> } }).catalog.withSnapshot(async () => {});
      } catch {
        return false;
      }
      try {
        await (app as unknown as { serviceStore: { withSnapshot: (fn: unknown) => Promise<unknown> } }).serviceStore.withSnapshot(async () => {});
      } catch {
        return false;
      }
      const redis = (app as unknown as { redis: { ping: () => Promise<string> } }).redis;
      const ping = await redis.ping();
      if (ping !== 'PONG') return false;
      return true;
    },
  });

  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
  await app.close();
});