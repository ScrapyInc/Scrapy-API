import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../../src/config.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function migrateTestDatabases(): Promise<void> {
  // Load .env file if it exists
  loadEnvFile();

  const config = loadConfig(process.env);

  // Apply schema to service database
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'service', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  const servicePool = new Pool({
    connectionString: config.serviceDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    ssl: config.serviceDatabaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: true },
  });

  console.log('Applying service database schema...');
  const client = await servicePool.connect();
  try {
    await client.query(schema);
    console.log('Service database schema applied successfully.');
  } catch (error) {
    console.error('Service database migration failed:', error);
    throw error;
  } finally {
    client.release();
    await servicePool.end();
  }
}

function loadEnvFile(): void {
  const envPath = join(__dirname, '..', '.env');
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
    console.log('Loaded .env file');
  } catch {
    console.log('No .env file found, using process.env');
  }
}

migrateTestDatabases().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});