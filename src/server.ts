import { pathToFileURL } from 'node:url';

import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { PgCatalog } from './db/catalog.ts';
import { createPool, createServicePool } from './db/pool.ts';
import { createRedisClient, validateRedisConnection } from './db/redis.ts';
import { createLoggerFactory } from './logger/factory.ts';
import { createConsoleTransport } from './logger/transports/console.ts';
import { PgRefreshStore } from './refresh/store.ts';
import { PgServiceStore } from './db/service/store.ts';

export async function start(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const factory = createLoggerFactory({
    level: config.logLevel,
    environment: config.logEnv,
    version: config.appVersion,
    transports: [createConsoleTransport()],
  });
  const logger = factory.create();

  const catalogPool = createPool(config.databaseUrl, config.dbQueryTimeoutMs, config.databaseSslRootCert);
  const servicePool = createServicePool(config.serviceDatabaseUrl, config.dbQueryTimeoutMs);
  const redisClient = createRedisClient(config.redisUrl);

  await validateStartupDependencies(logger, catalogPool, servicePool, redisClient);

  const app = buildApp({
    config,
    logger,
    readyCheck: async () => {
      const catalogOk = await checkDatabase(catalogPool);
      if (!catalogOk) return false;

      const serviceOk = await checkDatabase(servicePool);
      if (!serviceOk) return false;

      const redisOk = await validateRedisConnection(redisClient);
      if (!redisOk) return false;

      return true;
    },
    catalog: new PgCatalog(catalogPool, logger),
    serviceStore: new PgServiceStore(servicePool, logger),
    servicePool,
    redis: redisClient,
    refresh: { store: new PgRefreshStore(catalogPool) },
  });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
    await catalogPool.end();
    await servicePool.end();
    await redisClient.quit();
    await factory.shutdown();
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  await app.listen({ port: config.port, host: config.host });
  logger.info('listening', { port: config.port });
}

import type { Pool, PoolClient } from 'pg';
import type { Logger } from './logger/types.ts';
import type { RedisInstance } from './db/redis.ts';

async function validateStartupDependencies(
  logger: Logger,
  catalogPool: Pool,
  servicePool: Pool,
  redisClient: RedisInstance
): Promise<void> {
  const catalogOk = await checkDatabase(catalogPool);
  if (!catalogOk) {
    throw new Error('Catalog database unavailable at startup');
  }
  logger.info('Catalog database connection verified');

  const serviceOk = await checkDatabase(servicePool);
  if (!serviceOk) {
    throw new Error('Service database unavailable at startup');
  }
  logger.info('Service database connection verified');

  const redisOk = await validateRedisConnection(redisClient);
  if (!redisOk) {
    throw new Error('Redis unavailable at startup');
  }
  logger.info('Redis connection verified');
}

async function checkDatabase(pool: Pool): Promise<boolean> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Startup failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
