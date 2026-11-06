import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import pg from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createServicePool } from '../../src/db/pool.ts';
import { PgServiceStore } from '../../src/db/service/store.ts';
import { createRedisClient, validateRedisConnection } from '../../src/db/redis.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';
import { localTestDatabase, stopLocalTestDatabase } from './postgres-server.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let catalogUrl: string;
let serviceUrl: string;
let redisClient: ReturnType<typeof createRedisClient>;
let servicePool: pg.Pool;

const logger = createLoggerFactory({
  level: 'error',
  environment: 'test',
  version: 'test',
  transports: [createMemoryTransport()],
}).create();

before(async () => {
  catalogUrl = await localTestDatabase();
  serviceUrl = catalogUrl.replace('/supermarket_api_test', '/supermarket_api_test_service');

  // Create service database
  const adminPool = new pg.Pool({ connectionString: catalogUrl.replace('/supermarket_api_test', '/postgres'), max: 1 });
  try {
    await adminPool.query('CREATE DATABASE supermarket_api_test_service');
  } catch {
    // Database might already exist
  } finally {
    await adminPool.end();
  }

  // Apply schema to service database
  const schemaPool = new pg.Pool({ connectionString: serviceUrl, max: 1 });
  const schemaPath = path.join(__dirname, '..', '..', 'src', 'db', 'service', 'schema.sql');
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(schemaPath, 'utf-8');
  try {
    await schemaPool.query(schema);
  } finally {
    await schemaPool.end();
  }

  servicePool = createServicePool(serviceUrl, 15000);
  redisClient = createRedisClient('redis://localhost:6379');
});

after(async () => {
  await servicePool.end();
  await redisClient.quit();
  await stopLocalTestDatabase();
});

test('PgServiceStore creates and finds a user', async () => {
  const store = new PgServiceStore(servicePool, logger);
  const user = await store.createUser('test@example.com', 'hashed-password');
  assert.equal(user.email, 'test@example.com');
  assert.equal(user.passwordHash, 'hashed-password');
  assert.ok(user.id);
  assert.ok(user.createdAt);
  assert.ok(user.updatedAt);

  const found = await store.withSnapshot(async (reader) => reader.findUserByEmail('test@example.com'));
  assert.ok(found);
  assert.equal(found?.email, 'test@example.com');
});

test('PgServiceStore creates and finds an API key', async () => {
  const store = new PgServiceStore(servicePool, logger);
  const user = await store.createUser('api@example.com', 'hashed-password');
  const apiKey = await store.createApiKey(user.id, 'key123', 'live', 'abcd', 'hash123', null);
  assert.equal(apiKey.keyId, 'key123');
  assert.equal(apiKey.keyType, 'live');
  assert.equal(apiKey.keyLast4, 'abcd');
  assert.equal(apiKey.keyHash, 'hash123');
  assert.equal(apiKey.isActive, true);
  assert.ok(apiKey.createdAt);

  const found = await store.withSnapshot(async (reader) => reader.findApiKeyByKeyId('key123'));
  assert.ok(found);
  assert.equal(found?.keyId, 'key123');

  const userKeys = await store.withSnapshot(async (reader) => reader.findApiKeysByUserId(user.id));
  assert.equal(userKeys.length, 1);
  assert.equal(userKeys[0]!.keyId, 'key123');
});

test('PgServiceStore revokes an API key', async () => {
  const store = new PgServiceStore(servicePool, logger);
  const user = await store.createUser('revoke@example.com', 'hashed-password');
  await store.createApiKey(user.id, 'key456', 'test', 'efgh', 'hash456', null);

  await store.revokeApiKey('key456');

  const found = await store.withSnapshot(async (reader) => reader.findApiKeyByKeyId('key456'));
  assert.ok(found);
  assert.equal(found?.isActive, false);
  assert.ok(found?.revokedAt);
});

test('PgServiceStore manages credit transactions and balance', async () => {
  const store = new PgServiceStore(servicePool, logger);
  const user = await store.createUser('credit@example.com', 'hashed-password');

  // Initial balance should be 0
  let balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance === null || Number(balance?.balance ?? 0) === 0);

  // Add credits (top-up)
  await store.createCreditTransaction(user.id, 1000, 'topup', 'payment_123');
  await store.updateCreditBalance(user.id, 1000);

  balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance);
  assert.equal(Number(balance.balance), 1000);

  // Deduct credits (api call)
  await store.createCreditTransaction(user.id, -1, 'api_call', 'key123');
  await store.updateCreditBalance(user.id, -1);

  balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance);
  assert.equal(Number(balance.balance), 999);

  // Check transaction history
  const transactions = await store.withSnapshot(async (reader) => reader.findCreditTransactionsByUserId(user.id, 10));
  assert.equal(transactions.length, 2);
  assert.equal(Number(transactions[0]!.amount), -1);
  assert.equal(transactions[0]!.reason, 'api_call');
  assert.equal(Number(transactions[1]!.amount), 1000);
  assert.equal(transactions[1]!.reason, 'topup');
});

test('PgServiceStore finds tier by id', async () => {
  const store = new PgServiceStore(servicePool, logger);
  const tier = await store.withSnapshot(async (reader) => reader.findTierById('free'));
  assert.ok(tier);
  assert.equal(tier?.id, 'free');
  assert.equal(tier?.name, 'Free');
  assert.equal(tier?.dailySearchCap, 100);
  assert.equal(tier?.monthlySearchCap, null);
  assert.equal(tier?.creditPerSearch, 1);
  assert.equal(tier?.creditPerBatchQuery, 1);

  const proTier = await store.withSnapshot(async (reader) => reader.findTierById('paid_pro'));
  assert.ok(proTier);
  assert.equal(proTier?.dailySearchCap, null);
  assert.equal(proTier?.monthlySearchCap, null);
});

test('health check validates service database connection', async () => {
  const store = new PgServiceStore(servicePool, logger);
  await store.withSnapshot(async (reader) => {
    const user = await reader.findUserById('00000000-0000-0000-0000-000000000000');
    assert.equal(user, null);
  });
});

test('Redis connection validation works', async () => {
  // Test with a mock Redis client that simulates success
  const mockRedis = {
    ping: async () => 'PONG',
    quit: async () => {},
    on: () => {},
    options: { lazyConnect: true },
  } as unknown as ReturnType<typeof createRedisClient>;

  const result = await validateRedisConnection(mockRedis);
  assert.equal(result, true);
});

test('Redis connection validation fails for unavailable Redis', async () => {
  const mockRedis = {
    ping: async () => {
      throw new Error('Connection refused');
    },
    quit: async () => {},
    on: () => {},
    options: { lazyConnect: true },
  } as unknown as ReturnType<typeof createRedisClient>;

  const result = await validateRedisConnection(mockRedis);
  assert.equal(result, false);
});