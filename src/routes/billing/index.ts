import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import type { Logger } from '../../logger/types.ts';
import { registerTiers } from './tiers.ts';
import { registerTopUp } from './topup.ts';

export function registerBillingRoutes(
  app: FastifyInstance,
  servicePool: pg.Pool,
  logger: Logger
): void {
  registerTiers(app, servicePool, logger);
  registerTopUp(app, servicePool, logger);
}
