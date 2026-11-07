import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config.ts';
import { CHAIN_IDS, isChainId, type ChainId } from '../contracts/chains.ts';
import { HttpError } from '../http/errors.ts';
import type { RateLimiter } from '../http/rate-limit.ts';
import { rejectUnknownQueryKeys } from '../http/search-input.ts';
import type { Logger } from '../logger/types.ts';
import { dispatchConfigured, dispatchWorkflow, type DispatchOutcome } from '../refresh/dispatch.ts';
import type { RefreshStore } from '../refresh/store.ts';
import { createMeteringMiddleware, finalizeMetering, type MeteringDeps } from '../http/metering-middleware.ts';

export interface RefreshDeps {
  config: AppConfig;
  store: RefreshStore;
  logger: Logger;
  rateLimit: RateLimiter;
  now: () => Date;
  dispatch?: (runId: string) => Promise<DispatchOutcome>;
  metering?: MeteringDeps;
}

export function registerRefresh(app: FastifyInstance, deps: RefreshDeps): void {
  if (deps.metering) {
    const meteringMiddleware = createMeteringMiddleware(deps.metering);
    app.addHook('preHandler', meteringMiddleware);
    app.addHook('onResponse', async (request, reply) => {
      await finalizeMetering(deps.metering!, request, reply);
    });
  }

  app.post('/v1/refreshes', async (request, reply) => {
    const decision = deps.rateLimit.take('refresh');
    if (!decision.allowed) {
      throw new HttpError(429, 'RATE_LIMITED', 'Rate limit exceeded', undefined, decision.retryAfterSeconds);
    }
    const chains = parseChains(request.body);
    if (!dispatchConfigured(deps.config)) {
      throw new HttpError(503, 'DISPATCH_UNAVAILABLE', 'Refresh dispatch is not configured', undefined, 30);
    }
    const admitted = await deps.store.admit(chains);
    if ('conflicts' in admitted) {
      throw new HttpError(
        409,
        'REFRESH_CONFLICT',
        'Requested chains already have an active refresh',
        admitted.conflicts.map((conflict) => ({ path: conflict.chainId, runId: conflict.runId })),
      );
    }
    const dispatch = deps.dispatch ?? ((runId: string) => dispatchWorkflow(deps.config, runId));
    const outcome = await dispatch(admitted.runId);
    await deps.store.recordDispatch(admitted.runId, outcome);
    deps.logger.info('refresh', { requestId: request.id, runId: admitted.runId, dispatchState: outcome });
    if (outcome === 'rejected') {
      throw new HttpError(503, 'DISPATCH_UNAVAILABLE', 'Refresh dispatch was rejected', undefined, 30);
    }
    return reply.code(202).send({
      runId: admitted.runId,
      status: 'PENDING',
      statusUrl: `/v1/refreshes/${admitted.runId}`,
      dispatchState: outcome === 'acknowledged' ? 'ACKNOWLEDGED' : 'UNCERTAIN',
    });
  });

  app.get('/v1/refreshes/:runId', async (request) => {
    const params = request.params as { runId?: string };
    if (!params.runId || !/^[0-9a-f-]{36}$/i.test(params.runId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Run not found');
    }
    const run = await deps.store.getRun(params.runId, deps.now(), deps.config.staleAfterHours);
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
    return run;
  });

  app.get('/v1/chains', async (request) => {
    rejectUnknownQueryKeys(request.query as Record<string, unknown>, []);
    return { chains: await deps.store.listChains(deps.now(), deps.config.staleAfterHours) };
  });
}

function parseChains(body: unknown): ChainId[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', [{ path: '' }]);
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => key !== 'chains');
  if (extra) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', [{ path: extra }]);
  if (record.chains === undefined) {
    return [...CHAIN_IDS].sort((left, right) => left.localeCompare(right));
  }
  if (!Array.isArray(record.chains) || record.chains.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'chains must be a non-empty list of chain ids', [{ path: 'chains' }]);
  }
  const selected: ChainId[] = [];
  for (const [index, value] of record.chains.entries()) {
    if (typeof value !== 'string' || !isChainId(value)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'unknown chain id', [{ path: `chains.${index}` }]);
    }
    if (!selected.includes(value)) selected.push(value);
  }
  return selected.sort((left, right) => left.localeCompare(right));
}
