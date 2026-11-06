import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import {
  cleanupBillingTestData,
  createDeveloper,
  createTestApp,
  createTestConfig,
  createTestServicePool,
  loadEnvFile,
  readBalance,
  readTransactions,
} from './helpers.ts';

const EMAIL_PREFIX = 'billing-test-';
let emailCounter = 0;

let app: FastifyInstance;
let servicePool: pg.Pool;

before(() => {
  loadEnvFile();
  const config = createTestConfig();
  servicePool = createTestServicePool(config);
  app = createTestApp(servicePool, config);
});

after(async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  await app.close();
  await servicePool.end();
});

function uniqueEmail(label: string): string {
  emailCounter += 1;
  return `${EMAIL_PREFIX}${label}-${process.pid}-${emailCounter}@example.com`;
}

async function topUp(apiKey: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/billing/credits/topup',
    headers: { authorization: `Bearer ${apiKey}` },
    payload,
  });
}

test('POST /v1/billing/credits/topup adds credits and records a ledger entry', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const developer = await createDeveloper(app, uniqueEmail('success'));

  const response = await topUp(developer.apiKey, { pack_id: 'pack_10usd' });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    developer_id: string;
    previous_balance: number;
    added_credits: number;
    new_balance: number;
    transaction_id: string;
  }>();
  assert.equal(body.developer_id, developer.userId);
  assert.equal(body.previous_balance, 0);
  assert.equal(body.added_credits, 10000);
  assert.equal(body.new_balance, 10000);
  assert.ok(body.transaction_id);
  assert.equal(body.new_balance, body.previous_balance + body.added_credits);

  assert.equal(await readBalance(servicePool, developer.userId), 10000);
  const transactions = await readTransactions(servicePool, developer.userId);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]!.amount, 10000);
  assert.equal(transactions[0]!.reason, 'topup');
  assert.ok(transactions[0]!.referenceId?.startsWith('pack_10usd:'));
});

test('POST /v1/billing/credits/topup requires an API key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/billing/credits/topup',
    payload: { pack_id: 'pack_10usd' },
  });

  assert.equal(response.statusCode, 401);
});

test('POST /v1/billing/credits/topup rejects an unknown pack without changing the balance', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const developer = await createDeveloper(app, uniqueEmail('bad-pack'));

  const response = await topUp(developer.apiKey, { pack_id: 'pack_999usd' });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'INVALID_PACK');
  assert.equal(await readBalance(servicePool, developer.userId), null);
  assert.deepEqual(await readTransactions(servicePool, developer.userId), []);
});

test('POST /v1/billing/credits/topup rejects credits that do not match the pack', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const developer = await createDeveloper(app, uniqueEmail('bad-credits'));

  const response = await topUp(developer.apiKey, { pack_id: 'pack_10usd', credits: 99 });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'INVALID_CREDITS');
  assert.equal(await readBalance(servicePool, developer.userId), null);
  assert.deepEqual(await readTransactions(servicePool, developer.userId), []);
});

test('POST /v1/billing/credits/topup credits only the API key owner', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const owner = await createDeveloper(app, uniqueEmail('owner'));
  const other = await createDeveloper(app, uniqueEmail('other'));

  const response = await topUp(owner.apiKey, { pack_id: 'pack_10usd' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ developer_id: string }>().developer_id, owner.userId);
  assert.equal(await readBalance(servicePool, owner.userId), 10000);
  assert.equal(await readBalance(servicePool, other.userId), null);
  assert.deepEqual(await readTransactions(servicePool, other.userId), []);
});

test('POST /v1/billing/credits/topup applies a replayed reference only once', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const developer = await createDeveloper(app, uniqueEmail('idempotent'));
  const payload = { pack_id: 'pack_10usd', reference_id: 'invoice-1001' };

  const first = await topUp(developer.apiKey, payload);
  const second = await topUp(developer.apiKey, payload);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(
    second.json<{ error: { code: string } }>().error.code,
    'DUPLICATE_TRANSACTION'
  );
  assert.equal(await readBalance(servicePool, developer.userId), 10000);
  assert.equal((await readTransactions(servicePool, developer.userId)).length, 1);
});

test('POST /v1/billing/credits/topup accumulates repeat purchases', async () => {
  await cleanupBillingTestData(servicePool, EMAIL_PREFIX);
  const developer = await createDeveloper(app, uniqueEmail('accumulate'));

  const first = await topUp(developer.apiKey, { pack_id: 'pack_10usd' });
  const second = await topUp(developer.apiKey, { pack_id: 'pack_50usd' });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json<{ previous_balance: number }>().previous_balance, 10000);
  assert.equal(second.json<{ new_balance: number }>().new_balance, 65000);
  assert.equal(await readBalance(servicePool, developer.userId), 65000);
  assert.equal((await readTransactions(servicePool, developer.userId)).length, 2);
});
