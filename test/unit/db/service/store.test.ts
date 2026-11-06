import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgServiceStore } from '../../../../src/db/service/store.ts';
import { HttpError } from '../../../../src/http/errors.ts';
import type { Logger } from '../../../../src/logger/types.ts';
import type { Pool } from 'pg';

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => createMockLogger(),
  };
}

interface MockUser {
  id: string;
  email: string;
  passwordHash: string;
  refreshTokenHash: string | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockApiKey {
  id: string;
  userId: string;
  keyId: string;
  keyType: 'live' | 'test';
  keyLast4: string;
  keyHash: string;
  isActive: boolean;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  allowedIps: string[] | null;
  allowedOrigins: string[] | null;
  restrictionMode: 'none' | 'ip' | 'origin' | 'both';
}

interface MockTier {
  id: string;
  name: string;
  dailySearchCap: number | null;
  monthlySearchCap: number | null;
  creditPerSearch: number;
  creditPerBatchQuery: number;
  createdAt: Date;
}

interface MockCreditBalance {
  userId: string;
  balance: number;
  updatedAt: Date;
}

interface MockCreditTransaction {
  id: string;
  userId: string;
  amount: number;
  reason: 'topup' | 'x402_topup' | 'api_call';
  referenceId: string | null;
  createdAt: Date;
}

function createMockPool() {
  const users = new Map<string, MockUser>();
  const apiKeys = new Map<string, MockApiKey>();
  const apiKeysByKeyId = new Map<string, MockApiKey>();
  const tiers = new Map<string, MockTier>();
  const creditBalances = new Map<string, MockCreditBalance>();
  const creditTransactions = new Map<string, MockCreditTransaction[]>();

  // Seed a tier
  tiers.set('free', {
    id: 'free',
    name: 'Free',
    dailySearchCap: 100,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date(),
  });

  let transactionIdCounter = 0;

  function toDbUser(user: MockUser) {
    return {
      id: user.id,
      email: user.email,
      password_hash: user.passwordHash,
      refresh_token_hash: user.refreshTokenHash,
      refresh_token_expires_at: user.refreshTokenExpiresAt,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    };
  }

  function toDbApiKey(key: MockApiKey) {
    return {
      id: key.id,
      user_id: key.userId,
      key_id: key.keyId,
      key_type: key.keyType,
      key_last4: key.keyLast4,
      key_hash: key.keyHash,
      is_active: key.isActive,
      revoked_at: key.revokedAt,
      expires_at: key.expiresAt,
      created_at: key.createdAt,
      allowed_ips: key.allowedIps,
      allowed_origins: key.allowedOrigins,
      restriction_mode: key.restrictionMode,
    };
  }

  function toDbTier(tier: MockTier) {
    return {
      id: tier.id,
      name: tier.name,
      daily_search_cap: tier.dailySearchCap,
      monthly_search_cap: tier.monthlySearchCap,
      credit_per_search: tier.creditPerSearch,
      credit_per_batch_query: tier.creditPerBatchQuery,
      created_at: tier.createdAt,
    };
  }

  function toDbCreditBalance(balance: MockCreditBalance) {
    return {
      user_id: balance.userId,
      balance: balance.balance,
      updated_at: balance.updatedAt,
    };
  }

  function toDbCreditTransaction(txn: MockCreditTransaction) {
    return {
      id: txn.id,
      user_id: txn.userId,
      amount: txn.amount,
      reason: txn.reason,
      reference_id: txn.referenceId,
      created_at: txn.createdAt,
    };
  }

  const mockClient = {
    users,
    apiKeys,
    apiKeysByKeyId,
    tiers,
    creditBalances,
    creditTransactions,
    inTransaction: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
query(sql: string, params?: any[]) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      // Handle transaction queries
      if (normalizedSql === 'begin isolation level repeatable read') {
        this.inTransaction = true;
        return Promise.resolve({ rows: [] });
      }
      if (normalizedSql === 'commit') {
        this.inTransaction = false;
        return Promise.resolve({ rows: [] });
      }
      if (normalizedSql === 'rollback') {
        this.inTransaction = false;
        return Promise.resolve({ rows: [] });
      }

      // INSERT user
      if (normalizedSql.includes('insert into users')) {
        const email = params?.[0];
        const passwordHash = params?.[1];
        const id = crypto.randomUUID();
        const now = new Date();
        const user: MockUser = {
          id,
          email,
          passwordHash,
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
          createdAt: now,
          updatedAt: now,
        };
        users.set(id, user);
        return { rows: [toDbUser(user)] };
      }

      // INSERT api_key
      if (normalizedSql.includes('insert into api_keys')) {
        const userId = params?.[0];
        const keyId = params?.[1];
        const keyType = params?.[2];
        const keyLast4 = params?.[3];
        const keyHash = params?.[4];
        const expiresAt = params?.[5];
        const id = crypto.randomUUID();
        const now = new Date();
        const apiKey: MockApiKey = {
          id,
          userId,
          keyId,
          keyType,
          keyLast4,
          keyHash,
          isActive: true,
          revokedAt: null,
          expiresAt,
          createdAt: now,
          allowedIps: null,
          allowedOrigins: null,
          restrictionMode: 'none',
        };
        apiKeys.set(id, apiKey);
        apiKeysByKeyId.set(keyId, apiKey);
        return { rows: [toDbApiKey(apiKey)] };
      }

      // UPDATE api_keys SET is_active = false, revoked_at = now()
      if (normalizedSql.includes('update api_keys set is_active = false') && normalizedSql.includes('revoked_at = now()')) {
        const keyId = params?.[0];
        const apiKey = apiKeysByKeyId.get(keyId);
        if (apiKey) {
          apiKey.isActive = false;
          apiKey.revokedAt = new Date();
        }
        return { rows: [] };
      }

      // UPDATE users SET refresh_token_hash
      if (normalizedSql.includes('update users set refresh_token_hash')) {
        const refreshTokenHash = params?.[0];
        const expiresAt = params?.[1];
        const userId = params?.[2];
        const user = users.get(userId);
        if (user) {
          user.refreshTokenHash = refreshTokenHash;
          user.refreshTokenExpiresAt = expiresAt;
          user.updatedAt = new Date();
        }
        return { rows: [] };
      }

      // INSERT credit_transactions
      if (normalizedSql.includes('insert into credit_transactions')) {
        const userId = params?.[0];
        const amount = params?.[1];
        const reason = params?.[2];
        const referenceId = params?.[3];
        transactionIdCounter++;
        const id = `txn-${transactionIdCounter}`;
        const now = new Date();
        const transaction: MockCreditTransaction = {
          id,
          userId,
          amount,
          reason,
          referenceId,
          createdAt: now,
        };
        const existing = creditTransactions.get(userId) ?? [];
        existing.unshift(transaction);
        creditTransactions.set(userId, existing);
        return { rows: [toDbCreditTransaction(transaction)] };
      }

      // INSERT/UPDATE credit_balances
      if (normalizedSql.includes('insert into credit_balances') || normalizedSql.includes('on conflict (user_id) do update')) {
        const userId = params?.[0];
        const amount = params?.[1];
        const existing = creditBalances.get(userId);
        const balance = (existing?.balance ?? 0) + amount;
        const now = new Date();
        creditBalances.set(userId, {
          userId,
          balance,
          updatedAt: now,
        });
        return { rows: [toDbCreditBalance({ userId, balance, updatedAt: now })] };
      }

      // SELECT queries for withSnapshot
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where email =')) {
        const email = params?.[0];
        for (const user of users.values()) {
          if (user.email === email) {
            return { rows: [toDbUser(user)] };
          }
        }
        return { rows: [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where id =')) {
        const id = params?.[0];
        const user = users.get(id);
        return { rows: user ? [toDbUser(user)] : [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where refresh_token_hash =')) {
        const hash = params?.[0];
        for (const user of users.values()) {
          if (user.refreshTokenHash === hash) {
            return { rows: [toDbUser(user)] };
          }
        }
        return { rows: [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from api_keys') && normalizedSql.includes('where key_id =')) {
        const keyId = params?.[0];
        const apiKey = apiKeysByKeyId.get(keyId);
        return { rows: apiKey ? [toDbApiKey(apiKey)] : [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from api_keys') && normalizedSql.includes('where user_id =')) {
        const userId = params?.[0];
        const results: MockApiKey[] = [];
        for (const key of apiKeys.values()) {
          if (key.userId === userId) {
            results.push(key);
          }
        }
        results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { rows: results.map(toDbApiKey) };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from tiers') && normalizedSql.includes('where id =')) {
        const id = params?.[0];
        const tier = tiers.get(id);
        return { rows: tier ? [toDbTier(tier)] : [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from credit_balances') && normalizedSql.includes('where user_id =')) {
        const userId = params?.[0];
        const balance = creditBalances.get(userId);
        return { rows: balance ? [toDbCreditBalance(balance)] : [] };
      }

      if (normalizedSql.includes('select') && normalizedSql.includes('from credit_transactions') && normalizedSql.includes('where user_id =')) {
        const userId = params?.[0];
        const limit = params?.[1] ?? 10;
        const transactions = creditTransactions.get(userId) ?? [];
        return { rows: transactions.slice(0, limit).map(toDbCreditTransaction) };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  return {
    connect: async () => mockClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
query: async (sql: string, params?: any[]) => mockClient.query(sql, params),
    end: async () => {},
    on: () => {},
  };
}

test('PgServiceStore.createUser creates user with password hash', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');

  assert.ok(user);
  assert.ok(user.id);
  assert.equal(user.email, 'test@example.com');
  assert.equal(user.passwordHash, 'hashed-password');
  assert.equal(user.refreshTokenHash, null);
});

test('PgServiceStore.createUser creates unique users', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user1 = await store.createUser('user1@example.com', 'hash1');
  const user2 = await store.createUser('user2@example.com', 'hash2');

  assert.notEqual(user1.id, user2.id);
});

test('PgServiceStore.withSnapshot provides reader access', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');

  const found = await store.withSnapshot(async (reader) => reader.findUserById(user.id));

  assert.ok(found);
  assert.equal(found?.id, user.id);
  assert.equal(found?.email, 'test@example.com');
});

test('PgServiceStore.createApiKey creates API key with all fields', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');
  const apiKey = await store.createApiKey(
    user.id,
    'testkey123',
    'live',
    'abcd',
    'keyhash',
    null
  );

  assert.ok(apiKey);
  assert.ok(apiKey.id);
  assert.equal(apiKey.userId, user.id);
  assert.equal(apiKey.keyId, 'testkey123');
  assert.equal(apiKey.keyType, 'live');
  assert.equal(apiKey.keyLast4, 'abcd');
  assert.equal(apiKey.keyHash, 'keyhash');
  assert.equal(apiKey.isActive, true);
  assert.equal(apiKey.revokedAt, null);
});

test('PgServiceStore.revokeApiKey marks key as revoked', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');
  const apiKey = await store.createApiKey(user.id, 'revoke-key', 'live', 'abcd', 'hash', null);

  assert.equal(apiKey.isActive, true);
  assert.equal(apiKey.revokedAt, null);

  await store.revokeApiKey('revoke-key');

  const revoked = await store.withSnapshot(async (reader) => reader.findApiKeyByKeyId('revoke-key'));
  assert.ok(revoked);
  assert.equal(revoked?.isActive, false);
  assert.ok(revoked?.revokedAt);
});

test('PgServiceStore.updateRefreshToken updates user refresh token', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');
  assert.equal(user.refreshTokenHash, null);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await store.updateRefreshToken(user.id, 'newhash', expiresAt);

  const updated = await store.withSnapshot(async (reader) => reader.findUserById(user.id));
  assert.ok(updated);
  assert.equal(updated?.refreshTokenHash, 'newhash');
  assert.ok(updated?.refreshTokenExpiresAt);
});

test('PgServiceStore.createCreditTransaction creates transaction record', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');
  const txn = await store.createCreditTransaction(user.id, 1000, 'topup', 'payment-123');

  assert.ok(txn);
  assert.ok(txn.id);
  assert.equal(txn.userId, user.id);
  assert.equal(txn.amount, 1000);
  assert.equal(txn.reason, 'topup');
  assert.equal(txn.referenceId, 'payment-123');
});

test('PgServiceStore.updateCreditBalance updates balance correctly', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');

  // Initial balance should be 0
  let balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance === null || balance?.balance === 0);

  // Add credits
  await store.createCreditTransaction(user.id, 1000, 'topup', 'payment-123');
  await store.updateCreditBalance(user.id, 1000);

  balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance);
  assert.equal(balance.balance, 1000);

  // Deduct credits
  await store.createCreditTransaction(user.id, -1, 'api_call', 'key-id');
  await store.updateCreditBalance(user.id, -1);

  balance = await store.withSnapshot(async (reader) => reader.findCreditBalanceByUserId(user.id));
  assert.ok(balance);
  assert.equal(balance.balance, 999);
});

test('PgServiceStore.findApiKeysByUserId returns keys ordered by created_at desc', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');

  await store.createApiKey(user.id, 'key1', 'live', 'aaaa', 'hash1', null);
  // Small delay to ensure different timestamps
  await new Promise(r => setTimeout(r, 10));
  await store.createApiKey(user.id, 'key2', 'test', 'bbbb', 'hash2', null);

  const keys = await store.withSnapshot(async (reader) => reader.findApiKeysByUserId(user.id));

  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.ok(keys[1]);
  assert.equal(keys[0]!.keyId, 'key2'); // newer first
  assert.equal(keys[1]!.keyId, 'key1');
});

test('PgServiceStore.withSnapshot propagates HttpError', async () => {
  const mockPool = createMockPool();
  const store = new PgServiceStore(mockPool as unknown as Pool, createMockLogger());

  const user = await store.createUser('test@example.com', 'hashed-password');

  try {
    await store.withSnapshot(async (reader) => {
      await reader.findUserById(user.id);
      throw new HttpError(400, 'TEST_ERROR', 'Intentional error');
    });
    assert.fail('Should have thrown');
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'TEST_ERROR');
    assert.equal(error.message, 'Intentional error');
    assert.equal(error.statusCode, 400);
  }

  // User should still exist (error propagated, transaction rolled back)
  const found = await store.withSnapshot(async (reader) => reader.findUserById(user.id));
  assert.ok(found);
  assert.ok(found!.id);
});