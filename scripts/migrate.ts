import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrate(): Promise<void> {
  const env = process.env;
  const config = loadConfig(env);

  const schemaPath = join(__dirname, '..', 'src', 'db', 'service', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  const pool = new Pool({
    connectionString: config.serviceDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    ssl: config.serviceDatabaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: true },
  });

  const client = await pool.connect();
  try {
    console.log('Applying service database schema...');
    await client.query(schema);
    console.log('Schema applied successfully.');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});