export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface AppConfig {
  port: number;
  host: '0.0.0.0';
  logLevel: LogLevel;
  logEnv: string;
  appVersion: string;
  staleAfterHours: number;
  databaseUrl: string;
  databaseSslRootCert?: string;
  serviceDatabaseUrl: string;
  redisUrl: string;
  apiKeyPepper: string;
  githubRepository: string;
  githubWorkflowId: string;
  githubRef: string;
  githubToken: string;
  dbQueryTimeoutMs: number;
  requestTimeoutMs: number;
  searchRateLimitPerMinute: number;
  refreshRateLimitPerMinute: number;
  dbConcurrency: number;
}

export class ConfigError extends Error {
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(missing: readonly string[], invalid: readonly string[]) {
    super(
      `Invalid configuration: ${[
        ...missing.map((name) => `missing ${name}`),
        ...invalid.map((name) => `invalid ${name}`),
      ].join(', ')}`,
    );
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

const REQUIRED = ['DATABASE_URL', 'SERVICE_DATABASE_URL', 'REDIS_URL', 'API_KEY_PEPPER'] as const;

const GITHUB_SETTINGS = [
  'GITHUB_REPOSITORY',
  'GITHUB_WORKFLOW_ID',
  'GITHUB_REF',
  'GITHUB_TOKEN',
] as const;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

type Env = Readonly<Record<string, string | undefined>>;

export function requireDatabaseUrl(env: Env): string {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!present(env.DATABASE_URL)) missing.push('DATABASE_URL');
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL, 'DATABASE_URL', invalid);
  if (missing.length > 0 || invalid.length > 0 || databaseUrl === undefined) {
    throw new ConfigError(missing, invalid);
  }
  return databaseUrl;
}

export function loadConfig(env: Env): AppConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const name of REQUIRED) {
    if (!present(env[name])) missing.push(name);
  }

  const logEnv = optional(env, 'LOG_ENV', 'development', invalid);
  const production = logEnv === 'production';
  const requestedLevel = readLogLevel(env.LOG_LEVEL, production ? 'info' : 'debug', invalid);
  const logLevel =
    production && LEVEL_ORDER[requestedLevel] < LEVEL_ORDER.info ? 'info' : requestedLevel;

  const databaseUrl = readDatabaseUrl(env.DATABASE_URL, 'DATABASE_URL', invalid);
  const serviceDatabaseUrl = readDatabaseUrl(env.SERVICE_DATABASE_URL, 'SERVICE_DATABASE_URL', invalid);
  const redisUrl = readRedisUrl(env.REDIS_URL, 'REDIS_URL', invalid);
  const apiKeyPepper = readSecret(env.API_KEY_PEPPER, 'API_KEY_PEPPER', 32, invalid);
  const github = readGithubSettings(env, missing, invalid);

  const config: AppConfig = {
    port: readInt(env, 'PORT', 3000, 1, 65535, invalid),
    host: '0.0.0.0',
    logLevel,
    logEnv,
    appVersion: optional(env, 'APP_VERSION', 'dev', invalid),
    staleAfterHours: readNumber(env, 'STALE_AFTER_HOURS', 48, 1, 24 * 14, invalid),
    databaseUrl: databaseUrl ?? '',
    serviceDatabaseUrl: serviceDatabaseUrl ?? '',
    redisUrl: redisUrl ?? '',
    apiKeyPepper: apiKeyPepper ?? '',
    ...(present(env.DATABASE_SSLROOTCERT) ? { databaseSslRootCert: env.DATABASE_SSLROOTCERT } : {}),
    githubRepository: github.repository,
    githubWorkflowId: github.workflowId,
    githubRef: github.ref,
    githubToken: github.token,
    dbQueryTimeoutMs: readInt(env, 'DB_QUERY_TIMEOUT_MS', 15_000, 1, 120_000, invalid),
    requestTimeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', 30_000, 1, 120_000, invalid),
    searchRateLimitPerMinute: readInt(env, 'SEARCH_RATE_LIMIT_PER_MINUTE', 60, 1, 10_000, invalid),
    refreshRateLimitPerMinute: readInt(env, 'REFRESH_RATE_LIMIT_PER_MINUTE', 5, 1, 1_000, invalid),
    dbConcurrency: readInt(env, 'DB_CONCURRENCY', 2, 1, 8, invalid),
  };

  if (missing.length > 0 || invalid.length > 0) {
    throw new ConfigError(missing, invalid);
  }
  return config;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function readGithubSettings(env: Env, missing: string[], invalid: string[]) {
  const anySet = GITHUB_SETTINGS.some((name) => present(env[name]));
  if (!anySet) return { repository: '', workflowId: '', ref: '', token: '' };
  for (const name of GITHUB_SETTINGS) {
    if (!present(env[name])) missing.push(name);
  }
  return {
    repository: readPattern(
      env.GITHUB_REPOSITORY,
      'GITHUB_REPOSITORY',
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      invalid,
    ),
    workflowId: readBounded(
      env.GITHUB_WORKFLOW_ID,
      'GITHUB_WORKFLOW_ID',
      128,
      /^[A-Za-z0-9_./-]+$/,
      invalid,
    ),
    ref: readBounded(env.GITHUB_REF, 'GITHUB_REF', 256, /^[^\s]+$/, invalid),
    token: readSecret(env.GITHUB_TOKEN, 'GITHUB_TOKEN', 20, invalid) ?? '',
  };
}

