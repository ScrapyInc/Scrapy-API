import type { FastifyRequest, FastifyReply } from 'fastify';
import { HttpError } from '../http/errors.ts';
import { parseApiKey, validateApiKey } from '../auth/api-keys.ts';
import { createServiceStore } from '../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../logger/types.ts';

export interface ApiKeyUser {
  id: string;
  email: string;
  tier: string;
  apiKeyId: string;
  keyType: 'live' | 'test';
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyUser?: ApiKeyUser;
  }
}

export function createApiKeyMiddleware(servicePool: pg.Pool, logger: Logger) {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    void _reply;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header');
    }

    const token = authHeader.slice(7);
    const parsed = parseApiKey(token);
    if (!parsed) {
      throw new HttpError(401, 'INVALID_API_KEY', 'Invalid API key format');
    }

    const { keyId, secret } = parsed;

    const store = createServiceStore(servicePool, logger);

    const apiKey = await store.withSnapshot(async (reader) => reader.findApiKeyByKeyId(keyId));
    if (!apiKey) {
      throw new HttpError(401, 'INVALID_API_KEY', 'Invalid API key');
    }

    if (!apiKey.isActive) {
      throw new HttpError(401, 'API_KEY_REVOKED', 'API key has been revoked');
    }

    if (apiKey.revokedAt) {
      throw new HttpError(401, 'API_KEY_REVOKED', 'API key has been revoked');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new HttpError(401, 'API_KEY_EXPIRED', 'API key has expired');
    }

    const valid = validateApiKey(secret, apiKey.keyHash);
    if (!valid) {
      throw new HttpError(401, 'INVALID_API_KEY', 'Invalid API key');
    }

    // Get user and tier
    const user = await store.withSnapshot(async (reader) => reader.findUserById(apiKey.userId));
    if (!user) {
      throw new HttpError(401, 'INVALID_API_KEY', 'Invalid API key');
    }

    const tier = await store.withSnapshot(async (reader) => reader.findTierById('free'));

    request.apiKeyUser = {
      id: user.id,
      email: user.email,
      tier: tier?.id ?? 'free',
      apiKeyId: apiKey.id,
      keyType: apiKey.keyType,
    };
  };
}