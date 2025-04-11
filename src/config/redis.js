const Redis = require('ioredis');

const redisClient = new Redis({
  host: 'localhost',
  port: 6379,
});

const redisSubscriber = new Redis({
  host: 'localhost',
  port: 6379,
});

redisClient.on('connect', async () => {
  console.log('🔗 Kết nối Redis thành công (redisClient)!');
  const config = await redisClient.config('GET', 'notify-keyspace-events');
  console.log('Current notify-keyspace-events:', config[1]);
});

redisSubscriber.on('connect', () => {
  console.log('🔗 Kết nối Redis thành công (redisSubscriber)!');
});

redisClient.on('error', (err) => {
  console.error('Lỗi kết nối Redis (redisClient):', err);
});

redisSubscriber.on('error', (err) => {
  console.error('Lỗi kết nối Redis (redisSubscriber):', err);
});

console.log('redisClient initialized:', redisClient);
console.log('setEx available after init:', typeof redisClient.set === 'function');

module.exports = { redisClient, redisSubscriber };