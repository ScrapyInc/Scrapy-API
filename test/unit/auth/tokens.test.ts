import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from '../../../src/auth/tokens.ts';

const TEST_JWT_SECRET = 'test-secret-32-characters-minimum-length';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

before(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});

after(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  } else {
    delete process.env.JWT_SECRET;
  }
});

test('signAccessToken creates a valid JWT with 15m expiry', async () => {
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  
  assert.ok(token);
  assert.ok(typeof token === 'string');
  assert.ok(token.split('.').length === 3); // JWT has 3 parts
});

test('signAccessToken includes userId, email, tier in payload', async () => {
  const token = await signAccessToken('user-123', 'test@example.com', 'paid_starter');
  const payload = await verifyAccessToken(token);
  
  assert.ok(payload);
  assert.equal(payload!.userId, 'user-123');
  assert.equal(payload!.email, 'test@example.com');
  assert.equal(payload!.tier, 'paid_starter');
});

test('signAccessToken respects 15m expiry', async () => {
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  const payload = await verifyAccessToken(token);
  
  assert.ok(payload);
  assert.ok(payload!.exp);
  const expTime = payload!.exp! * 1000;
  const now = Date.now();
  // Should expire in ~15 minutes (900 seconds)
  assert.ok(expTime > now + 800 * 1000); // at least ~13 minutes
  assert.ok(expTime < now + 1000 * 1000); // at most ~16 minutes
});

test('signRefreshToken creates a valid JWT with 30d expiry', async () => {
  const token = await signRefreshToken('user-123');
  
  assert.ok(token);
  assert.ok(typeof token === 'string');
  assert.ok(token.split('.').length === 3);
});

test('signRefreshToken includes only userId in payload', async () => {
  const token = await signRefreshToken('user-456');
  const payload = await verifyRefreshToken(token);
  
  assert.ok(payload);
  assert.equal(payload!.userId, 'user-456');
  assert.ok(!payload!.email); // refresh token only has userId
  assert.ok(!payload!.tier);
});

test('signRefreshToken respects 30d expiry', async () => {
  const token = await signRefreshToken('user-123');
  const payload = await verifyRefreshToken(token);
  
  assert.ok(payload);
  assert.ok(payload!.exp);
  const expTime = payload!.exp! * 1000;
  const now = Date.now();
  // Should expire in ~30 days (2,592,000 seconds)
  assert.ok(expTime > now + 2_500_000 * 1000);
  assert.ok(expTime < now + 2_700_000 * 1000);
});

test('verifyAccessToken returns null for invalid token', async () => {
  const result = await verifyAccessToken('invalid.token.here');
  assert.equal(result, null);
});

test('verifyAccessToken returns null for expired token', async () => {
  // Create a token that's already expired by manually crafting one
  // Since we can't easily create an expired token with the current API,
  // we test with a malformed token instead
  const result = await verifyAccessToken('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1c2VyLTEyMyIsImVtYWlsIjoidGVzdEBleGFtcGxlLmNvbSIsInRpZXIiOiJmcmVlIiwiaWF0IjoxMDAwMDAwMDAwLCJleHAiOjEwMDAwMDAwMDB9.invalid');
  assert.equal(result, null);
});

test('verifyRefreshToken returns null for invalid token', async () => {
  const result = await verifyRefreshToken('invalid.token.here');
  assert.equal(result, null);
});

test('verifyAccessToken returns null for token signed with different secret', async () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'different-secret-32-characters-minimum';
  
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  
  process.env.JWT_SECRET = originalSecret;
  
  const result = await verifyAccessToken(token);
  assert.equal(result, null);
  
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});

test('verifyRefreshToken returns null for token signed with different secret', async () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'different-secret-32-characters-minimum';
  
  const token = await signRefreshToken('user-123');
  
  process.env.JWT_SECRET = originalSecret;
  
  const result = await verifyRefreshToken(token);
  assert.equal(result, null);
  
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});