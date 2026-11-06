import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../../../src/auth/password.ts';

test('hashPassword uses bcrypt cost 12', async () => {
  const password = 'test-password-123';
  const hash = await hashPassword(password);
  
  // bcrypt hash format: $2b$<cost>$<salt><hash>
  // cost 12 = $2b$12$
  assert.ok(hash.startsWith('$2b$12$'), `Expected hash to start with $2b$12$, got: ${hash}`);
});

test('hashPassword produces different hashes for same password (different salts)', async () => {
  const password = 'same-password';
  const hash1 = await hashPassword(password);
  const hash2 = await hashPassword(password);
  
  assert.notEqual(hash1, hash2, 'Same password should produce different hashes (different salts)');
  // Both should still verify correctly
  assert.equal(await verifyPassword(password, hash1), true);
  assert.equal(await verifyPassword(password, hash2), true);
});

test('verifyPassword returns true for correct password', async () => {
  const password = 'correct-password';
  const hash = await hashPassword(password);
  
  const result = await verifyPassword(password, hash);
  assert.equal(result, true);
});

test('verifyPassword returns false for wrong password', async () => {
  const password = 'correct-password';
  const wrongPassword = 'wrong-password';
  const hash = await hashPassword(password);
  
  const result = await verifyPassword(wrongPassword, hash);
  assert.equal(result, false);
});

test('verifyPassword returns false for empty password against non-empty hash', async () => {
  const password = 'some-password';
  const hash = await hashPassword(password);
  
  const result = await verifyPassword('', hash);
  assert.equal(result, false);
});

test('verifyPassword returns false for non-empty password against empty hash', async () => {
  // bcrypt.compare returns false for invalid hash format (doesn't throw)
  const result = await verifyPassword('some-password', '');
  assert.equal(result, false);
});

test('verifyPassword returns false for invalid hash format', async () => {
  const result = await verifyPassword('some-password', 'not-a-valid-hash');
  assert.equal(result, false);
});

test('hashPassword with unicode password', async () => {
  const password = 'パスワード🔐';
  const hash = await hashPassword(password);
  
  assert.ok(hash.startsWith('$2b$12$'));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('hashPassword with very long password', async () => {
  const password = 'a'.repeat(100);
  const hash = await hashPassword(password);
  
  assert.ok(hash.startsWith('$2b$12$'));
  assert.equal(await verifyPassword(password, hash), true);
});

test('verifyPassword is case-sensitive', async () => {
  const password = 'CaseSensitive123';
  const hash = await hashPassword(password);
  
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('casesensitive123', hash), false);
  assert.equal(await verifyPassword('CASESENSITIVE123', hash), false);
});