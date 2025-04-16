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
    if (!socket.userId) {
      logger.warn('[CHAT_SOCKET] Unauthorized access attempt', { event });
      return next(new Error('Chưa xác thực!'));
    }
    next();
  });

  // Xử lý lỗi socket
  socket.on('error', (error) => {
    logger.error('[CHAT_SOCKET] Socket error', { socketId: socket.id, userId: socket.userId, error: error.message });
  });

  // Tham gia room ngay khi kết nối
  socket.join(socket.userId);
  updateMessageStatusOnConnect(socket.userId).catch((error) => {
    logger.error('[CHAT_SOCKET] Error updating message status on connect', { userId: socket.userId, error: error.message });
  });

  // Xử lý sự kiện typing
  const emitTyping = debounce(({ receiverId }) => {
    if (receiverId && typeof receiverId === 'string') {
      io().to(receiverId).emit('userTyping', { senderId: socket.userId });
    }
  }, 500);

  socket.on('typing', ({ receiverId }) => {
    if (!receiverId) {
      socket.emit('error', { message: 'Thiếu receiverId!' });
      return;
    }
    emitTyping({ receiverId });
  });

  socket.on('stopTyping', ({ receiverId }) => {
    if (receiverId && typeof receiverId === 'string') {
      io().to(receiverId).emit('userStoppedTyping', { senderId: socket.userId });
    }
  });

  socket.on('sendMessage', async ({ receiverId, type, content, file, fileName, mimeType, metadata, isAnonymous, isSecret, quality, expiresAfter }) => {
    try {
      if (!receiverId || !type) {
        throw new Error('Thiếu receiverId hoặc type!');
      }
      if (!['text', 'image', 'video', 'voice', 'file','gif'].includes(type)) {
        throw new Error('Loại tin nhắn không hợp lệ!');
      }
      if (type === 'text' && (!content || typeof content !== 'string')) {
        throw new Error('Nội dung tin nhắn văn bản không hợp lệ!');
      }
      if (['image', 'video', 'voice', 'file','gif'].includes(type) && !file) {
        throw new Error('File là bắt buộc cho tin nhắn media!');
      }
      if (file) {
        const buffer = Buffer.from(file, 'base64');
        if (buffer.length > 10 * 1024 * 1024) { // Giới hạn 10MB
          throw new Error('File vượt quá kích thước cho phép (10MB)!');
        }
      }

      const messagePayload = {
        type,
        content: content || null,
        file: file ? Buffer.from(file, 'base64') : null,
        fileName: fileName || null,
        mimeType: mimeType || null,
        metadata: metadata && typeof metadata === 'string' ? JSON.parse(metadata) : metadata || null,
        isAnonymous: !!isAnonymous,
        isSecret: !!isSecret,
        quality: quality || 'original',
        expiresAfter: expiresAfter && Number.isInteger(expiresAfter) ? expiresAfter : null,
      };

      const savedMessage = await createMessage(socket.userId, receiverId, messagePayload);
      logger.info('[CHAT_SOCKET] Message sent', { messageId: savedMessage.messageId, senderId: socket.userId, receiverId });
      // Không cần emit vì createMessage đã emit 'receiveMessage' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error sending message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('recallMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await recallMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message recalled', { messageId, userId: socket.userId });
      // Không cần emit vì recallMessage đã emit 'messageRecalled' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error recalling message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('pinMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await pinMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message pinned', { messageId, userId: socket.userId });
      // Không cần emit vì pinMessage đã emit 'messagePinned' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error pinning message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unpinMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await unpinMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message unpinned', { messageId, userId: socket.userId });
      // Không cần emit vì unpinMessage đã emit 'messageUnpinned' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error unpinning message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getPinnedMessages', async ({ otherUserId }) => {
    try {
      if (!otherUserId || typeof otherUserId !== 'string') {
        throw new Error('Thiếu hoặc otherUserId không hợp lệ!');
      }
      const result = await getPinnedMessages(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched pinned messages', { userId: socket.userId, otherUserId });
      socket.emit('getPinnedMessagesSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching pinned messages', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('deleteMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await deleteMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message deleted', { messageId, userId: socket.userId });
      // Không cần emit vì deleteMessage đã emit 'messageDeleted' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error deleting message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('restoreMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await restoreMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message restored', { messageId, userId: socket.userId });
      // Không cần emit vì restoreMessage đã emit 'messageRestored' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error restoring message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('forwardMessage', async ({ messageId, targetReceiverId }) => {
    try {
      if (!messageId || !targetReceiverId || typeof messageId !== 'string' || typeof targetReceiverId !== 'string') {
        throw new Error('Thiếu hoặc messageId/targetReceiverId không hợp lệ!');
      }
      await forwardMessage(socket.userId, messageId, targetReceiverId);
      logger.info('[CHAT_SOCKET] Message forwarded', { messageId, userId: socket.userId, targetReceiverId });
      // Không cần emit vì forwardMessage đã emit 'receiveMessage' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error forwarding message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('retryMessage', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await retryMessage(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message retried', { messageId, userId: socket.userId });
      // Không cần emit vì retryMessage đã emit 'receiveMessage' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error retrying message', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('markMessageAsSeen', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await markMessageAsSeen(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Message marked as seen', { messageId, userId: socket.userId });
      // Không cần emit vì markMessageAsSeen đã emit 'messageStatus' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error marking message as seen', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getMessagesBetweenUsers', async ({ otherUserId, limit = 100, lastEvaluatedKey }) => {
    try {
      if (!otherUserId || typeof otherUserId !== 'string') {
        throw new Error('Thiếu hoặc otherUserId không hợp lệ!');
      }
      if (limit && (!Number.isInteger(limit) || limit <= 0 || limit > 100)) {
        throw new Error('Limit không hợp lệ, phải từ 1 đến 100!');
      }
      const result = await getMessagesBetweenUsers(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched messages between users', { userId: socket.userId, otherUserId });
      socket.emit('getMessagesBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching messages', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getConversationSummary', async ({ minimal = false }) => {
    try {
      const result = await getConversationSummary(socket.userId, { minimal });
      logger.info('[CHAT_SOCKET] Fetched conversation summary', { userId: socket.userId });
      socket.emit('getConversationSummarySuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching conversation summary', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('setReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }) => {
    try {
      if (!messageId || !reminder || !scope || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId/reminder/scope không hợp lệ!');
      }
      if (!['onlyMe', 'both'].includes(scope)) {
        throw new Error('Scope phải là "onlyMe" hoặc "both"!');
      }
      if (new Date(reminder) <= new Date()) {
        throw new Error('Thời gian nhắc nhở phải ở tương lai!');
      }
      await setReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
      logger.info('[CHAT_SOCKET] Reminder set', { messageId, userId: socket.userId });
      // Không cần emit vì setReminder đã emit 'reminderSet' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error setting reminder', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unsetReminder', async ({ messageId }) => {
    try {
      if (!messageId || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId không hợp lệ!');
      }
      await unsetReminder(socket.userId, messageId);
      logger.info('[CHAT_SOCKET] Reminder unset', { messageId, userId: socket.userId });
      // Không cần emit vì unsetReminder đã emit 'reminderUnset' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error unsetting reminder', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getRemindersBetweenUsers', async ({ otherUserId }) => {
    try {
      if (!otherUserId || typeof otherUserId !== 'string') {
        throw new Error('Thiếu hoặc otherUserId không hợp lệ!');
      }
      const result = await getRemindersBetweenUsers(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched reminders between users', { userId: socket.userId, otherUserId });
      socket.emit('getRemindersBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching reminders', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getReminderHistory', async ({ otherUserId }) => {
    try {
      if (!otherUserId || typeof otherUserId !== 'string') {
        throw new Error('Thiếu hoặc otherUserId không hợp lệ!');
      }
      const result = await getReminderHistory(socket.userId, otherUserId);
      logger.info('[CHAT_SOCKET] Fetched reminder history', { userId: socket.userId, otherUserId });
      socket.emit('getReminderHistorySuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error fetching reminder history', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('editReminder', async ({ messageId, reminder, scope, reminderContent, repeat, daysOfWeek }) => {
    try {
      if (!messageId || !reminder || !scope || typeof messageId !== 'string') {
        throw new Error('Thiếu hoặc messageId/reminder/scope không hợp lệ!');
      }
      if (!['onlyMe', 'both'].includes(scope)) {
        throw new Error('Scope phải là "onlyMe" hoặc "both"!');
      }
      if (new Date(reminder) <= new Date()) {
        throw new Error('Thời gian nhắc nhở phải ở tương lai!');
      }
      await editReminder(socket.userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek);
      logger.info('[CHAT_SOCKET] Reminder edited', { messageId, userId: socket.userId });
      // Không cần emit vì editReminder đã emit 'reminderEdited' trong message.service.js
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error editing reminder', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('searchMessagesBetweenUsers', async ({ otherUserId, keyword }) => {
    try {
      if (!otherUserId || !keyword || typeof otherUserId !== 'string' || typeof keyword !== 'string') {
        throw new Error('Thiếu hoặc otherUserId/keyword không hợp lệ!');
      }
      if (keyword.trim().length === 0) {
        throw new Error('Keyword không được rỗng!');
      }
      const result = await searchMessagesBetweenUsers(socket.userId, otherUserId, keyword);
      logger.info('[CHAT_SOCKET] Searched messages', { userId: socket.userId, otherUserId, keyword });
      socket.emit('searchMessagesBetweenUsersSuccess', result);
    } catch (error) {
      logger.error('[CHAT_SOCKET] Error searching messages', { userId: socket.userId, error: error.message });
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
  }, 60 * 1000); // Chạy mỗi 1 phút
};

module.exports = { initializeChatSocket, setupReminderCheck };