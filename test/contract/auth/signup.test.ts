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

test('POST /v1/auth/signup creates user and returns tokens', async () => {
  await cleanupTestData(servicePool);

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

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'test-real-db@example.com', password: 'password123' },
  });

  console.log('Signup response:', response.statusCode, response.payload);
  
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(body.user);
  assert.ok(body.user.id);
  assert.equal(body.user.email, 'test-real-db@example.com');
  assert.equal(body.user.tier, 'free');
  assert.ok(body.token);
  assert.ok(body.refreshToken);
  assert.ok(typeof body.token === 'string');
  assert.ok(typeof body.refreshToken === 'string');

  await app.close();
});

test('POST /v1/auth/signup rejects invalid email', async () => {
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
    url: '/v1/auth/signup',
    payload: { email: 'invalid-email', password: 'password123' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'INVALID_EMAIL');

  await app.close();
});

test('POST /v1/auth/signup rejects weak password', async () => {
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
    url: '/v1/auth/signup',
    payload: { email: 'test@example.com', password: 'short' },
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.error.code, 'WEAK_PASSWORD');

  await app.close();
});

test('POST /v1/auth/signup rejects duplicate email', async () => {
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

  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'duplicate-real@example.com', password: 'password123' },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'duplicate-real@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.equal(body.error.code, 'EMAIL_EXISTS');

  await app.close();
});

test('POST /v1/auth/signup does not return API key', async () => {
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
    url: '/v1/auth/signup',
    payload: { email: 'no-key-real@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(!body.apiKey);
  assert.ok(!body.plaintext);

  await app.close();
});