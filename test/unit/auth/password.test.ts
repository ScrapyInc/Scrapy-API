import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../../../src/auth/password.ts';

test('hashPassword and verifyPassword work correctly', async () => {
  const password = 'test-password-123';
  const hash = await hashPassword(password);
  
  assert.ok(hash);
  assert.notEqual(hash, password);
  assert.ok(hash.startsWith('$2b$12$'));
  
  const valid = await verifyPassword(password, hash);
  assert.equal(valid, true);
  
  const invalid = await verifyPassword('wrong-password', hash);
  assert.equal(invalid, false);
});

test('hashPassword produces different hashes for same password', async () => {
  const password = 'same-password';
  const hash1 = await hashPassword(password);
  const hash2 = await hashPassword(password);
  
  assert.notEqual(hash1, hash2);
  
  assert.equal(await verifyPassword(password, hash1), true);
  assert.equal(await verifyPassword(password, hash2), true);
});

test('verifyPassword returns false for non-existent hash', async () => {
  const result = await verifyPassword('password', '$2b$12$invalidhash');
  assert.equal(result, false);
});