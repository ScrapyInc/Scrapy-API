import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Logger } from '../../logger/types.ts';
import { registerSignup } from './signup.ts';
import { registerLogin } from './login.ts';
import { registerRefresh } from './refresh.ts';

export function registerAuthRoutes(app: FastifyInstance, servicePool: pg.Pool, logger: Logger): void {
  registerSignup(app, servicePool, logger);
  registerLogin(app, servicePool, logger);
  registerRefresh(app, servicePool, logger);
}