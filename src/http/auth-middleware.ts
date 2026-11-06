import type { FastifyRequest, FastifyReply } from 'fastify';
import { HttpError } from '../http/errors.ts';
import { verifyAccessToken } from '../auth/tokens.ts';

export interface AuthenticatedUser {
  id: string;
  email: string;
  tier: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function requireLogin() {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    // _reply is required by Fastify middleware signature but not used
    void _reply;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header');
    }

    const token = authHeader.slice(7);
    const payload = await verifyAccessToken(token);
    if (!payload || !payload.userId) {
      throw new HttpError(401, 'INVALID_TOKEN', 'Invalid or expired access token');
    }

    request.user = {
      id: payload.userId,
      email: payload.email,
      tier: payload.tier,
    };
  };
}