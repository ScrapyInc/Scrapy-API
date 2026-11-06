import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgReader } from '../../../../src/db/service/reader.ts';

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

function createMockClient() {
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

  return {
    users,
    apiKeys,
    apiKeysByKeyId,
    tiers,
    creditBalances,
    creditTransactions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
query(sql: string, params?: any[]) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      // SELECT users by email
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where email =')) {
        const email = params?.[0];
        for (const user of users.values()) {
          if (user.email === email) {
            return { rows: [toDbUser(user)] };
          }
        }
        return { rows: [] };
      }

      // SELECT users by id
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where id =')) {
        const id = params?.[0];
        const user = users.get(id);
        return { rows: user ? [toDbUser(user)] : [] };
      }

      // SELECT users by refresh_token_hash
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where refresh_token_hash =')) {
        const hash = params?.[0];
        for (const user of users.values()) {
          if (user.refreshTokenHash === hash) {
            return { rows: [toDbUser(user)] };
          }
        }
        return { rows: [] };
      }

      // SELECT api_keys by key_id
      if (normalizedSql.includes('select') && normalizedSql.includes('from api_keys') && normalizedSql.includes('where key_id =')) {
        const keyId = params?.[0];
        const key = apiKeysByKeyId.get(keyId);
        return { rows: key ? [toDbApiKey(key)] : [] };
      }

      // SELECT api_keys by user_id
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

      // SELECT tiers by id
      if (normalizedSql.includes('select') && normalizedSql.includes('from tiers') && normalizedSql.includes('where id =')) {
        const id = params?.[0];
        const tier = tiers.get(id);
        return { rows: tier ? [toDbTier(tier)] : [] };
      }

      // SELECT credit_balances by user_id
      if (normalizedSql.includes('select') && normalizedSql.includes('from credit_balances') && normalizedSql.includes('where user_id =')) {
        const userId = params?.[0];
        const balance = creditBalances.get(userId);
        return { rows: balance ? [toDbCreditBalance(balance)] : [] };
      }

      // SELECT credit_transactions by user_id with limit
      if (normalizedSql.includes('select') && normalizedSql.includes('from credit_transactions') && normalizedSql.includes('where user_id =')) {
        const userId = params?.[0];
        const limit = params?.[1] ?? 10;
        const transactions = creditTransactions.get(userId) ?? [];
        // Sort by created_at DESC (newest first)
        const sorted = [...transactions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { rows: sorted.slice(0, limit).map(toDbCreditTransaction) };
      }

      return { rows: [] };
    },
    release: () => {},
  };
}

