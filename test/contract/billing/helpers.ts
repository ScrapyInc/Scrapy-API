import type pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../../../src/app.ts';
import type { AppConfig } from '../../../src/config.ts';
import { createServicePool } from '../../../src/db/service/index.ts';
import { createLoggerFactory } from '../../../src/logger/factory.ts';
import { createMemoryTransport } from '../../../src/logger/transports/memory.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TEST_PASSWORD = 'password123';

export function loadEnvFile(): void {
  const envPath = join(__dirname, '..', '..', '..', '.env');
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  } catch {
    // Fall back to the ambient environment.
  }
}

export function createTestConfig(): AppConfig {
  return {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'error',
    logEnv: 'test',
    appVersion: 'test',
    staleAfterHours: 48,
    databaseUrl: process.env.DATABASE_URL ?? 'postgresql://app@127.0.0.1:5432/supermarket_api_test',
    serviceDatabaseUrl:
      process.env.SERVICE_DATABASE_URL ??
      'postgresql://app@127.0.0.1:5432/supermarket_api_test_service',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    apiKeyPepper: process.env.API_KEY_PEPPER ?? 'test-pepper-32-characters-minimum-length',
    githubRepository: '',
    githubWorkflowId: '',
    githubRef: '',
    githubToken: '',
    dbQueryTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    searchRateLimitPerMinute: 60,
    refreshRateLimitPerMinute: 5,
    dbConcurrency: 2,
  };
}

export function createTestApp(servicePool: pg.Pool, config: AppConfig): FastifyInstance {
  return buildApp({
    config,
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
    servicePool,
  });
}

export function createTestServicePool(config: AppConfig): pg.Pool {
  return createServicePool(config.serviceDatabaseUrl, config.dbQueryTimeoutMs);
}

export async function cleanupBillingTestData(pool: pg.Pool, prefix: string): Promise<void> {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${prefix}%`]);
}

export interface TestDeveloper {
  userId: string;
  email: string;
  token: string;
  apiKey: string;
}

export async function createDeveloper(
  app: FastifyInstance,
  email: string
): Promise<TestDeveloper> {
  const signup = await app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: TEST_PASSWORD },
  });
  if (signup.statusCode !== 201) {
    throw new Error(`signup failed: ${signup.statusCode} ${signup.body}`);
  }

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const loginBody = login.json<{ token: string; user: { id: string } }>();

  const keyResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/keys',
    headers: { authorization: `Bearer ${loginBody.token}` },
    payload: { key_type: 'live' },
  });
  if (keyResponse.statusCode !== 201) {
    throw new Error(`create key failed: ${keyResponse.statusCode} ${keyResponse.body}`);
  }

  return {
    userId: loginBody.user.id,
    email,
    token: loginBody.token,
    apiKey: keyResponse.json<{ plaintext: string }>().plaintext,
  };
}

export async function readBalance(pool: pg.Pool, userId: string): Promise<number | null> {
  const result = await pool.query('SELECT balance FROM credit_balances WHERE user_id = $1', [userId]);
  return result.rows[0] ? Number(result.rows[0].balance) : null;
}

export async function readTransactions(
  pool: pg.Pool,
  userId: string
): Promise<Array<{ amount: number; reason: string; referenceId: string | null }>> {
  const result = await pool.query(
    `SELECT amount, reason, reference_id FROM credit_transactions
     WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
    [userId]
  );
  return result.rows.map((row) => ({
    amount: Number(row.amount),
    reason: row.reason as string,
    referenceId: row.reference_id as string | null,
  }));
}
