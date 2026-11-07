import { randomUUID } from 'node:crypto';

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type pg from 'pg';

import type { AppConfig } from './config.ts';
import type { CatalogStore } from './db/catalog.ts';
import type { ServiceStore } from './db/service/types.ts';
import type { RedisInstance } from './db/redis.ts';
import { BODY_LIMIT_BYTES, errorBody, HttpError, mapError } from './http/errors.ts';
import { createRateLimiter, type RateLimiter } from './http/rate-limit.ts';
import type { Logger } from './logger/types.ts';
import type { RefreshDeps } from './routes/refreshes.ts';
import { registerRefresh } from './routes/refreshes.ts';
import { registerReady } from './routes/health.ts';
import { registerSearch } from './routes/search.ts';
import { registerAuthRoutes } from './routes/auth/index.ts';
import { registerBillingRoutes } from './routes/billing/index.ts';
import { openApiDocument } from './openapi.ts';

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  readyCheck?: () => Promise<boolean>;
  catalog?: CatalogStore;
  serviceStore?: ServiceStore;
  servicePool?: pg.Pool;
  redis?: RedisInstance;
  refresh?: Omit<RefreshDeps, 'config' | 'logger' | 'rateLimit' | 'now'> & {
    rateLimit?: RateLimiter;
    now?: () => Date;
    dispatch?: RefreshDeps['dispatch'];
  };
  rateLimit?: RateLimiter;
  now?: () => Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    observation: {
      queryType: string | null;
      resultCount: number | null;
    };
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { logger } = options;
  const now = options.now ?? (() => new Date());
  const rateLimit = options.rateLimit ?? createRateLimiter({
    searchPerMinute: options.config.searchRateLimitPerMinute,
    refreshPerMinute: options.config.refreshRateLimitPerMinute,
    now: () => now().getTime(),
  });
  const observations = new WeakMap<
    object,
    { queryType: string | null; resultCount: number | null }
  >();
  const app = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: options.config.requestTimeoutMs,
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        allErrors: true,
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  app.decorateRequest('observation', {
    getter(this: object) {
      const current = observations.get(this);
      if (current) return current;
      const created = { queryType: null, resultCount: null };
      observations.set(this, created);
      return created;
    },
    setter(this: object, value: { queryType: string | null; resultCount: number | null }) {
      observations.set(this, value);
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info('request', {
      requestId: request.id,
      endpoint: `${request.method} ${request.routeOptions.url ?? request.url}`,
      durationMs: reply.elapsedTime,
      status: reply.statusCode,
      queryType: request.observation.queryType,
      resultCount: request.observation.resultCount,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const mapped = mapError(new HttpError(404, 'NOT_FOUND', 'Not found'));
    return reply.code(mapped.statusCode).send(errorBody(mapped, request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    const logged = error instanceof Error ? error : new Error('Unexpected failure');
    logger.error(logged, { requestId: request.id, status: mapped.statusCode, code: mapped.code });
    if (mapped.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(mapped.retryAfterSeconds));
    }
    return reply.code(mapped.statusCode).send(errorBody(mapped, request.id));
  });

  app.get('/openapi.json', async () => openApiDocument());

  registerReady(app, options.readyCheck ?? (async () => false));
  if (options.catalog) {
    registerSearch(app, options.catalog, logger, { rateLimit });
  }
  if (options.refresh) {
    registerRefresh(app, {
      config: options.config,
      store: options.refresh.store,
      logger,
      rateLimit: options.refresh.rateLimit ?? rateLimit,
      now,
      ...(options.refresh.dispatch ? { dispatch: options.refresh.dispatch } : {}),
    });
  }

  if (options.servicePool) {
    registerAuthRoutes(app, options.servicePool, logger);
    registerBillingRoutes(app, options.servicePool, logger);
  }

  app.get('/health/live', {
    schema: {
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: { status: { const: 'ok' } },
        },
      },
    },
  }, async () => ({ status: 'ok' as const }));

  return app;
}
