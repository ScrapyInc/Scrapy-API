import type { FastifyInstance } from 'fastify';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';
import { requireLogin } from '../../http/auth-middleware.ts';

export function registerListKeys(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>('/v1/auth/keys', { preHandler: requireLogin() }, async (request, reply) => {
    const user = request.user!;
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
    const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

    const store = createServiceStore(servicePool, logger);

    const keys = await store.withSnapshot(async (reader) => reader.findApiKeysByUserId(user.id));

    const paginated = keys.slice(offset, offset + limit);

    return reply.send({
      keys: paginated.map((key) => ({
        id: key.id,
        key_id: key.keyId,
        key_type: key.keyType,
        key_last4: key.keyLast4,
        is_active: key.isActive,
        revoked_at: key.revokedAt?.toISOString() ?? null,
        expires_at: key.expiresAt?.toISOString() ?? null,
        created_at: key.createdAt.toISOString(),
      })),
      total: keys.length,
      limit,
      offset,
    });
  });
}