test('PgReader.findUserByEmail finds user by email', async () => {
  const mockClient = createMockClient();
  const userId = 'test-user-id';
  mockClient.users.set(userId, {
    id: userId,
    email: 'test@example.com',
    passwordHash: 'hashed',
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const user = await reader.findUserByEmail('test@example.com');

  assert.ok(user);
  assert.equal(user?.id, userId);
  assert.equal(user?.email, 'test@example.com');
  assert.ok(user?.passwordHash);
  assert.equal(user?.refreshTokenHash, null);
});

test('PgReader.findUserByEmail returns null for non-existent email', async () => {
  const mockClient = createMockClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const user = await reader.findUserByEmail('nonexistent@example.com');
  assert.equal(user, null);
});

test('PgReader.findUserById finds user by id', async () => {
  const mockClient = createMockClient();
  const userId = 'test-user-id';
  mockClient.users.set(userId, {
    id: userId,
    email: 'test@example.com',
    passwordHash: 'hashed',
    refreshTokenHash: null,
    refreshTokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const user = await reader.findUserById(userId);

  assert.ok(user);
  assert.equal(user?.id, userId);
  assert.equal(user?.email, 'test@example.com');
});

test('PgReader.findUserByRefreshTokenHash finds user by refresh token hash', async () => {
  const mockClient = createMockClient();
  const userId = 'test-user-id';
  const refreshTokenHash = 'abc123hash';
  mockClient.users.set(userId, {
    id: userId,
    email: 'test@example.com',
    passwordHash: 'hashed',
    refreshTokenHash,
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const user = await reader.findUserByRefreshTokenHash(refreshTokenHash);

  assert.ok(user);
  assert.equal(user?.id, userId);
  assert.equal(user?.refreshTokenHash, refreshTokenHash);
});

test('PgReader.findApiKeyByKeyId finds api key by key_id', async () => {
  const mockClient = createMockClient();
  const keyId = 'test-key-id';
  const apiKey: MockApiKey = {
    id: 'api-key-id',
    userId: 'user-id',
    keyId,
    keyType: 'live',
    keyLast4: 'abcd',
    keyHash: 'keyhash',
    isActive: true,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    allowedIps: null,
    allowedOrigins: null,
    restrictionMode: 'none',
  };
  mockClient.apiKeys.set(apiKey.id, apiKey);
  mockClient.apiKeysByKeyId.set(keyId, apiKey);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const key = await reader.findApiKeyByKeyId(keyId);

  assert.ok(key);
  assert.equal(key?.keyId, keyId);
  assert.equal(key?.keyType, 'live');
  assert.equal(key?.keyLast4, 'abcd');
});

test('PgReader.findApiKeysByUserId returns user keys ordered by created_at desc', async () => {
  const mockClient = createMockClient();
  const userId = 'user-id';
  const key1: MockApiKey = {
    id: 'key-1',
    userId,
    keyId: 'key1',
    keyType: 'live',
    keyLast4: 'aaaa',
    keyHash: 'hash1',
    isActive: true,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(Date.now() - 1000),
    allowedIps: null,
    allowedOrigins: null,
    restrictionMode: 'none',
  };
  const key2: MockApiKey = {
    id: 'key-2',
    userId,
    keyId: 'key2',
    keyType: 'test',
    keyLast4: 'bbbb',
    keyHash: 'hash2',
    isActive: true,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    allowedIps: null,
    allowedOrigins: null,
    restrictionMode: 'none',
  };
  mockClient.apiKeys.set(key1.id, key1);
  mockClient.apiKeys.set(key2.id, key2);
  mockClient.apiKeysByKeyId.set(key1.keyId, key1);
  mockClient.apiKeysByKeyId.set(key2.keyId, key2);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const keys = await reader.findApiKeysByUserId(userId);

  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.ok(keys[1]);
  assert.equal(keys[0]!.keyId, 'key2'); // newer first
  assert.equal(keys[1]!.keyId, 'key1');
});

test('PgReader.findTierById finds tier by id', async () => {
  const mockClient = createMockClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const tier = await reader.findTierById('free');

  assert.ok(tier);
  assert.equal(tier?.id, 'free');
  assert.equal(tier?.name, 'Free');
  assert.equal(tier?.dailySearchCap, 100);
});

test('PgReader.findCreditBalanceByUserId returns balance', async () => {
  const mockClient = createMockClient();
  const userId = 'user-id';
  mockClient.creditBalances.set(userId, {
    userId,
    balance: 1000,
    updatedAt: new Date(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const balance = await reader.findCreditBalanceByUserId(userId);

  assert.ok(balance);
  assert.equal(balance?.balance, 1000);
});

test('PgReader.findCreditTransactionsByUserId returns transactions', async () => {
  const mockClient = createMockClient();
  const userId = 'user-id';
  const now = new Date();
  mockClient.creditTransactions.set(userId, [
    {
      id: 'txn-1',
      userId,
      amount: -1,
      reason: 'api_call',
      referenceId: 'key-id',
      createdAt: new Date(now.getTime() - 1000),
    },
    {
      id: 'txn-2',
      userId,
      amount: 1000,
      reason: 'topup',
      referenceId: 'payment-123',
      createdAt: now,
    },
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
const reader = new PgReader(mockClient as any);
  const transactions = await reader.findCreditTransactionsByUserId(userId, 10);

  assert.equal(transactions.length, 2);
  assert.ok(transactions[0]);
  assert.ok(transactions[1]);
  assert.equal(transactions[0]!.amount, 1000); // ordered desc by created_at
  assert.equal(transactions[1]!.amount, -1);
});