import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { buildApp } from '../../../src/app.ts';
import type { AppConfig } from '../../../src/config.ts';
import { createLoggerFactory } from '../../../src/logger/factory.ts';
import { createMemoryTransport } from '../../../src/logger/transports/memory.ts';
import { createServicePool } from '../../../src/db/pool.ts';
import { createRedisClient } from '../../../src/db/redis.ts';

let app: Awaited<ReturnType<typeof buildApp>>;
let config: AppConfig;
let accessToken: string;

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
    catalog: undefined,
    servicePool,
    redis: redisClient,
  });

  // Create test user and login
  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'keys-test@example.com', password: 'password123' },
  });

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'keys-test@example.com', password: 'password123' },
  });
  accessToken = loginResponse.json().token;
});

after(async () => {
  await app.close();
});

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

test('POST /v1/auth/keys creates live API key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'live' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(body.id);
  assert.ok(body.key_id);
  assert.equal(body.key_type, 'live');
  assert.ok(body.key_last4);
  assert.equal(body.is_active, true);
  assert.ok(body.plaintext);
  assert.ok(body.plaintext.startsWith('sk_live_'));
  assert.ok(body.plaintext.includes(body.key_id));
});

test('POST /v1/auth/keys creates test API key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'test' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.key_type, 'test');
  assert.ok(body.plaintext.startsWith('sk_test_'));
});

test('POST /v1/auth/keys rejects invalid key_type', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'invalid' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_KEY_TYPE');
});

test('POST /v1/auth/keys requires authentication', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    payload: { key_type: 'live' },
  });

  assert.equal(response.statusCode, 401);
});

test('GET /v1/auth/keys lists user keys', async () => {
  // Create a key first
  await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'live' },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(body.keys);
  assert.ok(Array.isArray(body.keys));
  assert.ok(body.keys.length >= 1);
  assert.ok(body.total >= 1);
  assert.ok(body.limit);
  assert.ok(body.offset === 0);
  
  const key = body.keys[0];
  assert.ok(key.id);
  assert.ok(key.key_id);
  assert.ok(key.key_type);
  assert.ok(key.key_last4);
  assert.ok(typeof key.is_active === 'boolean');
  assert.ok(key.created_at);
  // No plaintext in list response
  assert.ok(!key.plaintext);
});

test('GET /v1/auth/keys requires authentication', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
  });

  assert.equal(response.statusCode, 401);
});

test('POST /v1/auth/keys/:id/revoke revokes key', async () => {
  // Create a key
  const createResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'live' },
  });
  const keyId = createResponse.json().id;

  // Revoke it
  const revokeResponse = await app.inject({
    method: 'POST',
    url: `/v1/auth/keys/${keyId}/revoke`,
    headers: authHeaders(accessToken),
  });

  assert.equal(revokeResponse.statusCode, 204);

  // Verify it's revoked (not in list)
  const listResponse = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
  });
  const revokedKey = listResponse.json().keys.find((k: { id: string }) => k.id === keyId);
  assert.ok(!revokedKey || revokedKey.is_active === false);
});

test('POST /v1/auth/keys/:id/revoke requires authentication', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/some-id/revoke',
  });

  assert.equal(response.statusCode, 401);
});

test('POST /v1/auth/keys/:id/revoke returns 404 for non-existent key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/non-existent-id/revoke',
    headers: authHeaders(accessToken),
  });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error.code, 'KEY_NOT_FOUND');
});

test('POST /v1/auth/keys/:id/rotate rotates key', async () => {
  // Create a key
  const createResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
    payload: { key_type: 'live' },
  });
  const oldKeyId = createResponse.json().id;
  const oldPlaintext = createResponse.json().plaintext;

  // Rotate it
  const rotateResponse = await app.inject({
    method: 'POST',
    url: `/v1/auth/keys/${oldKeyId}/rotate`,
    headers: authHeaders(accessToken),
  });

  assert.equal(rotateResponse.statusCode, 200);
  const body = rotateResponse.json();
  assert.ok(body.id);
  assert.ok(body.key_id);
  assert.equal(body.key_type, 'live');
  assert.ok(body.plaintext);
  assert.notEqual(body.plaintext, oldPlaintext);
  assert.ok(body.is_active);

  // Old key should be revoked
  const listResponse = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
    headers: authHeaders(accessToken),
  });
  const oldKey = listResponse.json().keys.find((k: { id: string }) => k.id === oldKeyId);
  assert.ok(oldKey);
  assert.equal(oldKey.is_active, false);
});

test('POST /v1/auth/keys/:id/rotate requires authentication', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/some-id/rotate',
  });

  assert.equal(response.statusCode, 401);
});

test('POST /v1/auth/keys/:id/rotate returns 404 for non-existent key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/non-existent-id/rotate',
    headers: authHeaders(accessToken),
  });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error.code, 'KEY_NOT_FOUND');
});