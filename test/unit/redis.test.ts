import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRedisClient, validateRedisConnection } from '../../src/db/redis.ts';

test('createRedisClient returns a Redis instance', () => {
  const client = createRedisClient('redis://localhost:6379');
  assert.ok(client);
  assert.equal(typeof client.ping, 'function');
  assert.equal(typeof client.quit, 'function');
  assert.equal(typeof client.on, 'function');
  client.quit();
});

test('createRedisClient configures retry strategy', () => {
  const client = createRedisClient('redis://localhost:6379');
  // The client should have retry strategy configured
  assert.ok(client.options.retryStrategy);
  client.quit();
});

test('createRedisClient configures lazyConnect', () => {
  const client = createRedisClient('redis://localhost:6379');
  assert.equal(client.options.lazyConnect, true);
  client.quit();
});

test('validateRedisConnection returns true for successful ping', async () => {
  const mockClient = {
    ping: async () => 'PONG',
  } as unknown as ReturnType<typeof createRedisClient>;

  const result = await validateRedisConnection(mockClient);
  assert.equal(result, true);
});

test('validateRedisConnection returns false for failed ping', async () => {
  const mockClient = {
    ping: async () => {
      throw new Error('Connection refused');
    },
  } as unknown as ReturnType<typeof createRedisClient>;

  const result = await validateRedisConnection(mockClient);
  assert.equal(result, false);
});

test('validateRedisConnection returns false for non-PONG response', async () => {
  const mockClient = {
    ping: async () => 'ERROR',
  } as unknown as ReturnType<typeof createRedisClient>;

  const result = await validateRedisConnection(mockClient);
  assert.equal(result, false);
});