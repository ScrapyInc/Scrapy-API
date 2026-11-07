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

interface MockBalance {
  userId: string;
  balance: number;
  updatedAt: Date;
}

interface MockTransaction {
  id: string;
  userId: string;
  amount: number;
  reason: string;
  referenceId: string | null;
  createdAt: Date;
}

function createMockPool() {
  const balances = new Map<string, MockBalance>();
  const transactions: MockTransaction[] = [];
  let transactionCounter = 0;
  let snapshot: { balances: Map<string, MockBalance>; transactions: MockTransaction[] } | null = null;
  let failOnLedgerInsert = false;

  function cloneBalances() {
    return new Map([...balances.entries()].map(([key, value]) => [key, { ...value }]));
  }

  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: string, params?: any[]) {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

      if (normalized === 'begin') {
        snapshot = { balances: cloneBalances(), transactions: transactions.map((row) => ({ ...row })) };
        return { rows: [] };
      }
      if (normalized === 'commit') {
        snapshot = null;
        return { rows: [] };
      }
      if (normalized === 'rollback') {
        if (snapshot) {
          balances.clear();
          for (const [key, value] of snapshot.balances) balances.set(key, value);
          transactions.splice(0, transactions.length, ...snapshot.transactions);
        }
        snapshot = null;
        return { rows: [] };
      }

      if (normalized.startsWith('insert into credit_balances')) {
        const userId = params?.[0] as string;
        if (!balances.has(userId)) {
          balances.set(userId, { userId, balance: 0, updatedAt: new Date() });
        }
        return { rows: [] };
      }

      if (normalized.includes('from credit_balances') && normalized.includes('for update')) {
        const balance = balances.get(params?.[0] as string);
        return { rows: balance ? [{ balance: balance.balance }] : [] };
      }

      if (normalized.includes('from credit_transactions') && normalized.includes('reference_id =')) {
        const [userId, reason, referenceId] = params ?? [];
        const duplicate = transactions.find(
          (row) =>
            row.userId === userId && row.reason === reason && row.referenceId === referenceId
        );
        return { rows: duplicate ? [{ id: duplicate.id }] : [] };
      }

      if (normalized.startsWith('insert into credit_transactions')) {
        if (failOnLedgerInsert) throw new Error('ledger insert failed');
        transactionCounter++;
        const row: MockTransaction = {
          id: `txn-${transactionCounter}`,
          userId: params?.[0] as string,
          amount: params?.[1] as number,
          reason: params?.[2] as string,
          referenceId: params?.[3] as string | null,
          createdAt: new Date(),
        };
        transactions.push(row);
        return {
          rows: [
            {
              id: row.id,
              user_id: row.userId,
              amount: row.amount,
              reason: row.reason,
              reference_id: row.referenceId,
              created_at: row.createdAt,
            },
          ],
        };
      }

      if (normalized.startsWith('update credit_balances')) {
        const [userId, amount] = params ?? [];
        const balance = balances.get(userId as string);
        if (!balance) return { rows: [] };
        balance.balance += amount as number;
        balance.updatedAt = new Date();
        return {
          rows: [
            { user_id: balance.userId, balance: balance.balance, updated_at: balance.updatedAt },
          ],
        };
      }

      return { rows: [] };
    },
    release: () => {},
  };

  return {
    balances,
    transactions,
    setFailOnLedgerInsert(value: boolean) {
      failOnLedgerInsert = value;
    },
    connect: async () => client,
  };
}

test('applyCreditTransaction adds credits and writes one ledger row', async () => {
  const pool = createMockPool();
  const store = new PgServiceStore(pool as unknown as Pool, createMockLogger());

  const result = await store.applyCreditTransaction('user-1', 10000, 'topup', 'pack_10usd');

  assert.equal(result.previousBalance, 0);
  assert.equal(result.newBalance, 10000);
  assert.equal(result.transaction.amount, 10000);
  assert.equal(result.transaction.reason, 'topup');
  assert.equal(result.transaction.referenceId, 'pack_10usd');
  assert.equal(pool.transactions.length, 1);
  assert.equal(pool.balances.get('user-1')?.balance, 10000);
});

test('applyCreditTransaction accumulates repeated top-ups', async () => {
  const pool = createMockPool();
  const store = new PgServiceStore(pool as unknown as Pool, createMockLogger());

  await store.applyCreditTransaction('user-1', 10000, 'topup', 'ref-1');
  const second = await store.applyCreditTransaction('user-1', 5000, 'topup', 'ref-2');

  assert.equal(second.previousBalance, 10000);
  assert.equal(second.newBalance, 15000);
  assert.equal(pool.transactions.length, 2);
});

test('applyCreditTransaction rejects a replayed reference id', async () => {
  const pool = createMockPool();
  const store = new PgServiceStore(pool as unknown as Pool, createMockLogger());

  await store.applyCreditTransaction('user-1', 10000, 'topup', 'same-reference');

  await assert.rejects(
    () => store.applyCreditTransaction('user-1', 10000, 'topup', 'same-reference'),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'DUPLICATE_TRANSACTION');
      return true;
    }
  );

  assert.equal(pool.balances.get('user-1')?.balance, 10000);
  assert.equal(pool.transactions.length, 1);
});

test('applyCreditTransaction allows repeated top-ups without a reference id', async () => {
  const pool = createMockPool();
  const store = new PgServiceStore(pool as unknown as Pool, createMockLogger());

  await store.applyCreditTransaction('user-1', 10000, 'topup', null);
  const second = await store.applyCreditTransaction('user-1', 5000, 'topup', null);

  assert.equal(second.newBalance, 15000);
  assert.equal(pool.transactions.length, 2);
});

test('applyCreditTransaction rolls back the balance when the ledger insert fails', async () => {
  const pool = createMockPool();
  const store = new PgServiceStore(pool as unknown as Pool, createMockLogger());
  await store.applyCreditTransaction('user-1', 500, 'topup', 'seed');

  pool.setFailOnLedgerInsert(true);
  await assert.rejects(
    () => store.applyCreditTransaction('user-1', 10000, 'topup', 'failing'),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'UNAVAILABLE');
      return true;
    }
  );

  assert.equal(pool.balances.get('user-1')?.balance, 500);
  assert.equal(pool.transactions.length, 1);
});
