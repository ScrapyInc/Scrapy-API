import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { generateApiKey } from '../../auth/api-keys.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';
import { requireLogin } from '../../http/auth-middleware.ts';

export function registerRotateKey(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Params: { id: string };
  }>('/v1/auth/keys/:id/rotate', { preHandler: requireLogin() }, async (request, reply) => {
    const { id } = request.params;
    const user = request.user!;

    const store = createServiceStore(servicePool, logger);

    // Verify ownership
    const userKeys = await store.withSnapshot(async (reader) => reader.findApiKeysByUserId(user.id));
    const oldKey = userKeys.find((k) => k.id === id);
    if (!oldKey) {
      throw new HttpError(404, 'KEY_NOT_FOUND', 'API key not found');
    }

    // Generate new key with same type
    const generated = generateApiKey(oldKey.keyType);

    // Revoke old key
    await store.revokeApiKey(oldKey.keyId);

    // Create new key
    const newKey = await store.createApiKey(
      user.id,
      generated.keyId,
      generated.keyType,
      generated.keyLast4,
      generated.keyHash,
      oldKey.expiresAt
    );

    return reply.send({
      id: newKey.id,
      key_id: newKey.keyId,
      key_type: newKey.keyType,
      key_last4: newKey.keyLast4,
      is_active: newKey.isActive,
      expires_at: newKey.expiresAt?.toISOString() ?? null,
      created_at: newKey.createdAt.toISOString(),
      plaintext: generated.plaintext,
    });
  });
}