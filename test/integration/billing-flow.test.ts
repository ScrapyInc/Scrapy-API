import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import pg from 'pg';

import { buildApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import { createServicePool } from '../../src/db/pool.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';
import { localTestDatabase, stopLocalTestDatabase } from './postgres-server.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PASSWORD = 'password123';

let servicePool: pg.Pool;
let app: FastifyInstance;

before(async () => {
  process.env.JWT_SECRET ??= 'test-jwt-secret-32-characters-minimum';
  process.env.API_KEY_PEPPER ??= 'test-pepper-32-characters-minimum-length';

  const catalogUrl = await localTestDatabase();
  const serviceUrl = catalogUrl.replace(
    '/supermarket_api_test',
    '/supermarket_api_test_service'
  );

  const adminPool = new pg.Pool({
    connectionString: catalogUrl.replace('/supermarket_api_test', '/postgres'),
    max: 1,
  });
  try {
    await adminPool.query('CREATE DATABASE supermarket_api_test_service');
  } catch {
    // The database may already exist from an earlier run.
  } finally {
    await adminPool.end();
  }

  const schemaPool = new pg.Pool({ connectionString: serviceUrl, max: 1 });
  try {
    const schema = readFileSync(
      path.join(__dirname, '..', '..', 'src', 'db', 'service', 'schema.sql'),
      'utf-8'
    );
    await schemaPool.query(schema);
  } finally {
    await schemaPool.end();
  }

  servicePool = createServicePool(serviceUrl, 15_000);

  const config: AppConfig = {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'error',
    logEnv: 'test',
    appVersion: 'test',
    staleAfterHours: 48,
    databaseUrl: catalogUrl,
    serviceDatabaseUrl: serviceUrl,
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
  };

  app = buildApp({
    config,
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    servicePool,
  });
});

after(async () => {
  await app.close();
  await servicePool.end();
  await stopLocalTestDatabase();
});

test('signup → login → key → tiers → top-up updates the balance and ledger', async () => {
  const email = `billing-flow-${process.pid}@example.com`;

  const signup = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: PASSWORD },
  });
  assert.equal(signup.statusCode, 201);
  const userId = signup.json<{ user: { id: string } }>().user.id;

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const token = login.json<{ token: string }>().token;

  const keyResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { key_type: 'live' },
  });
  assert.equal(keyResponse.statusCode, 201);
  const apiKey = keyResponse.json<{ plaintext: string }>().plaintext;

  const tiers = await app.inject({ method: 'GET', url: '/v1/billing/tiers' });
  assert.equal(tiers.statusCode, 200);
  assert.equal(tiers.json<{ tiers: unknown[] }>().tiers.length, 3);

  const firstTopUp = await app.inject({
    method: 'POST',
    url: '/v1/billing/credits/topup',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { pack_id: 'pack_10usd' },
  });
  assert.equal(firstTopUp.statusCode, 200);
  const firstBody = firstTopUp.json<{
    developer_id: string;
    previous_balance: number;
    added_credits: number;
    new_balance: number;
    transaction_id: string;
  }>();
  assert.equal(firstBody.developer_id, userId);
  assert.equal(firstBody.previous_balance, 0);
  assert.equal(firstBody.added_credits, 10000);
  assert.equal(firstBody.new_balance, 10000);
  assert.ok(firstBody.transaction_id);

  let balance = await servicePool.query(
    'SELECT balance FROM credit_balances WHERE user_id = $1',
    [userId]
  );
  assert.equal(Number(balance.rows[0]!.balance), 10000);

  const secondTopUp = await app.inject({
    method: 'POST',
    url: '/v1/billing/credits/topup',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { pack_id: 'pack_50usd' },
  });
  assert.equal(secondTopUp.statusCode, 200);
  const secondBody = secondTopUp.json<{ previous_balance: number; new_balance: number }>();
  assert.equal(secondBody.previous_balance, 10000);
  assert.equal(secondBody.new_balance, 65000);

  balance = await servicePool.query(
    'SELECT balance FROM credit_balances WHERE user_id = $1',
    [userId]
  );
  assert.equal(Number(balance.rows[0]!.balance), 65000);

  const transactions = await servicePool.query(
    `SELECT amount, reason, reference_id FROM credit_transactions
     WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId]
  );
  assert.equal(transactions.rows.length, 2);
  assert.equal(Number(transactions.rows[0]!.amount), 10000);
  assert.equal(transactions.rows[0]!.reason, 'topup');
  assert.match(transactions.rows[0]!.reference_id, /^pack_10usd:/);
  assert.equal(Number(transactions.rows[1]!.amount), 55000);
  assert.equal(transactions.rows[1]!.reason, 'topup');
  assert.match(transactions.rows[1]!.reference_id, /^pack_50usd:/);

  // The balance can cover at least one search at the free tier's rate.
  assert.ok(Number(balance.rows[0]!.balance) >= 1);
});
