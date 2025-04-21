const {
  hideConversation,
  unhideConversation,
  getHiddenConversations,
  muteConversation,
  checkMuteStatus,
  getMutedConversations,
  pinConversation,
  unpinConversation,
  getPinnedConversations,
  getAutoDeleteSetting,
  setAutoDeleteSetting,
} = require('../services/conversation.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('[CONVERSATION_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

   
    socket.on('hideConversation', async ({ hiddenUserId, password }, callback) => {
      try {
        if (!hiddenUserId || !password || typeof hiddenUserId !== 'string') {
          throw new AppError('Thiếu hoặc hiddenUserId/password không hợp lệ!', 400);
        }
        if (password.length < 8 || !/[!@#$%^&*]/.test(password)) {
          throw new AppError('Mật khẩu phải có ít nhất 8 ký tự và chứa ký tự đặc biệt!', 400);
        }
        const result = await hideConversation(socket.userId, hiddenUserId, password);
        logger.info('[CONVERSATION_SOCKET] Hid conversation', { userId: socket.userId, hiddenUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to hide conversation', { userId: socket.userId, hiddenUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unhideConversation', async ({ hiddenUserId, password }, callback) => {
      try {
        if (!hiddenUserId || !password || typeof hiddenUserId !== 'string') {
          throw new AppError('Thiếu hoặc hiddenUserId/password không hợp lệ!', 400);
        }
        const result = await unhideConversation(socket.userId, hiddenUserId, password);
        logger.info('[CONVERSATION_SOCKET] Unhid conversation', { userId: socket.userId, hiddenUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to unhide conversation', { userId: socket.userId, hiddenUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getHiddenConversations', async (callback) => {
      try {
        const result = await getHiddenConversations(socket.userId);
        logger.info('[CONVERSATION_SOCKET] Got hidden conversations', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to get hidden conversations', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('muteConversation', async ({ mutedUserId, duration }, callback) => {
      try {
        if (!mutedUserId || !duration || typeof mutedUserId !== 'string') {
          throw new AppError('Thiếu hoặc mutedUserId/duration không hợp lệ!', 400);
        }
        if (!['off', '1h', '3h', '8h', 'on'].includes(duration)) {
          throw new AppError('Tùy chọn mute không hợp lệ! Chọn: off, 1h, 3h, 8h, on', 400);
        }
        const result = await muteConversation(socket.userId, mutedUserId, duration);
        logger.info('[CONVERSATION_SOCKET] Muted conversation', { userId: socket.userId, mutedUserId, duration });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to mute conversation', { userId: socket.userId, mutedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('checkMuteStatus', async ({ mutedUserId }, callback) => {
      try {
        if (!mutedUserId || typeof mutedUserId !== 'string') {
          throw new AppError('Thiếu hoặc mutedUserId không hợp lệ!', 400);
        }
        const result = await checkMuteStatus(socket.userId, mutedUserId);
        logger.info('[CONVERSATION_SOCKET] Checked mute status', { userId: socket.userId, mutedUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to check mute status', { userId: socket.userId, mutedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getMutedConversations', async (callback) => {
      try {
        const result = await getMutedConversations(socket.userId);
        logger.info('[CONVERSATION_SOCKET] Got muted conversations', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to get muted conversations', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('pinConversation', async ({ pinnedUserId }, callback) => {
      try {
        if (!pinnedUserId || typeof pinnedUserId !== 'string') {
          throw new AppError('Thiếu hoặc pinnedUserId không hợp lệ!', 400);
        }
        const result = await pinConversation(socket.userId, pinnedUserId);
        logger.info('[CONVERSATION_SOCKET] Pinned conversation', { userId: socket.userId, pinnedUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to pin conversation', { userId: socket.userId, pinnedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unpinConversation', async ({ pinnedUserId }, callback) => {
      try {
        if (!pinnedUserId || typeof pinnedUserId !== 'string') {
          throw new AppError('Thiếu hoặc pinnedUserId không hợp lệ!', 400);
        }
        const result = await unpinConversation(socket.userId, pinnedUserId);
        logger.info('[CONVERSATION_SOCKET] Unpinned conversation', { userId: socket.userId, pinnedUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to unpin conversation', { userId: socket.userId, pinnedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getPinnedConversations', async (callback) => {
      try {
        const result = await getPinnedConversations(socket.userId);
        logger.info('[CONVERSATION_SOCKET] Got pinned conversations', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to get pinned conversations', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('setAutoDeleteSetting', async ({ targetUserId, autoDeleteAfter }, callback) => {
      try {
        if (!targetUserId || !autoDeleteAfter || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId/autoDeleteAfter không hợp lệ!', 400);
        }
        if (!['10s', '60s', '1d', '3d', '7d', 'never'].includes(autoDeleteAfter)) {
          throw new AppError('Giá trị autoDeleteAfter không hợp lệ! Chọn: 10s, 60s, 1d, 3d, 7d, never', 400);
        }
        const result = await setAutoDeleteSetting(socket.userId, targetUserId, autoDeleteAfter);
        logger.info('[CONVERSATION_SOCKET] Set auto-delete setting', { userId: socket.userId, targetUserId, autoDeleteAfter });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to set auto-delete setting', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getAutoDeleteSetting', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc target conquerId không hợp lệ!', 400);
        }
        const result = await getAutoDeleteSetting(socket.userId, targetUserId);
        logger.info('[CONVERSATION_SOCKET] Got auto-delete setting', { userId: socket.userId, targetUserId });
        callback({ success: true, data: { autoDeleteAfter: result } });
      } catch (error) {
        logger.error('[CONVERSATION_SOCKET] Failed to get auto-delete setting', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('disconnect', () => {
      logger.info('[CONVERSATION_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
    });
  });
};