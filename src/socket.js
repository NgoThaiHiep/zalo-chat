const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Queue = require('bull');
const { redisClient } = require('./config/redis');
const { corsOptions } = require('./config/cors');
const logger = require('./config/logger');
const { processTranscribeJob } = require('./services/transcribe.service');
const { verifyToken, setUserOnline, setUserOffline } = require('./services/auth.service');

let ioInstance;
let transcribeQueue;

const initializeSocket = (server) => {
  ioInstance = new Server(server, {
    cors: corsOptions,
    adapter: createAdapter(redisClient, redisClient.duplicate()),
  });

  logger.info('[SOCKET] Socket.IO server initialized');

  // Middleware xác thực
  ioInstance.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token || typeof token !== 'string') {
        return next(new Error('INVALID_TOKEN'));
      }
      const { id } = await verifyToken(token);
      socket.userId = id;
      socket.join(id); // Join user-specific room
      next();
    } catch (error) {
      logger.error('[SOCKET] Socket authentication error', { error: error.message });
      next(new Error('AUTH_FAILED'));
    }
  });

  // Xử lý sự kiện connection
  ioInstance.on('connection', async (socket) => {
    const userId = socket.userId;
    logger.info('[SOCKET] User connected', { userId });

    // Cập nhật trạng thái online
    await setUserOnline(userId);
    ioInstance.to(userId).emit('onlineStatus', { userId, online: true });

    // Xử lý ngắt kết nối
    socket.on('disconnect', async () => {
      logger.info('[SOCKET] User disconnected', { userId });
      await setUserOffline(userId);
      ioInstance.to(userId).emit('onlineStatus', { userId, online: false });
    });
  });

  // Khởi tạo hàng đợi
  transcribeQueue = new Queue('transcribe-queue', {
    redis: { client: redisClient },
    defaultJobOptions: {
      attempts: 3, // Thử lại tối đa 3 lần nếu thất bại
      backoff: { type: 'exponential', delay: 1000 }, // Delay tăng dần
    },
  });

  // Xử lý công việc phiên âm
  transcribeQueue.process(5, async (job) => { // Giới hạn 5 job đồng thời
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
};