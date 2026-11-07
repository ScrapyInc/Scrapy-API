import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PgReader } from '../../../../src/db/service/reader.ts';
import type { Tier } from '../../../../src/db/service/types.ts';

interface BalanceRow {
  userId: string;
  balance: number;
  updatedAt: Date;
}

interface TransactionRow {
  id: string;
  userId: string;
  amount: number;
  reason: 'topup' | 'x402_topup' | 'api_call';
  referenceId: string | null;
  createdAt: Date;
}

function createMockClient() {
  const tiers = new Map<string, Tier>();
  const balances = new Map<string, BalanceRow>();
  const transactions = new Map<string, TransactionRow[]>();
  let transactionCounter = 0;

  tiers.set('free', {
    id: 'free',
    name: 'Free',
    dailySearchCap: 100,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date(),
  });
  tiers.set('paid_starter', {
    id: 'paid_starter',
    name: 'Starter',
    dailySearchCap: 10000,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date(),
  });
  tiers.set('paid_pro', {
    id: 'paid_pro',
    name: 'Pro',
    dailySearchCap: null,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date(),
  });

  function toDbTier(tier: Tier) {
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

  function toDbBalance(row: BalanceRow) {
    return { user_id: row.userId, balance: row.balance, updated_at: row.updatedAt };
  }

  function toDbTransaction(row: TransactionRow) {
    return {
      id: row.id,
      user_id: row.userId,
      amount: row.amount,
      reason: row.reason,
      reference_id: row.referenceId,
      created_at: row.createdAt,
    };
  }

  return {
    tiers,
    balances,
    transactions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query(sql: string, params?: any[]) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (normalized.includes('from tiers') && !normalized.includes('where id =')) {
        return { rows: [...tiers.values()].map(toDbTier) };
      }

      if (normalized.includes('from tiers') && normalized.includes('where id =')) {
        const tier = tiers.get(params?.[0]);
        return { rows: tier ? [toDbTier(tier)] : [] };
      }

      if (normalized.includes('from credit_balances') && normalized.includes('where user_id =')) {
        const balance = balances.get(params?.[0]);
        return { rows: balance ? [toDbBalance(balance)] : [] };
      }

      if (normalized.startsWith('insert into credit_balances')) {
        const userId = params?.[0];
        if (!balances.has(userId)) {
          balances.set(userId, { userId, balance: 0, updatedAt: new Date() });
        }
        return { rows: [toDbBalance(balances.get(userId)!)] };
      }

      if (normalized.startsWith('insert into credit_transactions')) {
        transactionCounter++;
        const row: TransactionRow = {
          id: `txn-${transactionCounter}`,
          userId: params?.[0],
          amount: params?.[1],
          reason: params?.[2],
          referenceId: params?.[3],
          createdAt: new Date(Date.now() + transactionCounter),
        };
        const existing = transactions.get(row.userId) ?? [];
        existing.push(row);
        transactions.set(row.userId, existing);
        return { rows: [toDbTransaction(row)] };
      }

      if (normalized.includes('from credit_transactions') && normalized.includes('where user_id =')) {
        const userId = params?.[0];
        const limit = params?.[1] ?? 10;
        const offset = params?.[2] ?? 0;
        const rows = [...(transactions.get(userId) ?? [])]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(offset, offset + limit);
        return { rows: rows.map(toDbTransaction) };
      }

      return { rows: [] };
    },
    release: () => {},
  };
}

test('PgReader.findAllTiers returns the seeded tier catalog in order', async () => {
  const client = createMockClient();
  const reader = new PgReader(client as never);

  const tiers = await reader.findAllTiers();

  assert.deepEqual(
    tiers.map((tier) => tier.id),
    ['free', 'paid_starter', 'paid_pro']
  );
  assert.equal(tiers[0]!.dailySearchCap, 100);
  assert.equal(tiers[1]!.dailySearchCap, 10000);
  assert.equal(tiers[2]!.dailySearchCap, null);
});

test('PgReader.getCreditBalance reads the current balance', async () => {
  const client = createMockClient();
  client.balances.set('user-1', { userId: 'user-1', balance: 500, updatedAt: new Date() });
  const reader = new PgReader(client as never);

  const balance = await reader.getCreditBalance('user-1');

  assert.equal(balance?.balance, 500);
  assert.equal(await reader.getCreditBalance('missing'), null);
});

test('PgReader.createCreditBalance creates a zero balance only once', async () => {
  const client = createMockClient();
  const reader = new PgReader(client as never);

  const created = await reader.createCreditBalance('user-1');
  const again = await reader.createCreditBalance('user-1');

  assert.equal(created.balance, 0);
  assert.equal(again.balance, 0);
  assert.equal(client.balances.size, 1);
});

test('PgReader.addCreditTransaction appends a ledger row', async () => {
  const client = createMockClient();
  const reader = new PgReader(client as never);

  const transaction = await reader.addCreditTransaction('user-1', 10000, 'topup', 'pack_10usd');

  assert.equal(transaction.userId, 'user-1');
  assert.equal(transaction.amount, 10000);
  assert.equal(transaction.reason, 'topup');
  assert.equal(transaction.referenceId, 'pack_10usd');
});

test('PgReader.findCreditTransactionsByUser applies limit and offset newest first', async () => {
  const client = createMockClient();
  const reader = new PgReader(client as never);

  await reader.addCreditTransaction('user-1', 100, 'topup', 'ref-1');
  await reader.addCreditTransaction('user-1', 200, 'topup', 'ref-2');
  await reader.addCreditTransaction('user-1', 300, 'topup', 'ref-3');

  const firstPage = await reader.findCreditTransactionsByUser('user-1', 2, 0);
  const secondPage = await reader.findCreditTransactionsByUser('user-1', 2, 2);

  assert.deepEqual(firstPage.map((row) => row.amount), [300, 200]);
  assert.deepEqual(secondPage.map((row) => row.amount), [100]);
});
