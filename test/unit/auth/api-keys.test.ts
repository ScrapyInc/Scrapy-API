import assert from 'node:assert/strict';
import { test } from 'node:test';

const API_KEY_PEPPER = 'test-pepper-32-characters-minimum-length';

process.env.API_KEY_PEPPER = API_KEY_PEPPER;

test('generateApiKey creates valid key structure', async () => {
  const { generateApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const liveKey = generateApiKey('live');
  assert.ok(liveKey.keyId);
  assert.ok(liveKey.secret);
  assert.ok(liveKey.plaintext);
  assert.ok(liveKey.keyLast4);
  assert.ok(liveKey.keyHash);
  assert.equal(liveKey.keyType, 'live');
  
  assert.ok(liveKey.plaintext.startsWith('sk_live_'));
  assert.ok(liveKey.plaintext.includes(liveKey.keyId));
  assert.ok(liveKey.plaintext.includes(liveKey.secret));
  assert.equal(liveKey.keyLast4, liveKey.secret.slice(-4));
  
  const testKey = generateApiKey('test');
  assert.equal(testKey.keyType, 'test');
  assert.ok(testKey.plaintext.startsWith('sk_test_'));
});

test('generateApiKey produces unique keys', async () => {
  const { generateApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const key1 = generateApiKey('live');
  const key2 = generateApiKey('live');
  
  assert.notEqual(key1.keyId, key2.keyId);
  assert.notEqual(key1.secret, key2.secret);
  assert.notEqual(key1.plaintext, key2.plaintext);
  assert.notEqual(key1.keyHash, key2.keyHash);
});

test('parseApiKey correctly parses valid keys', async () => {
  const { generateApiKey, parseApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const generated = generateApiKey('live');
  const parsed = parseApiKey(generated.plaintext);
  
  assert.ok(parsed);
  assert.equal(parsed?.keyId, generated.keyId);
  assert.equal(parsed?.secret, generated.secret);
});

test('parseApiKey returns null for invalid keys', async () => {
  const { parseApiKey } = await import('../../../src/auth/api-keys.ts');
  
  assert.equal(parseApiKey('invalid'), null);
  assert.equal(parseApiKey('sk_live_short_secret'), null);
  assert.equal(parseApiKey('sk_invalid_abc12345_secret'), null);
  assert.equal(parseApiKey(''), null);
});

test('hashSecret produces deterministic hash', async () => {
  const { hashSecret } = await import('../../../src/auth/api-keys.ts');
  
  const secret = 'test-secret';
  const hash1 = hashSecret(secret);
  const hash2 = hashSecret(secret);
  
  assert.equal(hash1, hash2);
  assert.ok(hash1.length === 64);
});

test('validateApiKey validates correct secret', async () => {
  const { generateApiKey, validateApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const generated = generateApiKey('live');
  const valid = validateApiKey(generated.secret, generated.keyHash);
  assert.equal(valid, true);
});

test('validateApiKey rejects incorrect secret', async () => {
  const { generateApiKey, validateApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const generated = generateApiKey('live');
  const valid = validateApiKey('wrong-secret', generated.keyHash);
  assert.equal(valid, false);
});

test('validateApiKey uses constant-time comparison', async () => {
  const { hashSecret, validateApiKey } = await import('../../../src/auth/api-keys.ts');
  
  const secret = 'test-secret';
  const hash = hashSecret(secret);
  
  const start1 = process.hrtime.bigint();
  validateApiKey(secret, hash);
  const end1 = process.hrtime.bigint();
  
  const start2 = process.hrtime.bigint();
  validateApiKey('wrong', hash);
  const end2 = process.hrtime.bigint();
  
  const time1 = end1 - start1;
  const time2 = end2 - start2;
  
  const diff = time1 > time2 ? time1 - time2 : time2 - time1;
  assert.ok(diff < 1_000_000n);
});