import type pg from 'pg';

import type { Logger } from '../../logger/types.ts';
import type { ServiceReader, ServiceStore } from './types.ts';
import { PgServiceStore } from './store.ts';

export function createServiceReader(_pool: pg.Pool): ServiceReader {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _ = _pool;
  // The reader is created per-transaction in withSnapshot, so we don't create it here
  // This function is kept for API consistency
  throw new Error('Use store.withSnapshot(reader => ...) instead');
}

export function createServiceStore(pool: pg.Pool, logger: Logger): ServiceStore {
  return new PgServiceStore(pool, logger);
}

export { createServicePool } from '../pool.ts';
export { PgServiceStore } from './store.ts';
export type { ServiceReader, ServiceStore } from './types.ts';
export type { User, ApiKey, Tier, CreditBalance, CreditTransaction } from './types.ts';