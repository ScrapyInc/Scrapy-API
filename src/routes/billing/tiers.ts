import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { createBillingService } from '../../billing/service.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type { Tier } from '../../db/service/types.ts';
import type { Logger } from '../../logger/types.ts';

function toTierResponse(tier: Tier) {
  return {
    id: tier.id,
    name: tier.name,
    daily_search_cap: tier.dailySearchCap,
    monthly_search_cap: tier.monthlySearchCap,
    credit_per_search: tier.creditPerSearch,
    credit_per_batch_query: tier.creditPerBatchQuery,
  };
}

export function registerTiers(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.get('/v1/billing/tiers', async (_request, reply) => {
    const service = createBillingService(createServiceStore(servicePool, logger));
    const tiers = await service.getTiers();

    return reply.send({ tiers: tiers.map(toTierResponse) });
  });
}
