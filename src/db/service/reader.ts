import type pg from 'pg';

import type { ServiceReader, User, ApiKey, Tier, CreditBalance, CreditTransaction } from './types.ts';
import { camelizeRow } from '../rows.ts';

function asUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    refreshTokenHash: row.refresh_token_hash as string | null,
    refreshTokenExpiresAt: row.refresh_token_expires_at ? new Date(row.refresh_token_expires_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
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

export class PgReader implements ServiceReader {
  private readonly client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    this.client = client;
  }

  async findUserById(id: string): Promise<User | null> {
    const result = await this.client.query(
      `SELECT id, email, password_hash, refresh_token_hash, refresh_token_expires_at, created_at, updated_at FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? asUser(result.rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const result = await this.client.query(
      `SELECT id, email, password_hash, refresh_token_hash, refresh_token_expires_at, created_at, updated_at FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] ? asUser(result.rows[0]) : null;
  }

  async findUserByRefreshTokenHash(refreshTokenHash: string): Promise<User | null> {
    const result = await this.client.query(
      `SELECT id, email, password_hash, refresh_token_hash, refresh_token_expires_at, created_at, updated_at FROM users WHERE refresh_token_hash = $1`,
      [refreshTokenHash]
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

  async findAllTiers(): Promise<Tier[]> {
    const result = await this.client.query(
      `SELECT id, name, daily_search_cap, monthly_search_cap, credit_per_search, credit_per_batch_query, created_at
       FROM tiers
       ORDER BY CASE id WHEN 'free' THEN 1 WHEN 'paid_starter' THEN 2 WHEN 'paid_pro' THEN 3 ELSE 4 END, id`
    );
    return result.rows.map(asTier);
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
    return this.getCreditBalance(userId);
  }

  async getCreditBalance(userId: string): Promise<CreditBalance | null> {
    const result = await this.client.query(
      `SELECT user_id, balance, updated_at FROM credit_balances WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? asCreditBalance(result.rows[0]) : null;
  }

  async createCreditBalance(userId: string): Promise<CreditBalance> {
    const result = await this.client.query(
      `INSERT INTO credit_balances (user_id, balance, updated_at)
       VALUES ($1, 0, now())
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING user_id, balance, updated_at`,
      [userId]
    );
    return asCreditBalance(result.rows[0]);
  }

  async addCreditTransaction(
    userId: string,
    amount: number,
    reason: 'topup' | 'x402_topup' | 'api_call',
    referenceId: string | null
  ): Promise<CreditTransaction> {
    const result = await this.client.query(
      `INSERT INTO credit_transactions (user_id, amount, reason, reference_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, amount, reason, reference_id, created_at`,
      [userId, amount, reason, referenceId]
    );
    return asCreditTransaction(result.rows[0]);
  }

  async findCreditTransactionsByUserId(userId: string, limit: number): Promise<CreditTransaction[]> {
    return this.findCreditTransactionsByUser(userId, limit, 0);
  }

  async findCreditTransactionsByUser(
    userId: string,
    limit: number,
    offset: number
  ): Promise<CreditTransaction[]> {
    const result = await this.client.query(
      `SELECT id, user_id, amount, reason, reference_id, created_at
       FROM credit_transactions WHERE user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows.map(asCreditTransaction);
  }
}