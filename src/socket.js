const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Queue = require('bull');
const { redisClient } = require('./config/redis');
const { corsOptions } = require('./config/cors');
const logger = require('./config/logger');
const { processTranscribeJob } = require('./services/transcribe.service');
const { verifyToken } = require('./services/auth.service');

let ioInstance;
let transcribeQueue;
let reminderQueue;

const initializeSocket = (server) => {
  ioInstance = new Server(server, {
    cors: corsOptions,
    adapter: createAdapter(redisClient, redisClient.duplicate()),
  });

  logger.info('[SOCKET] Socket.IO server initialized');

  // Global authentication middleware
  ioInstance.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token || typeof token !== 'string') {
        throw new Error('Token không được cung cấp hoặc không hợp lệ');
      }
      const { id } = await verifyToken(token);
      socket.userId = id;
      socket.join(id); // Join user-specific room
      next();
    } catch (error) {
      logger.error('[SOCKET] Socket authentication error', { error: error.message });
      next(new Error('Xác thực thất bại'));
    }
  });

  // Initialize queues
  transcribeQueue = new Queue('transcribe-queue', {
    redis: { client: redisClient },
  });

  reminderQueue = new Queue('reminder-queue', {
    redis: { client: redisClient },
  });

  // Process transcription jobs
  transcribeQueue.process(async (job) => {
    const { messageId, senderId, receiverId, tableName, bucketName } = job.data;
    logger.info('[SOCKET] Processing transcribe job', { jobId: job.id, messageId });
    await processTranscribeJob({
      messageId,
      senderId,
      receiverId,
      tableName,
      bucketName,
      io: ioInstance,
    });
    await job.remove();
  });

  transcribeQueue.on('failed', (job, err) => {
    logger.error('[SOCKET] Transcribe job failed', { jobId: job.id, error: err.message });
  });

  transcribeQueue.on('completed', (job) => {
    logger.info('[SOCKET] Transcribe job completed', { jobId: job.id });
  });

  return ioInstance;
};

module.exports = {
  initializeSocket,
  io: () => {
    if (!ioInstance) throw new Error('Socket.IO chưa được khởi tạo');
    return ioInstance;
  },
  transcribeQueue: () => {
    if (!transcribeQueue) throw new Error('Transcribe queue chưa được khởi tạo');
    return transcribeQueue;
  },
  reminderQueue: () => {
    if (!reminderQueue) throw new Error('Reminder queue chưa được khởi tạo');
    return reminderQueue;
  },
};