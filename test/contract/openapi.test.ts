import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import { createLoggerFactory } from '../../src/logger/factory.ts';
import { createMemoryTransport } from '../../src/logger/transports/memory.ts';

test('OpenAPI lists search and refresh and includes auth endpoints with bearer auth', async () => {
  const app = buildApp({
    config: {
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'error',
      logEnv: 'test',
      appVersion: 'test',
      staleAfterHours: 48,
      databaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test',
      serviceDatabaseUrl: 'postgresql://app@127.0.0.1:5432/supermarket_api_test_service',
      redisUrl: 'redis://localhost:6379',
      apiKeyPepper: 'test-pepper-32-characters-minimum-length',
      githubRepository: '',
      githubWorkflowId: '',
      githubRef: '',
      githubToken: '',
      dbQueryTimeoutMs: 15_000,
      requestTimeoutMs: 30_000,
      searchRateLimitPerMinute: 60,
      refreshRateLimitPerMinute: 5,
      dbConcurrency: 2,
    } satisfies AppConfig,
    logger: createLoggerFactory({
      level: 'error',
      environment: 'test',
      version: 'test',
      transports: [createMemoryTransport()],
    }).create(),
  });
  const response = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(response.statusCode, 200);
  const document = response.json<{
    info: { description: string };
    paths: Record<string, unknown>;
    components: { securitySchemes?: { bearerAuth?: { type: string; scheme: string } } };
  }>();
  assert.equal(typeof document.paths['/v1/search'], 'object');
  assert.equal(typeof document.paths['/v1/refreshes'], 'object');
  assert.equal(typeof document.paths['/v1/auth/signup'], 'object');
  assert.equal(typeof document.paths['/v1/auth/login'], 'object');
  assert.equal(typeof document.paths['/v1/auth/keys'], 'object');
  assert.equal(typeof document.paths['/v1/billing/tiers'], 'object');
  assert.equal(typeof document.paths['/v1/billing/credits/topup'], 'object');
  assert.ok(document.components.securitySchemes);
  assert.equal(document.components.securitySchemes?.bearerAuth?.type, 'http');
  assert.equal(document.components.securitySchemes?.bearerAuth?.scheme, 'bearer');
  assert.match(document.info.description, /no HTTP credential/);
  await app.close();
});
