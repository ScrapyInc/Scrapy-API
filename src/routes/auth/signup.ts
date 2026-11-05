import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../http/errors.ts';
import { hashPassword } from '../../auth/password.ts';
import { signAccessToken, signRefreshToken } from '../../auth/tokens.ts';
import { createServiceStore } from '../../db/service/index.ts';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export function registerSignup(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  app.post<{
    Body: { email: string; password: string };
  }>('/v1/auth/signup', async (request, reply) => {
    const { email, password } = request.body;

    if (!email || !EMAIL_REGEX.test(email)) {
      throw new HttpError(400, 'INVALID_EMAIL', 'Invalid email format');
    }

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, 'WEAK_PASSWORD', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const store = createServiceStore(servicePool, logger);

    // Check if user already exists
    const existingUser = await store.withSnapshot(async (reader) => reader.findUserByEmail(email));
    if (existingUser) {
      throw new HttpError(409, 'EMAIL_EXISTS', 'Email already registered');
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);
    const user = await store.createUser(email, passwordHash);

    // Issue tokens
    const token = await signAccessToken(user.id, user.email, 'free');
    const refreshToken = await signRefreshToken(user.id);

    return reply.status(201).send({
      user: { id: user.id, email: user.email, tier: 'free' },
      token,
      refreshToken,
    });
  });
}