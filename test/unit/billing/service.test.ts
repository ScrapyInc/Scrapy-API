import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBillingService } from '../../../src/billing/service.ts';
import type {
  CreditMutationResult,
  CreditTransactionReason,
  ServiceReader,
  ServiceStore,
  Tier,
  User,
} from '../../../src/db/service/types.ts';
import { HttpError } from '../../../src/http/errors.ts';

const TIERS: Tier[] = [
  {
    id: 'free',
    name: 'Free',
    dailySearchCap: 100,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'paid_starter',
    name: 'Starter',
    dailySearchCap: 10000,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    id: 'paid_pro',
    name: 'Pro',
    dailySearchCap: null,
    monthlySearchCap: null,
    creditPerSearch: 1,
    creditPerBatchQuery: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const USER: User = {
  id: 'user-1',
  email: 'dev@example.com',
  passwordHash: 'hash',
  refreshTokenHash: null,
  refreshTokenExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

interface AppliedCall {
  userId: string;
  amount: number;
  reason: CreditTransactionReason;
  referenceId: string | null;
}

interface HarnessOptions {
  userExists?: boolean;
  initialBalance?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const applied: AppliedCall[] = [];
  const references = new Set<string>();
  const balances = new Map<string, number>();
  if (options.initialBalance !== undefined) {
    balances.set(USER.id, options.initialBalance);
  }

  const store = {
    withSnapshot: async <T>(fn: (reader: ServiceReader) => Promise<T>): Promise<T> => {
      const reader = {
        findAllTiers: async (): Promise<Tier[]> => TIERS,
        findUserById: async (id: string): Promise<User | null> =>
          options.userExists === false || id !== USER.id ? null : USER,
      } as unknown as ServiceReader;
      return fn(reader);
    },
    applyCreditTransaction: async (
      userId: string,
      amount: number,
      reason: CreditTransactionReason,
      referenceId: string | null
    ): Promise<CreditMutationResult> => {
      if (referenceId !== null) {
        const key = `${userId}:${reason}:${referenceId}`;
        if (references.has(key)) {
          throw new HttpError(409, 'DUPLICATE_TRANSACTION', 'This transaction was already applied');
        }
        references.add(key);
      }

      const previousBalance = balances.get(userId) ?? 0;
      const newBalance = previousBalance + amount;
      balances.set(userId, newBalance);
      applied.push({ userId, amount, reason, referenceId });

      return {
        transaction: {
          id: `txn-${applied.length}`,
          userId,
          amount,
          reason,
          referenceId,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        previousBalance,
        newBalance,
      };
    },
  } as unknown as ServiceStore;

  return { store, applied, balances };
}

function expectHttpError(statusCode: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  };
}

test('getTiers returns the database tier catalog with caps intact', async () => {
  const { store } = createHarness();
  const service = createBillingService(store);

  const tiers = await service.getTiers();

  assert.deepEqual(
    tiers.map((tier) => [tier.id, tier.dailySearchCap, tier.monthlySearchCap]),
    [
      ['free', 100, null],
      ['paid_starter', 10000, null],
      ['paid_pro', null, null],
    ]
  );
  assert.ok(tiers.every((tier) => tier.creditPerSearch === 1 && tier.creditPerBatchQuery === 1));
});

test('topUpCredits adds the pack credits to the current balance', async () => {
  const { store, balances } = createHarness({ initialBalance: 500 });
  const service = createBillingService(store);

  const result = await service.topUpCredits({ userId: USER.id, packId: 'pack_10usd' });

  assert.deepEqual(result, {
    developer_id: USER.id,
    previous_balance: 500,
    added_credits: 10000,
    new_balance: 10500,
    transaction_id: 'txn-1',
  });
  assert.equal(balances.get(USER.id), 10500);
});

test('topUpCredits writes a positive topup ledger entry tied to the pack', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await service.topUpCredits({ userId: USER.id, packId: 'pack_50usd' });

  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.userId, USER.id);
  assert.equal(applied[0]!.amount, 55000);
  assert.equal(applied[0]!.reason, 'topup');
  assert.ok(applied[0]!.referenceId?.startsWith('pack_50usd:'));
});

test('topUpCredits uses an explicit reference id for idempotency', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await service.topUpCredits({
    userId: USER.id,
    packId: 'pack_10usd',
    referenceId: 'invoice-42',
  });

  assert.equal(applied[0]!.referenceId, 'invoice-42');
});

