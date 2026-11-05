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
let refreshToken: string;

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

  // Create test user and login
  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'refresh-test@example.com', password: 'password123' },
  });

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'refresh-test@example.com', password: 'password123' },
  });
  refreshToken = loginResponse.json().refreshToken;
});

after(async () => {
  await app.close();
});

test('POST /v1/auth/refresh returns new tokens for valid refresh token', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: refreshToken },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.token);
  assert.ok(body.refreshToken);
  assert.ok(body.user);
  assert.equal(body.user.email, 'refresh-test@example.com');
  assert.notEqual(body.refreshToken, refreshToken);
});

test('POST /v1/auth/refresh rejects invalid refresh token', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: 'invalid-token' },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_REFRESH_TOKEN');
});

test('POST /v1/auth/refresh rejects missing refresh token', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {},
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'MISSING_REFRESH_TOKEN');
});

test('POST /v1/auth/refresh rotates refresh token (old one invalidated)', async () => {
  // First refresh
  const firstRefresh = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: refreshToken },
  });
  const newRefreshToken = firstRefresh.json().refreshToken;

  // Try to use old refresh token again
  const secondRefresh = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: refreshToken },
  });

  assert.equal(secondRefresh.statusCode, 401);

  // New refresh token should still work
  const thirdRefresh = await app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refresh_token: newRefreshToken },
  });
  assert.equal(thirdRefresh.statusCode, 200);
});