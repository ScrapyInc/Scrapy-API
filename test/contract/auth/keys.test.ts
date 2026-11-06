import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { buildApp } from '../../../src/app.ts';
import type { AppConfig } from '../../../src/config.ts';
import { createLoggerFactory } from '../../../src/logger/factory.ts';
import { createMemoryTransport } from '../../../src/logger/transports/memory.ts';
import { createRedisClient, validateRedisConnection } from '../../../src/db/redis.ts';

// Load .env file
function loadEnvFile(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const envPath = join(__dirname, '..', '..', '..', '.env');
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
    console.log('Loaded .env file');
  } catch {
    console.log('No .env file found, using process.env');
  }
}

loadEnvFile();

let config: AppConfig;
let servicePool: pg.Pool;
let redisClient: ReturnType<typeof createRedisClient>;

before(async () => {
  config = {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'error',
    logEnv: 'test',
    appVersion: 'test',
    staleAfterHours: 48,
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://app@127.0.0.1:5432/supermarket_api_test',
    serviceDatabaseUrl: process.env.SERVICE_DATABASE_URL ?? 'postgresql://app@127.0.0.1:5432/supermarket_api_test_service',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    apiKeyPepper: process.env.API_KEY_PEPPER ?? 'test-pepper-32-characters-minimum-length',
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

  // Parse connection string manually to avoid pg parsing issues with query params
  const serviceUrl = new URL(config.serviceDatabaseUrl);
  console.log('Parsed URL:', {
    hostname: serviceUrl.hostname,
    port: serviceUrl.port,
    pathname: serviceUrl.pathname,
    username: serviceUrl.username,
    password: serviceUrl.password ? '***' : 'EMPTY',
    search: serviceUrl.search,
  });
  servicePool = new pg.Pool({
    host: serviceUrl.hostname,
    port: parseInt(serviceUrl.port || '5432'),
    database: serviceUrl.pathname.slice(1),
    user: serviceUrl.username,
    password: serviceUrl.password,
    max: 4,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.dbQueryTimeoutMs,
    ssl: { rejectUnauthorized: true },
  });
  redisClient = createRedisClient(config.redisUrl);

  // Debug: test raw connection
  console.log('Testing service database connection...');
  try {
    const client = await servicePool.connect();
    const result = await client.query('SELECT 1 as test');
    console.log('Connection test result:', result.rows);
    client.release();
  } catch (err) {
    console.error('Connection failed:', err);
    throw err;
  }

  // Validate connections
  const serviceOk = await validateDatabase(servicePool);
  if (!serviceOk) throw new Error('Service database unavailable');

  const redisOk = await validateRedisConnection(redisClient);
  if (!redisOk) throw new Error('Redis unavailable');

  console.log('Database connections verified');
});

after(async () => {
  await servicePool.end();
  await redisClient.quit();
});

async function validateDatabase(pool: pg.Pool): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

async function cleanupTestData(servicePool: pg.Pool): Promise<void> {
  const client = await servicePool.connect();
  try {
    await client.query(`DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%test%' OR email LIKE '%example%')`);
    await client.query(`DELETE FROM credit_transactions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%test%' OR email LIKE '%example%')`);
    await client.query(`DELETE FROM credit_balances WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%test%' OR email LIKE '%example%')`);
    await client.query(`DELETE FROM users WHERE email LIKE '%test%' OR email LIKE '%example%'`);
  } finally {
    client.release();
  }
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createTestUserAndLogin(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password },
  });
  
  const loginResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  
  return loginResponse.json().token;
}

test('POST /v1/auth/keys creates live API key', async () => {
  await cleanupTestData(servicePool);

  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-live-test@example.com', 'password123');

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
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

  await app.close();
});

