import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../../../src/app.ts';
import type { AppConfig } from '../../../src/config.ts';
import { createLoggerFactory } from '../../../src/logger/factory.ts';
import { createMemoryTransport } from '../../../src/logger/transports/memory.ts';

interface MockUser {
  id: string;
  email: string;
  passwordHash: string;
  refreshTokenHash: string | null;
  refreshTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function createMockServiceStore() {
  const users = new Map<string, MockUser>();
  const emailIndex = new Map<string, string>();

  const reader = {
    async findUserByEmail(email: string): Promise<MockUser | null> {
      const id = emailIndex.get(email);
      return id ? users.get(id) ?? null : null;
    },
    async findUserById(id: string): Promise<MockUser | null> {
      return users.get(id) ?? null;
    },
    async findUserByRefreshTokenHash(hash: string): Promise<MockUser | null> {
      for (const user of users.values()) {
        if (user.refreshTokenHash === hash) return user;
      }
      return null;
    },
    async findTierById(id: string) {
      if (id === 'free') {
        return { id: 'free', name: 'Free', dailySearchCap: 100, monthlySearchCap: null, creditPerSearch: 1, creditPerBatchQuery: 1, createdAt: new Date() };
      }
      return null;
    },
  };

  return {
    async withSnapshot<T>(fn: (reader: typeof reader) => Promise<T>): Promise<T> {
      return fn(reader);
    },
    async createUser(email: string, passwordHash: string): Promise<MockUser> {
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
      emailIndex.set(email, id);
      return user;
    },
    async updateRefreshToken(userId: string, refreshTokenHash: string, expiresAt: Date): Promise<void> {
      const user = users.get(userId);
      if (user) {
        user.refreshTokenHash = refreshTokenHash;
        user.refreshTokenExpiresAt = expiresAt;
        user.updatedAt = new Date();
      }
    },
  };
}

function createMockRedis() {
  return {
    ping: async () => 'PONG',
    quit: async () => {},
    on: () => {},
    options: { lazyConnect: true, retryStrategy: () => null },
  };
}

function createMockServicePool() {
  const users = new Map<string, MockUser>();
  const emailIndex = new Map<string, string>();
  let nextId = 1;

  const mockClient = {
    async query(sql: string, params?: any[]) {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      
      // Handle findUserByEmail
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where email =')) {
        const email = params?.[0];
        const id = emailIndex.get(email);
        const user = id ? users.get(id) : null;
        return { rows: user ? [{ 
          id: user.id, 
          email: user.email, 
          password_hash: user.passwordHash,
          refresh_token_hash: user.refreshTokenHash,
          refresh_token_expires_at: user.refreshTokenExpiresAt,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        }] : [] };
      }
      
      // Handle findUserById
      if (normalizedSql.includes('select') && normalizedSql.includes('from users') && normalizedSql.includes('where id =')) {
        const id = params?.[0];
        const user = users.get(id);
        return { rows: user ? [{ 
          id: user.id, 
          email: user.email, 
          password_hash: user.passwordHash,
          refresh_token_hash: user.refreshTokenHash,
          refresh_token_expires_at: user.refreshTokenExpiresAt,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        }] : [] };
      }

      // Handle findTierById
      if (normalizedSql.includes('from tiers') && normalizedSql.includes('where id =')) {
        return { rows: [{ id: 'free', name: 'Free', daily_search_cap: 100, monthly_search_cap: null, credit_per_search: 1, credit_per_batch_query: 1, created_at: new Date() }] };
      }

      // Handle INSERT user
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
        emailIndex.set(email, id);
        return { rows: [{ 
          id: user.id, 
          email: user.email, 
          password_hash: user.passwordHash,
          refresh_token_hash: user.refreshTokenHash,
          refresh_token_expires_at: user.refreshTokenExpiresAt,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        }] };
      }

      // Handle UPDATE refresh token
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

      return { rows: [] };
    },
    release: () => {},
  };

  return {
    async connect() {
      return mockClient;
    },
    async query(sql: string, params?: any[]) {
      return mockClient.query(sql, params);
    },
    async end() {},
    on: () => {},
  } as any;
}

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
  } satisfies AppConfig;
}

test('POST /v1/auth/signup creates user and returns tokens', async () => {
  const serviceStore = createMockServiceStore();
  const servicePool = createMockServicePool();
  const app = buildApp({
    config: testConfig(),
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    serviceStore,
    servicePool,
    redis: createMockRedis(),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'test@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(body.user);
  assert.ok(body.user.id);
  assert.equal(body.user.email, 'test@example.com');
  assert.equal(body.user.tier, 'free');
  assert.ok(body.token);
  assert.ok(body.refreshToken);
  assert.ok(typeof body.token === 'string');
  assert.ok(typeof body.refreshToken === 'string');
  
  await app.close();
});

test('POST /v1/auth/signup rejects invalid email', async () => {
  const serviceStore = createMockServiceStore();
  const servicePool = createMockServicePool();
  const app = buildApp({
    config: testConfig(),
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    serviceStore,
    servicePool,
    redis: createMockRedis(),
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
  const serviceStore = createMockServiceStore();
  const servicePool = createMockServicePool();
  const app = buildApp({
    config: testConfig(),
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    serviceStore,
    servicePool,
    redis: createMockRedis(),
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
  const serviceStore = createMockServiceStore();
  const servicePool = createMockServicePool();
  const app = buildApp({
    config: testConfig(),
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    serviceStore,
    servicePool,
    redis: createMockRedis(),
  });

  await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'duplicate@example.com', password: 'password123' },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'duplicate@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 409);
  const body = response.json();
  assert.equal(body.error.code, 'EMAIL_EXISTS');
  
  await app.close();
});

test('POST /v1/auth/signup does not return API key', async () => {
  const serviceStore = createMockServiceStore();
  const servicePool = createMockServicePool();
  const app = buildApp({
    config: testConfig(),
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    catalog: null,
    serviceStore,
    servicePool,
    redis: createMockRedis(),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email: 'no-key@example.com', password: 'password123' },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.ok(!body.apiKey);
  assert.ok(!body.plaintext);
  
  await app.close();
});