test('topUpCredits accepts amount_usd and credits when they match the pack', async () => {
  const { store } = createHarness();
  const service = createBillingService(store);

  const result = await service.topUpCredits({
    userId: USER.id,
    packId: 'pack_100usd',
    amountUsd: 100,
    credits: 115000,
  });

  assert.equal(result.added_credits, 115000);
  assert.equal(result.new_balance, 115000);
});

test('topUpCredits rejects an unknown pack without touching the store', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await assert.rejects(
    () => service.topUpCredits({ userId: USER.id, packId: 'pack_999usd' }),
    expectHttpError(400, 'INVALID_PACK')
  );
  assert.equal(applied.length, 0);
});

test('topUpCredits rejects credits that do not match the pack', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await assert.rejects(
    () => service.topUpCredits({ userId: USER.id, packId: 'pack_10usd', credits: 99999 }),
    expectHttpError(400, 'INVALID_CREDITS')
  );
  assert.equal(applied.length, 0);
});

test('topUpCredits rejects zero or negative credits', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await assert.rejects(
    () => service.topUpCredits({ userId: USER.id, packId: 'pack_10usd', credits: 0 }),
    expectHttpError(400, 'INVALID_CREDITS')
  );
  await assert.rejects(
    () => service.topUpCredits({ userId: USER.id, packId: 'pack_10usd', credits: -100 }),
    expectHttpError(400, 'INVALID_CREDITS')
  );
  assert.equal(applied.length, 0);
});

test('topUpCredits rejects an amount_usd that does not match the pack', async () => {
  const { store, applied } = createHarness();
  const service = createBillingService(store);

  await assert.rejects(
    () => service.topUpCredits({ userId: USER.id, packId: 'pack_10usd', amountUsd: 9.99 }),
    expectHttpError(400, 'INVALID_AMOUNT')
  );
  assert.equal(applied.length, 0);
});

test('topUpCredits returns 404 and writes nothing for an unknown developer', async () => {
  const { store, applied } = createHarness({ userExists: false });
  const service = createBillingService(store);

  await assert.rejects(
    () => service.topUpCredits({ userId: 'missing-user', packId: 'pack_10usd' }),
    expectHttpError(404, 'NOT_FOUND')
  );
  assert.equal(applied.length, 0);
});

test('topUpCredits rejects a replayed reference id and credits the balance once', async () => {
  const { store, applied, balances } = createHarness();
  const service = createBillingService(store);
  const request = { userId: USER.id, packId: 'pack_10usd', referenceId: 'payment-1' };

  const first = await service.topUpCredits(request);
  await assert.rejects(
    () => service.topUpCredits(request),
    expectHttpError(409, 'DUPLICATE_TRANSACTION')
  );

  assert.equal(first.new_balance, 10000);
  assert.equal(balances.get(USER.id), 10000);
  assert.equal(applied.length, 1);
});

test('topUpCredits without a reference id generates a distinct reference per purchase', async () => {
  const { store, applied, balances } = createHarness();
  const service = createBillingService(store);

  await service.topUpCredits({ userId: USER.id, packId: 'pack_10usd' });
  await service.topUpCredits({ userId: USER.id, packId: 'pack_10usd' });

  assert.equal(applied.length, 2);
  assert.notEqual(applied[0]!.referenceId, applied[1]!.referenceId);
  assert.equal(balances.get(USER.id), 20000);
});
