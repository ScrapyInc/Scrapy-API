// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Redis: any = await import('ioredis');

export type RedisInstance = InstanceType<typeof Redis.default>;

export function createRedisClient(redisUrl: string): RedisInstance {
  const client = new Redis.default(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 3) {
        return null;
      }
      return Math.min(times * 100, 3000);
    },
    lazyConnect: true,
  });

  client.on('error', (error: Error) => {
    console.error('Redis connection error:', error);
  });

  return client;
}

export async function validateRedisConnection(client: RedisInstance): Promise<boolean> {
  try {
    const result = await client.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}