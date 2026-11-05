import type pg from 'pg';

import { HttpError } from '../../http/errors.ts';
import type { Logger } from '../../logger/types.ts';
import type {
  ServiceReader,
  ServiceStore,
  User,
  ApiKey,
  Tier,
  CreditBalance,
  CreditTransaction,
} from './types.ts';
import { camelizeRow } from '../rows.ts';

function asUser(row: Record<string, unknown>): User {
  return camelizeRow(row) as unknown as User;
}

function asApiKey(row: Record<string, unknown>): ApiKey {
  return camelizeRow(row) as unknown as ApiKey;
}

function asTier(row: Record<string, unknown>): Tier {
  return camelizeRow(row) as unknown as Tier;
}

function asCreditBalance(row: Record<string, unknown>): CreditBalance {
  return camelizeRow(row) as unknown as CreditBalance;
}

function asCreditTransaction(row: Record<string, unknown>): CreditTransaction {
  return camelizeRow(row) as unknown as CreditTransaction;
}

export class PgServiceStore implements ServiceStore {
  private readonly pool: pg.Pool;
  private readonly logger: Logger;

  constructor(pool: pg.Pool, logger: Logger) {
    this.pool = pool;
    this.logger = logger;
  }

  async withSnapshot<T>(fn: (reader: ServiceReader) => Promise<T>): Promise<T> {
    let client: pg.PoolClient | undefined;
    const started = Date.now();
    try {
      client = await this.pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await fn(new PgReader(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
      this.logger.error('Service database operation failed', {
        phase: client ? 'query' : 'connect',
        databaseCode: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN',
        databaseMs: Date.now() - started,
      });
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'UNAVAILABLE', 'Database unavailable', undefined, 5);
    } finally {
      client?.release();
    }
  }

  async createUser(email: string, passwordHash: string): Promise<User> {
    const result = await this.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       RETURNING id, email, password_hash, created_at, updated_at`,
      [email, passwordHash]
    );
    return asUser(result.rows[0]);
  }

  async createApiKey(
    userId: string,
    keyId: string,
    keyType: 'live' | 'test',
    keyLast4: string,
    keyHash: string,
    expiresAt: Date | null
  ): Promise<ApiKey> {
    const result = await this.pool.query(
      `INSERT INTO api_keys (user_id, key_id, key_type, key_last4, key_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, key_id, key_type, key_last4, key_hash, is_active, revoked_at, expires_at, created_at, allowed_ips, allowed_origins, restriction_mode`,
      [userId, keyId, keyType, keyLast4, keyHash, expiresAt]
    );
    return asApiKey(result.rows[0]);
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys SET is_active = false, revoked_at = now() WHERE key_id = $1`,
      [keyId]
    );
  }

  async createCreditTransaction(
    userId: string,
    amount: number,
    reason: 'topup' | 'x402_topup' | 'api_call',
    referenceId: string | null
  ): Promise<CreditTransaction> {
    const result = await this.pool.query(
      `INSERT INTO credit_transactions (user_id, amount, reason, reference_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, amount, reason, reference_id, created_at`,
      [userId, amount, reason, referenceId]
    );
    return asCreditTransaction(result.rows[0]);
  }

  async updateCreditBalance(userId: string, amount: number): Promise<CreditBalance> {
    const result = await this.pool.query(
      `INSERT INTO credit_balances (user_id, balance, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         balance = credit_balances.balance + EXCLUDED.balance,
         updated_at = now()
       RETURNING user_id, balance, updated_at`,
      [userId, amount]
    );
    return asCreditBalance(result.rows[0]);
  }
}

class PgReader implements ServiceReader {
  private readonly client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    this.client = client;
  }

  async findUserById(id: string): Promise<User | null> {
    const result = await this.client.query(
      `SELECT id, email, password_hash, created_at, updated_at FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? asUser(result.rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.client.query(
      `SELECT id, email, password_hash, created_at, updated_at FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] ? asUser(result.rows[0]) : null;
  }

  async findApiKeyByKeyId(keyId: string): Promise<ApiKey | null> {
    const result = await this.client.query(
      `SELECT id, user_id, key_id, key_type, key_last4, key_hash, is_active, revoked_at, expires_at, created_at, allowed_ips, allowed_origins, restriction_mode
       FROM api_keys WHERE key_id = $1`,
      [keyId]
    );
    return result.rows[0] ? asApiKey(result.rows[0]) : null;
  }

  async findApiKeysByUserId(userId: string): Promise<ApiKey[]> {
    const result = await this.client.query(
      `SELECT id, user_id, key_id, key_type, key_last4, key_hash, is_active, revoked_at, expires_at, created_at, allowed_ips, allowed_origins, restriction_mode
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(asApiKey);
  }

  async findTierById(id: string): Promise<Tier | null> {
    const result = await this.client.query(
      `SELECT id, name, daily_search_cap, monthly_search_cap, credit_per_search, credit_per_batch_query, created_at
       FROM tiers WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? asTier(result.rows[0]) : null;
  }

  async findCreditBalanceByUserId(userId: string): Promise<CreditBalance | null> {
    const result = await this.client.query(
      `SELECT user_id, balance, updated_at FROM credit_balances WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? asCreditBalance(result.rows[0]) : null;
  }

  async findCreditTransactionsByUserId(userId: string, limit: number): Promise<CreditTransaction[]> {
    const result = await this.client.query(
      `SELECT id, user_id, amount, reason, reference_id, created_at
       FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(asCreditTransaction);
  }
}