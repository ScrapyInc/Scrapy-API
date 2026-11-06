import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rootCertificates } from 'node:tls';

import pg from 'pg';

import { createPool, createServicePool } from '../../src/db/pool.ts';

test('remote connections use the configured CA even with sslmode in DATABASE_URL', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-ca-'));
  const caPath = path.join(dir, 'database.crt');
  const ca = rootCertificates[0]!;
  writeFileSync(caPath, ca);
  const pool = createPool('postgresql://app:password@db.example/postgres?sslmode=require', 15000, caPath);
  try {
    const client = new pg.Client(pool.options);
    const ssl = client.ssl as unknown as { ca?: string; rejectUnauthorized?: boolean };
    assert.equal(ssl.ca, ca);
    assert.notEqual(ssl.rejectUnauthorized, false);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true });
  }
});

test('remote URL options cannot disable certificate verification', async () => {
  const pool = createPool('postgresql://app:password@db.example/postgres?sslmode=no-verify', 15000);
  try {
    const client = new pg.Client(pool.options);
    const ssl = client.ssl as unknown as { rejectUnauthorized?: boolean };
    assert.ok(ssl);
    assert.notEqual(ssl.rejectUnauthorized, false);
  } finally {
    await pool.end();
  }
});

test('createServicePool uses the same SSL configuration for remote Neon', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-ca-'));
  const caPath = path.join(dir, 'database.crt');
  const ca = rootCertificates[0]!;
  writeFileSync(caPath, ca);
  const pool = createServicePool('postgresql://app:password@db.example/service_db?sslmode=require', 15000);
  try {
    const client = new pg.Client(pool.options);
    const ssl = client.ssl as unknown as { rejectUnauthorized?: boolean };
    assert.notEqual(ssl.rejectUnauthorized, false);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true });
  }
});

test('createServicePool has correct pool options for Neon free tier', () => {
  const pool = createServicePool('postgresql://app@127.0.0.1:5432/service_db', 15000);
  assert.equal(pool.options.max, 4);
  assert.equal(pool.options.connectionTimeoutMillis, 5_000);
  assert.equal(pool.options.statement_timeout, 15000);
  pool.end();
});

test('createServicePool uses SSL for remote connections', () => {
  const pool = createServicePool('postgresql://app:password@db.example:5432/service_db?sslmode=require', 15000);
  const client = new pg.Client(pool.options);
  const ssl = client.ssl as unknown as { rejectUnauthorized?: boolean };
  assert.ok(ssl);
  assert.notEqual(ssl.rejectUnauthorized, false);
  pool.end();
});
