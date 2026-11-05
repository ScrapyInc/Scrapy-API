import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { buildApp } from '../../../src/app.ts';
import type { AppConfig } from '../../../src/config.ts';
import { createLoggerFactory } from '../../../src/logger/factory.ts';
import { createMemoryTransport } from '../../../src/logger/transports/memory.ts';
import { createPool, createServicePool } from '../../../src/db/pool.ts';
import { createRedisClient } from '../../../src/db/redis.ts';

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;

before(async () => {
  config = {
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
  } satisfies AppConfig;

  const catalogPool = createPool(config.databaseUrl, config.dbQueryTimeoutMs);
  const servicePool = createServicePool(config.serviceDatabaseUrl, config.dbQueryTimeoutMs);
  const redisClient = createRedisClient(config.redisUrl);

  app = buildApp({
    config,
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    servicePool,
    redis: redisClient,
  });

  // Create test user
  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'login-test@example.com', password: 'password123' },
  });
});

after(async () => {
  await app.close();
});

test('POST /v1/auth/login returns tokens for valid credentials', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'login-test@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.token);
  assert.ok(body.refreshToken);
  assert.ok(body.user);
  assert.equal(body.user.email, 'login-test@example.com');
  assert.equal(body.user.tier, 'free');
});

test('POST /v1/auth/login rejects invalid email', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'nonexistent@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
});

test('POST /v1/auth/login rejects wrong password', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'login-test@example.com', password: 'wrongpassword' },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_CREDENTIALS');
});

test('POST /v1/auth/login rejects missing credentials', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'login-test@example.com' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'MISSING_CREDENTIALS');
});