test('POST /v1/auth/keys creates test API key', async () => {
  const app = buildApp({
    config,
    logger: createLoggerFactory({
      level: 'debug',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: undefined,
    servicePool,
    redis: redisClient,
  });

  const token = await createTestUserAndLogin(app, 'keys-test-test@example.com', 'password123');

  let response;
  let attempts = 5;
  while (attempts > 0) {
    response = await app.inject({
      method: 'POST',
      url: '/v1/auth/keys',
      headers: authHeaders(token),
      payload: { key_type: 'test' },
    });
    
    if (response.statusCode === 201) break;
    if (response.statusCode === 500) {
      console.log('Retrying test API key creation...', attempts - 1, 'attempts left');
      attempts--;
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    break;
  }
  
  console.log('Create test API key response:', response?.statusCode, response?.payload);
  
  assert.equal(response!.statusCode, 201);
  const body = response!.json();
  assert.equal(body.key_type, 'test');
  assert.ok(body.plaintext.startsWith('sk_test_'));

  await app.close();
});

test('POST /v1/auth/keys rejects invalid key_type', async () => {
  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-invalid-test@example.com', 'password123');

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
    payload: { key_type: 'invalid' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_KEY_TYPE');

  await app.close();
});

test('POST /v1/auth/keys requires authentication', async () => {
  const app = buildApp({
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

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    payload: { key_type: 'live' },
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test('GET /v1/auth/keys lists user keys', async () => {
  await cleanupTestData(servicePool);

  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-list-test@example.com', 'password123');

  // Create a key first
  await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
    payload: { key_type: 'live' },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
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

  await app.close();
});

test('GET /v1/auth/keys requires authentication', async () => {
  const app = buildApp({
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

  const response = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test('POST /v1/auth/keys/:id/revoke revokes key', async () => {
  await cleanupTestData(servicePool);

  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-revoke-test@example.com', 'password123');

  // Create a key
  const createResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
    payload: { key_type: 'live' },
  });
  const keyId = createResponse.json().id;

  // Revoke it
  const revokeResponse = await app.inject({
    method: 'POST',
    url: `/v1/auth/keys/${keyId}/revoke`,
    headers: authHeaders(token),
  });

  assert.equal(revokeResponse.statusCode, 204);

  // Verify it's revoked (not in list)
  const listResponse = await app.inject({
    method: 'GET',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
  });
  const revokedKey = listResponse.json().keys.find((k: { id: string }) => k.id === keyId);
  assert.ok(!revokedKey || revokedKey.is_active === false);

  await app.close();
});

test('POST /v1/auth/keys/:id/revoke requires authentication', async () => {
  const app = buildApp({
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

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/some-id/revoke',
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test('POST /v1/auth/keys/:id/revoke returns 404 for non-existent key', async () => {
  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-revoke-404-test@example.com', 'password123');

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/non-existent-id/revoke',
    headers: authHeaders(token),
  });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error.code, 'KEY_NOT_FOUND');

  await app.close();
});

test('POST /v1/auth/keys/:id/rotate rotates key', async () => {
  await cleanupTestData(servicePool);

  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-rotate-test@example.com', 'password123');

  // Create a key
  const createResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: authHeaders(token),
    payload: { key_type: 'live' },
  });
  const oldKeyId = createResponse.json().id;
  const oldPlaintext = createResponse.json().plaintext;

  // Rotate it
  const rotateResponse = await app.inject({
    method: 'POST',
    url: `/v1/auth/keys/${oldKeyId}/rotate`,
    headers: authHeaders(token),
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
    headers: authHeaders(token),
  });
  const oldKey = listResponse.json().keys.find((k: { id: string }) => k.id === oldKeyId);
  assert.ok(oldKey);
  assert.equal(oldKey.is_active, false);

  await app.close();
});

test('POST /v1/auth/keys/:id/rotate requires authentication', async () => {
  const app = buildApp({
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

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/some-id/rotate',
  });

  assert.equal(response.statusCode, 401);

  await app.close();
});

test('POST /v1/auth/keys/:id/rotate returns 404 for non-existent key', async () => {
  const app = buildApp({
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

  const token = await createTestUserAndLogin(app, 'keys-rotate-404-test@example.com', 'password123');

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys/non-existent-id/rotate',
    headers: authHeaders(token),
  });

  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.error.code, 'KEY_NOT_FOUND');

  await app.close();
});