function optional(env: Env, name: string, fallback: string, invalid: string[]): string {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value.trim() === '' || value.length > 64) {
    invalid.push(name);
    return fallback;
  }
  return value;
}

function readLogLevel(value: string | undefined, fallback: LogLevel, invalid: string[]): LogLevel {
  if (value === undefined) return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  invalid.push('LOG_LEVEL');
  return fallback;
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  invalid: string[],
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    invalid.push(name);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    invalid.push(name);
    return fallback;
  }
  return parsed;
}

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  invalid: string[],
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    invalid.push(name);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    invalid.push(name);
    return fallback;
  }
  return parsed;
}

function readSecret(
  value: string | undefined,
  name: string,
  minLength: number,
  invalid: string[],
): string | undefined {
  if (!present(value)) return undefined;
  if (value.length < minLength || /\s/.test(value)) {
    invalid.push(name);
    return undefined;
  }
  return value;
}

function readPattern(
  value: string | undefined,
  name: string,
  pattern: RegExp,
  invalid: string[],
): string {
  if (!present(value) || !pattern.test(value)) {
    if (present(value)) invalid.push(name);
    return '';
  }
  return value;
}

function readBounded(
  value: string | undefined,
  name: string,
  max: number,
  pattern: RegExp,
  invalid: string[],
): string {
  if (!present(value) || value.length > max || !pattern.test(value)) {
    if (present(value)) invalid.push(name);
    return '';
  }
  return value;
}

function readDatabaseUrl(
  value: string | undefined,
  name: string,
  invalid: string[],
): string | undefined {
  if (!present(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid.push(name);
    return undefined;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  const database = url.pathname.replace(/^\//, '');
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.username === '' ||
    url.hostname === '' ||
    database === '' ||
    url.hash !== '' ||
    (!local && url.password === '') ||
    (!local && url.searchParams.get('sslmode') === 'disable')
  ) {
    invalid.push(name);
    return undefined;
  }
  return value;
}

function readRedisUrl(
  value: string | undefined,
  name: string,
  invalid: string[],
): string | undefined {
  if (!present(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid.push(name);
    return undefined;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (
    (url.protocol !== 'redis:' && url.protocol !== 'rediss:') ||
    url.hostname === '' ||
    (!local && url.password === '') ||
    (!local && url.protocol !== 'rediss:')
  ) {
    invalid.push(name);
    return undefined;
  }
  return value;
}
