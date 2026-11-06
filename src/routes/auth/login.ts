import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { verifyPassword } from '../../auth/password.ts';
import { signAccessToken, signRefreshToken } from '../../auth/tokens.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';

export function registerLogin(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Body: { email: string; password: string };
  }>('/v1/auth/login', async (request, reply) => {
    const { email, password } = request.body;

    if (!email || !password) {
      throw new HttpError(400, 'MISSING_CREDENTIALS', 'Email and password are required');
    }

    const store = createServiceStore(servicePool, logger);

    const user = await store.withSnapshot(async (reader) => reader.findUserByEmail(email));
    if (!user) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Get user's tier
    const tier = await store.withSnapshot(async (reader) => reader.findTierById('free'));

    // Issue tokens
    const token = await signAccessToken(user.id, user.email, tier?.id ?? 'free');
    const refreshToken = await signRefreshToken(user.id);

    // Store refresh token hash
    const crypto = await import('node:crypto');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await store.updateRefreshToken(user.id, refreshTokenHash, expiresAt);

    return reply.send({
      token,
      refreshToken,
      user: { id: user.id, email: user.email, tier: tier?.id ?? 'free' },
    });
  });
}