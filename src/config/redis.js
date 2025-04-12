const Redis = require('ioredis');

const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
});

redisClient.on('connect', () => {
  console.log('[REDIS] Connected to Redis');
});

redisClient.on('error', (err) => {
  console.error('[REDIS] Redis error:', err);
});

module.exports = { redisClient };