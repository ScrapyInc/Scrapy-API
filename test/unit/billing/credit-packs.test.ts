import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CREDIT_PACKS, getCreditPack, listCreditPacks } from '../../../src/billing/credit-packs.ts';

test('the catalog exposes the three Stage 2 packs in order', () => {
  assert.deepEqual(
    CREDIT_PACKS.map((pack) => [pack.id, pack.amountUsd, pack.credits]),
    [
      ['pack_10usd', 10, 10000],
      ['pack_50usd', 50, 55000],
      ['pack_100usd', 100, 115000],
    ]
  );
});

test('getCreditPack returns the matching pack', () => {
  assert.deepEqual(getCreditPack('pack_10usd'), {
    id: 'pack_10usd',
    amountUsd: 10,
    credits: 10000,
  });
  assert.deepEqual(getCreditPack('pack_50usd'), {
    id: 'pack_50usd',
    amountUsd: 50,
    credits: 55000,
  });
  assert.deepEqual(getCreditPack('pack_100usd'), {
    id: 'pack_100usd',
    amountUsd: 100,
    credits: 115000,
  });
});

test('getCreditPack returns null for an unknown pack id', () => {
  assert.equal(getCreditPack('pack_999usd'), null);
  assert.equal(getCreditPack(''), null);
});

test('listCreditPacks returns a copy so callers cannot mutate the catalog', () => {
  const packs = listCreditPacks();

  assert.equal(packs.length, 3);
  packs.pop();

  assert.equal(listCreditPacks().length, 3);
  assert.equal(getCreditPack('pack_100usd')?.credits, 115000);
});
