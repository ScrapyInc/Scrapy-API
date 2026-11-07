import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { createBillingService } from '../../billing/service.ts';
import { createServiceStore } from '../../db/service/index.ts';
import { createApiKeyMiddleware } from '../../http/api-key-middleware.ts';
import { HttpError } from '../../http/errors.ts';
import type { Logger } from '../../logger/types.ts';

interface TopUpBody {
  pack_id?: unknown;
  amount_usd?: unknown;
  credits?: unknown;
  reference_id?: unknown;
}

export function registerTopUp(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  const requireApiKey = createApiKeyMiddleware(servicePool, logger);

  app.post<{ Body: TopUpBody }>(
    '/v1/billing/credits/topup',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const user = request.apiKeyUser!;
      const body = request.body ?? {};

      if (typeof body.pack_id !== 'string' || body.pack_id.length === 0) {
        throw new HttpError(400, 'INVALID_PACK', 'pack_id is required');
      }
      if (body.amount_usd !== undefined && typeof body.amount_usd !== 'number') {
        throw new HttpError(400, 'INVALID_AMOUNT', 'amount_usd must be a number');
      }
      if (body.credits !== undefined && typeof body.credits !== 'number') {
        throw new HttpError(400, 'INVALID_CREDITS', 'credits must be a number');
      }
      if (
        body.reference_id !== undefined &&
        body.reference_id !== null &&
        typeof body.reference_id !== 'string'
      ) {
        throw new HttpError(400, 'INVALID_REFERENCE_ID', 'reference_id must be a string');
      }

      const service = createBillingService(createServiceStore(servicePool, logger));
      const result = await service.topUpCredits({
        userId: user.id,
        packId: body.pack_id,
        ...(body.amount_usd !== undefined ? { amountUsd: body.amount_usd } : {}),
        ...(body.credits !== undefined ? { credits: body.credits } : {}),
        ...(body.reference_id !== undefined
          ? { referenceId: body.reference_id as string | null }
          : {}),
      });

      return reply.send(result);
    }
  );
}
