const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Queue = require('bull');
const { redisClient } = require('./config/redis');
const { transcribe, s3, dynamoDB } = require('./config/aws.config');
const { corsOptions } = require('./config/cors');
const logger = require('./config/logger');
const { processTranscribeJob } = require('./services/transcribe.service');
const { verifyToken } = require('./services/auth.service'); // Giả sử có auth.service.js

let ioInstance;
let transcribeQueue;

const initializeSocket = (server) => {
  ioInstance = new Server(server, {
    cors: corsOptions, // Sử dụng cấu hình CORS chung
    adapter: createAdapter(redisClient, redisClient.duplicate()),
  });

  logger.info('[SOCKET] Socket.IO server initialized');

  // Middleware xác thực Socket.IO
  ioInstance.use(async (socket, next) => {
    try {
      // Cho phép sự kiện 'join' xử lý xác thực riêng
      if (socket.handshake.query.event === 'join') {
        return next();
      }
      // Yêu cầu token cho các sự kiện khác
      const token = socket.handshake.auth.token;
      if (!token) {
        throw new Error('Token không được cung cấp');
      }
      const { id } = await verifyToken(token);
      socket.userId = id; // Lưu userId vào socket
      next();
    } catch (error) {
      logger.error('[SOCKET] Socket authentication error', { error: error.message });
      next(new Error('Xác thực thất bại'));
    }
  });

  // Khởi tạo queue xử lý transcription
  transcribeQueue = new Queue('transcribe-queue', {
    redis: { client: redisClient },
  });

  // Xử lý job trong queue
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

    await job.remove(); // Xóa job sau khi hoàn thành
  });

  // Xử lý sự kiện queue
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