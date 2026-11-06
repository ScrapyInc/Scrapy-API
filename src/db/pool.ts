import pg from 'pg';

const { Pool } = pg;

export function isLocalDatabase(connectionString: string): boolean {
  const url = new URL(connectionString);
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

export function assertLocalTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, '');
  if (!isLocalDatabase(connectionString) || !name.startsWith('supermarket_api_test')) {
    throw new Error('REFUSING_NON_LOCAL_TEST_DATABASE');
  }
}

export function createPool(connectionString: string, statementTimeoutMs: number, sslRootCert?: string): pg.Pool {
  const url = new URL(connectionString);
  if (!isLocalDatabase(connectionString)) {
    // pg's URL SSL options replace the ssl object, so configure the CA and
    // verification together in the URL rather than losing the CA to sslmode.
    url.searchParams.set('sslmode', 'verify-full');
    if (sslRootCert) url.searchParams.set('sslrootcert', sslRootCert);
  }
  const pool = new Pool({
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    ssl: isLocalDatabase(connectionString) ? undefined : { rejectUnauthorized: true },
  });
  return pool;
}

export function createServicePool(connectionString: string, statementTimeoutMs: number): pg.Pool {
  const url = new URL(connectionString);
  if (!isLocalDatabase(connectionString)) {
    // For remote databases, check if sslmode is already set in the URL
    if (!url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'verify-full');
    }
  }
  const pool = new Pool({
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    ssl: isLocalDatabase(connectionString) ? undefined : { rejectUnauthorized: true },
  });
  return pool;
}
