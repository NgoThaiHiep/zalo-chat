const { Server } = require('socket.io');
const logger = require('./config/logger');
const { createAdapter } = require('@socket.io/redis-adapter');
const { redisClient } = require('./config/redis');

let ioInstance = null;

const initializeSocket = (server) => {
  if (ioInstance) {
    logger.warn('[Socket] Socket.IO already initialized, returning existing instance');
    return ioInstance;
  }

  ioInstance = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Thiết lập Redis adapter
  ioInstance.adapter(createAdapter(redisClient.duplicate(), redisClient.duplicate()));

  logger.info('[Socket] Socket.IO initialized with Redis Adapter');
  return ioInstance;
};

const getSocketInstance = () => {
  if (!ioInstance) {
    throw new Error('[Socket] Socket.IO not initialized. Call initializeSocket first.');
  }
  return ioInstance;
};

module.exports = { initializeSocket, getSocketInstance };