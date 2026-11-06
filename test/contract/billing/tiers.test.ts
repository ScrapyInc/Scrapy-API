import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import {
  createTestApp,
  createTestConfig,
  createTestServicePool,
  loadEnvFile,
} from './helpers.ts';

let app: FastifyInstance;
let servicePool: pg.Pool;

before(() => {
  loadEnvFile();
  const config = createTestConfig();
  servicePool = createTestServicePool(config);
  app = createTestApp(servicePool, config);
});

after(async () => {
  await app.close();
  await servicePool.end();
});

test('GET /v1/billing/tiers is public and returns the full catalog', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/billing/tiers' });

  assert.equal(response.statusCode, 200);
  const body = response.json<{
    tiers: Array<{
      id: string;
      name: string;
      daily_search_cap: number | null;
      monthly_search_cap: number | null;
      credit_per_search: number;
      credit_per_batch_query: number;
    }>;
  }>();

  assert.ok(Array.isArray(body.tiers));
  assert.deepEqual(
    body.tiers.map((tier) => tier.id),
    ['free', 'paid_starter', 'paid_pro']
  );

  const byId = new Map(body.tiers.map((tier) => [tier.id, tier]));
  assert.deepEqual(byId.get('free'), {
    id: 'free',
    name: 'Free',
    daily_search_cap: 100,
    monthly_search_cap: null,
    credit_per_search: 1,
    credit_per_batch_query: 1,
  });
  assert.deepEqual(byId.get('paid_starter'), {
    id: 'paid_starter',
    name: 'Starter',
    daily_search_cap: 10000,
    monthly_search_cap: null,
    credit_per_search: 1,
    credit_per_batch_query: 1,
  });
  assert.deepEqual(byId.get('paid_pro'), {
    id: 'paid_pro',
    name: 'Pro',
    daily_search_cap: null,
    monthly_search_cap: null,
    credit_per_search: 1,
    credit_per_batch_query: 1,
  });
});
