import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

// Load .env file
function loadEnvFile(): void {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
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

loadEnvFile();

console.log('SERVICE_DATABASE_URL:', process.env.SERVICE_DATABASE_URL ? 'SET' : 'NOT SET');

const serviceDatabaseUrl = process.env.SERVICE_DATABASE_URL ?? 'postgresql://app@127.0.0.1:5432/supermarket_api_test_service';

async function addMissingColumns(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: serviceDatabaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: true },
  });

  console.log('Adding missing columns to users table...');
  
  const client = await pool.connect();
  try {
    // Check if columns exist
    const checkResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name IN ('refresh_token_hash', 'refresh_token_expires_at')
    `);
    
    const existingColumns = checkResult.rows.map(r => r.column_name);
    console.log('Existing columns:', existingColumns);
    
    if (!existingColumns.includes('refresh_token_hash')) {
      console.log('Adding refresh_token_hash column...');
      await client.query(`ALTER TABLE users ADD COLUMN refresh_token_hash TEXT`);
      console.log('Added refresh_token_hash column');
    } else {
      console.log('refresh_token_hash column already exists');
    }
    
    if (!existingColumns.includes('refresh_token_expires_at')) {
      console.log('Adding refresh_token_expires_at column...');
      await client.query(`ALTER TABLE users ADD COLUMN refresh_token_expires_at TIMESTAMPTZ`);
      console.log('Added refresh_token_expires_at column');
    } else {
      console.log('refresh_token_expires_at column already exists');
    }
    
    console.log('Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

addMissingColumns().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});