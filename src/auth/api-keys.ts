import crypto from 'node:crypto';

const API_KEY_PEPPER = process.env.API_KEY_PEPPER ?? '';
if (!API_KEY_PEPPER) throw new Error('API_KEY_PEPPER not configured');
const KEY_ID_LENGTH = 8;
const SECRET_BYTES = 32;

function base36Encode(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    const char = byte % 36;
    result += char < 10 ? String.fromCharCode(48 + char) : String.fromCharCode(87 + char);
  }
  return result.slice(0, KEY_ID_LENGTH);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export interface GeneratedApiKey {
  keyId: string;
  secret: string;
  plaintext: string;
  keyLast4: string;
  keyHash: string;
}

export function generateApiKey(keyType: 'live' | 'test'): GeneratedApiKey {
  const keyIdBytes = crypto.randomBytes(KEY_ID_LENGTH);
  const keyId = base36Encode(keyIdBytes);
  const secretBytes = crypto.randomBytes(SECRET_BYTES);
  const secret = base64UrlEncode(secretBytes);
  const plaintext = `sk_${keyType}_${keyId}_${secret}`;
  const keyLast4 = secret.slice(-4);
  const keyHash = hashSecret(secret);
  return { keyId, secret, plaintext, keyLast4, keyHash };
}

export function parseApiKey(plaintext: string): { keyId: string; secret: string } | null {
  const match = plaintext.match(/^sk_(live|test)_([a-z0-9]{8})_([A-Za-z0-9_-]+)$/);
  if (!match || !match[2] || !match[3]) return null;
  return { keyId: match[2], secret: match[3] };
}

export function hashSecret(secret: string): string {
  return crypto.createHmac('sha256', API_KEY_PEPPER).update(secret).digest('hex');
}

export function validateApiKey(secret: string, keyHash: string): boolean {
  const expectedHash = hashSecret(secret);
  return crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(keyHash));
}