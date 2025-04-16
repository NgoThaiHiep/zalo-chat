const MessageService = require('../services/message.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');
const { debounce } = require('lodash');
const { reminderQueue } = require('../socket');

module.exports = (io) => {
  // Setup reminder check using Bull Queue
  const setupReminderCheck = () => {
    try {
      const queue = reminderQueue(); // Call the getter to retrieve the queue instance
      queue.process(async (job) => {
        try {
          await MessageService.checkAndNotifyReminders();
          logger.info('[CHAT_SOCKET] Reminder check executed');
        } catch (error) {
          logger.error('[CHAT_SOCKET] Reminder check failed', { error: error.message });
        }
      });

      // Schedule recurring job
      queue.add({}, { repeat: { every: 60 * 1000 } });
      logger.info('[CHAT_SOCKET] Reminder queue initialized');
    } catch (error) {
      logger.error('[CHAT_SOCKET] Failed to initialize reminder queue', { error: error.message });
    }
  };

  // Defer setup to ensure queue is initialized
  setImmediate(setupReminderCheck);

  io.on('connection', (socket) => {
    logger.info('[CHAT_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

    // Update message status to delivered
    MessageService.updateMessageStatusOnConnect(socket.userId).catch((error) => {
      logger.error('[CHAT_SOCKET] Failed to update message status', { userId: socket.userId, error: error.message });
    });

    socket.on('sendMessage', async ({ receiverId, messageData }, callback) => {
      try {
        if (!receiverId || typeof receiverId !== 'string') {
          throw new AppError('receiverId không hợp lệ hoặc thiếu', 400);
        }
        if (!messageData || typeof messageData !== 'object') {
          throw new AppError('messageData không hợp lệ hoặc thiếu', 400);
        }
        if (messageData.file && Buffer.isBuffer(messageData.file) && messageData.file.length > 10 * 1024 * 1024) {
          throw new AppError('File vượt quá giới hạn 10MB', 400);
        }
        const result = await MessageService.createMessage(socket.userId, receiverId, messageData);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to send message', { userId: socket.userId, receiverId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('retryMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.retryMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to retry message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('markMessageAsSeen', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.markMessageAsSeen(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to mark message as seen', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('recallMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.recallMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to recall message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getMessagesBetweenUsers', async ({ otherUserId }, callback) => {
      try {
        if (!otherUserId || typeof otherUserId !== 'string') {
          throw new AppError('otherUserId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.getMessagesBetweenUsers(socket.userId, otherUserId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to get messages', { userId: socket.userId, otherUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('forwardMessage', async ({ messageId, targetReceiverId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string' || !targetReceiverId || typeof targetReceiverId !== 'string') {
          throw new AppError('messageId hoặc targetReceiverId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.forwardMessage(socket.userId, messageId, targetReceiverId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to forward message', { userId: socket.userId, messageId, targetReceiverId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('pinMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.pinMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to pin message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unpinMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.unpinMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to unpin message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getPinnedMessages', async ({ otherUserId }, callback) => {
      try {
        if (!otherUserId || typeof otherUserId !== 'string') {
          throw new AppError('otherUserId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.getPinnedMessages(socket.userId, otherUserId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to get pinned messages', { userId: socket.userId, otherUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('setReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        if (!reminder || isNaN(new Date(reminder).getTime())) {
          throw new AppError('reminder không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.setReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to set reminder', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unsetReminder', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.unsetReminder(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to unset reminder', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('editReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        if (!reminder || isNaN(new Date(reminder).getTime())) {
          throw new AppError('reminder không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.editReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to edit reminder', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getRemindersBetweenUsers', async ({ otherUserId }, callback) => {
      try {
        if (!otherUserId || typeof otherUserId !== 'string') {
          throw new AppError('otherUserId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.getRemindersBetweenUsers(socket.userId, otherUserId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to get reminders', { userId: socket.userId, otherUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getReminderHistory', async ({ otherUserId }, callback) => {
      try {
        if (!otherUserId || typeof otherUserId !== 'string') {
          throw new AppError('otherUserId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.getReminderHistory(socket.userId, otherUserId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to get reminder history', { userId: socket.userId, otherUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('deleteMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.deleteMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to delete message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('restoreMessage', async ({ messageId }, callback) => {
      try {
        if (!messageId || typeof messageId !== 'string') {
          throw new AppError('messageId không hợp lệ hoặc thiếu', 400);
        }
        const result = await MessageService.restoreMessage(socket.userId, messageId);
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to restore message', { userId: socket.userId, messageId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    const debouncedTyping = debounce((receiverId) => {
      socket.to(receiverId).emit('typing', { senderId: socket.userId });
    }, 500);

    socket.on('typing', ({ receiverId }) => {
      try {
        if (!receiverId || typeof receiverId !== 'string') {
          throw new AppError('receiverId không hợp lệ hoặc thiếu', 400);
        }
        debouncedTyping(receiverId);
      } catch (error) {
        logger.error('[CHAT_SOCKET] Failed to process typing event', { userId: socket.userId, receiverId, error: error.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info('[CHAT_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
    });
  });
};