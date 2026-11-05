import assert from 'node:assert/strict';
import { test } from 'node:test';

const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

process.env.JWT_SECRET = JWT_SECRET;

test('signAccessToken and verifyAccessToken work correctly', async () => {
  const { signAccessToken, verifyAccessToken } = await import('../../../src/auth/tokens.ts');
  
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  assert.ok(token);
  assert.ok(typeof token === 'string');
  
  const payload = await verifyAccessToken(token);
  assert.ok(payload);
  assert.equal(payload?.userId, 'user-123');
  assert.equal(payload?.email, 'test@example.com');
  assert.equal(payload?.tier, 'free');
});

test('signRefreshToken and verifyRefreshToken work correctly', async () => {
  const { signRefreshToken, verifyRefreshToken } = await import('../../../src/auth/tokens.ts');
  
  const token = await signRefreshToken('user-123');
  assert.ok(token);
  assert.ok(typeof token === 'string');
  
  const payload = await verifyRefreshToken(token);
  assert.ok(payload);
  assert.equal(payload?.userId, 'user-123');
});

test('verifyAccessToken returns null for invalid token', async () => {
  const { verifyAccessToken } = await import('../../../src/auth/tokens.ts');
  
  const payload = await verifyAccessToken('invalid-token');
  assert.equal(payload, null);
});

test('verifyAccessToken returns null for tampered token', async () => {
  const { signAccessToken, verifyAccessToken } = await import('../../../src/auth/tokens.ts');
  
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  const tampered = token + 'x';
  
  const payload = await verifyAccessToken(tampered);
  assert.equal(payload, null);
});

test('verifyAccessToken returns null for token signed with different secret', async () => {
  process.env.JWT_SECRET = 'different-secret-that-is-at-least-32-characters-long';
  
  const { signAccessToken } = await import('../../../src/auth/tokens.ts');
  const token = await signAccessToken('user-123', 'test@example.com', 'free');
  
  process.env.JWT_SECRET = JWT_SECRET;
  
  const { verifyAccessToken } = await import('../../../src/auth/tokens.ts');
  const payload = await verifyAccessToken(token);
  assert.equal(payload, null);
  
  process.env.JWT_SECRET = JWT_SECRET;
});

test('access token and refresh token have different expiry', async () => {
  const { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } = await import('../../../src/auth/tokens.ts');
  
  const accessToken = await signAccessToken('user-123', 'test@example.com', 'free');
  const refreshToken = await signRefreshToken('user-123');
  
  const accessPayload = await verifyAccessToken(accessToken);
  const refreshPayload = await verifyRefreshToken(refreshToken);
  
  assert.ok(accessPayload);
  assert.ok(refreshPayload);
  assert.ok(accessPayload.exp);
  assert.ok(refreshPayload.exp);
  assert.ok(refreshPayload.exp! > accessPayload.exp!);
});