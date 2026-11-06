import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';
import { requireLogin } from '../../http/auth-middleware.ts';

export function registerRevokeKey(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Params: { id: string };
  }>('/v1/auth/keys/:id/revoke', { preHandler: requireLogin() }, async (request, reply) => {
    const { id } = request.params;
    const user = request.user!;

    const store = createServiceStore(servicePool, logger);

    // Verify ownership
    const userKeys = await store.withSnapshot(async (reader) => reader.findApiKeysByUserId(user.id));
    const key = userKeys.find((k) => k.id === id);
    if (!key) {
      throw new HttpError(404, 'KEY_NOT_FOUND', 'API key not found');
    }

    await store.revokeApiKey(key.keyId);

    return reply.status(204).send();
  });
}