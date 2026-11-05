import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppConfig } from '../../src/config.ts';
import { dispatchWorkflow } from '../../src/refresh/dispatch.ts';

function config(): AppConfig {
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
    githubToken: 'token-value-not-logged-here',
    dbQueryTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
    searchRateLimitPerMinute: 60,
    refreshRateLimitPerMinute: 5,
    dbConcurrency: 2,
  };
}

test('dispatch treats HTTP success, HTTP rejection, and network failure differently', async () => {
  const acknowledged = await dispatchWorkflow(config(), 'run-1', async () => new Response(null, { status: 204 }));
  const rejected = await dispatchWorkflow(config(), 'run-1', async () => new Response('missing', { status: 404 }));
  const uncertain = await dispatchWorkflow(config(), 'run-1', async () => {
    throw new Error('timeout');
  });
  assert.equal(acknowledged, 'acknowledged');
  assert.equal(rejected, 'rejected');
  assert.equal(uncertain, 'uncertain');
});
