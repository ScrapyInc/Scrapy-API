import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { verifyRefreshToken } from '../../auth/tokens.ts';
import { signAccessToken, signRefreshToken } from '../../auth/tokens.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';

export function registerRefresh(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Body: { refresh_token: string };
  }>('/v1/auth/refresh', async (request, reply) => {
    const { refresh_token } = request.body;

    if (!refresh_token) {
      throw new HttpError(400, 'MISSING_REFRESH_TOKEN', 'Refresh token is required');
    }

    // Verify refresh token
    const payload = await verifyRefreshToken(refresh_token);
    if (!payload || !payload.userId) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }

    const store = createServiceStore(servicePool, logger);

    // Find user by refresh token hash
    const crypto = await import('node:crypto');
    const refreshTokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const user = await store.withSnapshot(async (reader) => reader.findUserByRefreshTokenHash(refreshTokenHash));

    if (!user) {
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
    }

    // Check if refresh token is expired
    if (user.refreshTokenExpiresAt && user.refreshTokenExpiresAt < new Date()) {
      throw new HttpError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token has expired');
    }

    // Get user's tier
    const tier = await store.withSnapshot(async (reader) => reader.findTierById('free'));

    // Issue new tokens (rotate)
    const newAccessToken = await signAccessToken(user.id, user.email, tier?.id ?? 'free');
    const newRefreshToken = await signRefreshToken(user.id);

    // Store new refresh token hash, invalidate old
    const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await store.updateRefreshToken(user.id, newRefreshTokenHash, expiresAt);

    return reply.send({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: { id: user.id, email: user.email, tier: tier?.id ?? 'free' },
    });
  });
}