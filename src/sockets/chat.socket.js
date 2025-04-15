const { io } = require('../socket');
const {
  createMessage,
  recallMessage,
  pinMessage,
  deleteMessage,
  restoreMessage,
  forwardMessage,
  updateMessageStatusOnConnect,
  getMessagesBetweenUsers,
  getConversationSummary,
  unpinMessage,
  getPinnedMessages,
  setReminder,
  unsetReminder,
  getRemindersBetweenUsers,
  checkAndNotifyReminders,
  getReminderHistory,
  editReminder,
  retryMessage,
  markMessageAsSeen,
  searchMessagesBetweenUsers,
} = require('../services/message.service');
const logger = require('../config/logger');

// Debounce để giảm tải sự kiện typing
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const initializeChatSocket = (socket) => {
  logger.info('[CHAT_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

  // Middleware xác thực
  socket.use(([event], next) => {
    if (!socket.userId) return next(new Error('Chưa xác thực!'));
    next();
  });

  // Xử lý lỗi socket
  socket.on('error', (error) => {
    logger.error('[CHAT_SOCKET] Socket error', { socketId: socket.id, error: error.message });
    socket.emit('error', { message: error.message });
  });

  // Tham gia room ngay khi kết nối
  socket.join(socket.userId);
  updateMessageStatusOnConnect(socket.userId).catch((error) => {
    logger.error('[CHAT_SOCKET] Error updating message status on connect', { error: error.message });
  });

  // Xử lý sự kiện typing
  const emitTyping = debounce(({ receiverId }) => {
    if (receiverId) {
      io().to(receiverId).emit('userTyping', { senderId: socket.userId });
    }
  }, 500);

  socket.on('typing', emitTyping);
  socket.on('stopTyping', ({ receiverId }) => {
    if (receiverId) {
      io().to(receiverId).emit('userStoppedTyping', { senderId: socket.userId });
    }
  });

  socket.on('sendMessage', async ({ receiverId, type, content, file, fileName, mimeType, metadata, isAnonymous, isSecret, quality, expiresAfter }) => {
    try {
      if (!receiverId || !type) {
        throw new Error('Thiếu receiverId hoặc type!');
      }

      const messagePayload = {
        type,
        content: content || null,
        file: file ? Buffer.from(file, 'base64') : null,
        fileName,
        mimeType,
        metadata: metadata ? JSON.parse(metadata) : null,
        isAnonymous: isAnonymous || false,
        isSecret: isSecret || false,
        quality: quality || 'original',
        expiresAfter,
      };

      const savedMessage = await createMessage(socket.userId, receiverId, messagePayload);
      logger.info('[CHAT_SOCKET] Message sent', { messageId: savedMessage.messageId, senderId: socket.userId, receiverId });
      socket.emit('messageSent', { success: true, data: savedMessage });
      io().to(receiverId).emit('messageReceived', savedMessage); // Thông báo cho người nhận
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error sending message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('recallMessage', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await recallMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message recalled', { messageId, userId: socket.userId });
      socket.emit('recallMessageSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error recalling message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('pinMessage', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await pinMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message pinned', { messageId, userId: socket.userId });
      socket.emit('pinMessageSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error pinning message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unpinMessage', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await unpinMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message unpinned', { messageId, userId: socket.userId });
      socket.emit('unpinMessageSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error unpinning message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getPinnedMessages', async ({ otherUserId }) => {
    try {
      if (!otherUserId) throw new Error('Thiếu otherUserId!');
      const result = await getPinnedMessages(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched pinned messages', { userId: socket.userId, otherUserId });
      socket.emit('getPinnedMessagesSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching pinned messages', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('deleteMessage', async ({ messageId, deleteType }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await deleteMessage(socket.userId, messageId, deleteType);
      logger.info('[CHAT_SOCKET] Message deleted', { messageId, userId: socket.userId });
      socket.emit('deleteMessageSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error deleting message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('restoreMessage', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await restoreMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message restored', { messageId, userId: socket.userId });
      socket.emit('restoreMessageSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error restoring message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('forwardMessage', async ({ messageId, targetReceiverId }) => {
    try {
      if (!messageId || !targetReceiverId) throw new Error('Thiếu messageId hoặc targetReceiverId!');
      const result = await forwardMessage(socket.userId, messageId, targetReceiverId);
      logger.info('[CHAT_SOCKET] Message forwarded', { messageId, userId: socket.userId, targetReceiverId });
      socket.emit('forwardMessageSuccess', { success: true, message: 'Chuyển tiếp thành công!', data: result });
      io().to(targetReceiverId).emit('messageReceived', result); // Thông báo cho người nhận
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error forwarding message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('retryMessage', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await retryMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message retried', { messageId, userId: socket.userId });
      socket.emit('retryMessageSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error retrying message', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('markMessageAsSeen', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await markMessageAsSeen(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message marked as seen', { messageId, userId: socket.userId });
      socket.emit('markMessageAsSeenSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error marking message as seen', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });
  // socket.on('getMessagesBetweenUsers', async ({ otherUserId, limit = 100, offset = 0 }) => {
  socket.on('getMessagesBetweenUsers', async ({ otherUserId}) => {
    try {
      if (!otherUserId) throw new Error('Thiếu otherUserId!');
      // const result = await getMessagesBetweenUsers(socket.userId, otherUserId, { limit, offset });
      const result = await getMessagesBetweenUsers(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched messages between users', { userId: socket.userId, otherUserId });
      socket.emit('getMessagesBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching messages', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getConversationSummary', async ({ minimal = false }) => {
    try {
      const result = await getConversationSummary(socket.userId, { minimal });
      logger.info('[CHAT_SOCKET] Fetched conversation summary', { userId: socket.userId });
      socket.emit('getConversationSummarySuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching conversation summary', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('setReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }) => {
    try {
      if (!messageId || !reminder || !scope) throw new Error('Thiếu messageId, reminder, hoặc scope!');
      const result = await setReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
      logger.info('[CHAT_SOCKET] Reminder set', { messageId, userId: socket.userId });
      socket.emit('setReminderSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error setting reminder', { error: error.message });
      socket.emit('setReminderError', { success: false, message: error.message });
    }
  });

  socket.on('unsetReminder', async ({ messageId }) => {
    try {
      if (!messageId) throw new Error('Thiếu messageId!');
      const result = await unsetReminder(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Reminder unset', { messageId, userId: socket.userId });
      socket.emit('unsetReminderSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error unsetting reminder', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getRemindersBetweenUsers', async ({ otherUserId }) => {
    try {
      if (!otherUserId) throw new Error('Thiếu otherUserId!');
      const result = await getRemindersBetweenUsers(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched reminders between users', { userId: socket.userId, otherUserId });
      socket.emit('getRemindersBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching reminders', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getReminderHistory', async ({ otherUserId }) => {
    try {
      if (!otherUserId) throw new Error('Thiếu otherUserId!');
      const result = await getReminderHistory(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched reminder history', { userId: socket.userId, otherUserId });
      socket.emit('getReminderHistorySuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching reminder history', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('editReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }) => {
    try {
      if (!messageId || !reminder || !scope) throw new Error('Thiếu messageId, reminder, hoặc scope!');
      const result = await editReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
      logger.info('[CHAT_SOCKET] Reminder edited', { messageId, userId: socket.userId });
      socket.emit('editReminderSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error editing reminder', { error: error.message });
      socket.emit('editReminderError', { success: false, message: error.message });
    }
  });

  socket.on('searchMessagesBetweenUsers', async ({ otherUserId, keyword }) => {
    try {
      if (!otherUserId || !keyword) throw new Error('Thiếu otherUserId hoặc keyword!');
      const result = await searchMessagesBetweenUsers(socket.userId, otherUserId, keyword);
      logger.info('[CHAT_SOCKET] Searched messages', { userId: socket.userId, otherUserId, keyword });
      socket.emit('searchMessagesBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error searching messages', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info('[CHAT_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
  });
};

// Kiểm tra và thông báo nhắc nhở định kỳ
const setupReminderCheck = () => {
  setInterval(async () => {
    try {
      await checkAndNotifyReminders();
      logger.info('[CHAT_SOCKET] Checked and notified reminders');
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error checking reminders', { error: error.message });
    }
  }, 5 * 60 * 1000); // Chạy mỗi 5 phút để giảm tải
};

module.exports = { initializeChatSocket, setupReminderCheck };