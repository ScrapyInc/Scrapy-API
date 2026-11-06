import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { generateApiKey } from '../../auth/api-keys.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';
import { requireLogin } from '../../http/auth-middleware.ts';

export function registerCreateKey(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Body: { key_type: 'live' | 'test'; expires_at?: string };
  }>('/v1/auth/keys', { preHandler: requireLogin() }, async (request, reply) => {
    const { key_type, expires_at } = request.body;
    const user = request.user!;

    if (!key_type || !['live', 'test'].includes(key_type)) {
      throw new HttpError(400, 'INVALID_KEY_TYPE', 'key_type must be "live" or "test"');
    }

    const store = createServiceStore(servicePool, logger);

    const generated = generateApiKey(key_type);
    const expiresAt = expires_at ? new Date(expires_at) : null;

    if (expiresAt && expiresAt <= new Date()) {
      throw new HttpError(400, 'INVALID_EXPIRES_AT', 'expires_at must be in the future');
    }

    const apiKey = await store.createApiKey(
      user.id,
      generated.keyId,
      generated.keyType,
      generated.keyLast4,
      generated.keyHash,
      expiresAt
    );

    return reply.status(201).send({
      id: apiKey.id,
      key_id: apiKey.keyId,
      key_type: apiKey.keyType,
      key_last4: apiKey.keyLast4,
      is_active: apiKey.isActive,
      expires_at: apiKey.expiresAt?.toISOString() ?? null,
      created_at: apiKey.createdAt.toISOString(),
      plaintext: generated.plaintext,
    });
  });
}