import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppConfig } from '../../src/config.ts';
import { buildApp } from '../../src/app.ts';
import { BODY_LIMIT_BYTES } from '../../src/http/errors.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';

function testConfig(): AppConfig {
  return {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
    logEnv: 'test',
    appVersion: 'test',
    staleAfterHours: 48,
    databaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test',
    serviceDatabaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test_service',
    redisUrl: 'redis://localhost:6379',
    apiKeyPepper: 'test-pepper-32-characters-minimum-length',
    githubRepository: 'osherz80/Scrapy-API',
    githubWorkflowId: 'refresh.yml',
    githubRef: 'refs/heads/main',
    githubToken: 't'.repeat(24),
    dbQueryTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    searchRateLimitPerMinute: 60,
    refreshRateLimitPerMinute: 5,
    dbConcurrency: 2,
  };
}

function appWithLog() {
  const memory = createMemoryTransport();
  const logger = createLoggerFactory({
    level: 'info',
    environment: 'test',
    version: 'test',
    transports: [memory],
  }).create();
  const app = buildApp({ config: testConfig(), logger });
  return { app, memory };
}

test('GET /health/live reports process liveness only', async () => {
  const { app, memory } = appWithLog();
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(typeof response.headers['x-request-id'], 'string');
  const requestLog = memory.records.find((record) => record.message === 'request');
  assert.equal(requestLog?.meta.endpoint, 'GET /health/live');
  assert.equal(requestLog?.meta.status, 200);
  assert.equal(requestLog?.meta.queryType, null);
  assert.equal(requestLog?.meta.resultCount, null);
  assert.equal(typeof requestLog?.meta.durationMs, 'number');
  assert.equal(requestLog?.meta.requestId, response.headers['x-request-id']);
  await app.close();
});

test('unknown routes use the stable error body', async () => {
  const { app } = appWithLog();
  const response = await app.inject({ method: 'GET', url: '/missing' });
  assert.equal(response.statusCode, 404);
  const body = response.json<{ error: { code: string; message: string }; requestId: string }>();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.error.message, 'Not found');
  assert.equal(body.requestId, response.headers['x-request-id']);
  assert.equal(JSON.stringify(body).includes('stack'), false);
  await app.close();
});

test('malformed JSON and oversize bodies are validation errors', async () => {
  const { app } = appWithLog();
  app.post('/__test/body', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    },
  }, async () => ({ ok: true }));

  const malformed = await app.inject({
    method: 'POST',
    url: '/__test/body',
    headers: { 'content-type': 'application/json' },
    payload: '{',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json<{ error: { code: string; message: string } }>().error.code, 'VALIDATION_ERROR');
  assert.equal(malformed.json<{ error: { message: string } }>().error.message, 'request body must be valid JSON');

  const unknownField = await app.inject({
    method: 'POST',
    url: '/__test/body',
    payload: { ok: true, extra: 1 },
  });
  assert.equal(unknownField.statusCode, 400);
  assert.deepEqual(unknownField.json<{ error: { details: Array<{ path: string }> } }>().error.details, [
    { path: 'extra' },
  ]);

  const oversized = await app.inject({
    method: 'POST',
    url: '/__test/body',
    headers: { 'content-type': 'application/json' },
    payload: `{"ok":true,"blob":"${'x'.repeat(BODY_LIMIT_BYTES)}"}`,
  });
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.json<{ error: { message: string } }>().error.message, 'request body exceeds 64 KiB');
  await app.close();
});
