const { io } = require('../socket');
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

const initializeConversationSocket = (socket) => {
  logger.info('[CONVERSATION_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

  socket.use(([event], next) => {
    if (!socket.userId) {
      logger.warn('[CONVERSATION_SOCKET] Unauthorized access attempt', { event });
      return next(new Error('Chưa xác thực!'));
    }
    next();
  });

  socket.on('hideConversation', async ({ hiddenUserId, password }) => {
    try {
      if (!hiddenUserId || !password || typeof hiddenUserId !== 'string') {
        throw new Error('Thiếu hoặc hiddenUserId/password không hợp lệ!');
      }
      if (password.length < 6) {
        throw new Error('Mật khẩu phải có ít nhất 6 ký tự!');
      }
      await hideConversation(socket.userId, hiddenUserId, password);
      logger.info('[CONVERSATION_SOCKET] Conversation hidden', { userId: socket.userId, hiddenUserId });
      // Không cần emit vì hideConversation đã emit 'conversationHidden' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error hiding conversation', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unhideConversation', async ({ hiddenUserId, password }) => {
    try {
      if (!hiddenUserId || !password || typeof hiddenUserId !== 'string') {
        throw new Error('Thiếu hoặc hiddenUserId/password không hợp lệ!');
      }
      await unhideConversation(socket.userId, hiddenUserId, password);
      logger.info('[CONVERSATION_SOCKET] Conversation unhidden', { userId: socket.userId, hiddenUserId });
      // Không cần emit vì unhideConversation đã emit 'conversationUnhidden' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error unhiding conversation', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getHiddenConversations', async () => {
    try {
      const result = await getHiddenConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched hidden conversations', { userId: socket.userId });
      socket.emit('getHiddenConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching hidden conversations', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('muteConversation', async ({ mutedUserId, duration }) => {
    try {
      if (!mutedUserId || !duration || typeof mutedUserId !== 'string') {
        throw new Error('Thiếu hoặc mutedUserId/duration không hợp lệ!');
      }
      if (!['off', '1h', '3h', '8h', 'on'].includes(duration)) {
        throw new Error('Tùy chọn mute không hợp lệ! Chọn: off, 1h, 3h, 8h, on');
      }
      await muteConversation(socket.userId, mutedUserId, duration);
      logger.info('[CONVERSATION_SOCKET] Conversation muted', { userId: socket.userId, mutedUserId, duration });
      // Không cần emit vì muteConversation đã emit 'conversationMuted' hoặc 'conversationUnmuted' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error muting conversation', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('checkMuteStatus', async ({ mutedUserId }) => {
    try {
      if (!mutedUserId || typeof mutedUserId !== 'string') {
        throw new Error('Thiếu hoặc mutedUserId không hợp lệ!');
      }
      const result = await checkMuteStatus(socket.userId, mutedUserId);
      logger.info('[CONVERSATION_SOCKET] Checked mute status', { userId: socket.userId, mutedUserId });
      socket.emit('checkMuteStatusSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error checking mute status', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getMutedConversations', async () => {
    try {
      const result = await getMutedConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched muted conversations', { userId: socket.userId });
      socket.emit('getMutedConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching muted conversations', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('pinConversation', async ({ pinnedUserId }) => {
    try {
      if (!pinnedUserId || typeof pinnedUserId !== 'string') {
        throw new Error('Thiếu hoặc pinnedUserId không hợp lệ!');
      }
      await pinConversation(socket.userId, pinnedUserId);
      logger.info('[CONVERSATION_SOCKET] Conversation pinned', { userId: socket.userId, pinnedUserId });
      // Không cần emit vì pinConversation đã emit 'conversationPinned' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error pinning conversation', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unpinConversation', async ({ pinnedUserId }) => {
    try {
      if (!pinnedUserId || typeof pinnedUserId !== 'string') {
        throw new Error('Thiếu hoặc pinnedUserId không hợp lệ!');
      }
      await unpinConversation(socket.userId, pinnedUserId);
      logger.info('[CONVERSATION_SOCKET] Conversation unpinned', { userId: socket.userId, pinnedUserId });
      // Không cần emit vì unpinConversation đã emit 'conversationUnpinned' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error unpinning conversation', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getPinnedConversations', async () => {
    try {
      const result = await getPinnedConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched pinned conversations', { userId: socket.userId });
      socket.emit('getPinnedConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching pinned conversations', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('setAutoDeleteSetting', async ({ targetUserId, autoDeleteAfter }) => {
    try {
      if (!targetUserId || !autoDeleteAfter || typeof targetUserId !== 'string') {
        throw new Error('Thiếu hoặc targetUserId/autoDeleteAfter không hợp lệ!');
      }
      if (!['10s', '60s', '1d', '3d', '7d', 'never'].includes(autoDeleteAfter)) {
        throw new Error('Giá trị autoDeleteAfter không hợp lệ! Chọn: 10s, 60s, 1d, 3d, 7d, never');
      }
      await setAutoDeleteSetting(socket.userId, targetUserId, autoDeleteAfter);
      logger.info('[CONVERSATION_SOCKET] Auto-delete setting updated', { userId: socket.userId, targetUserId, autoDeleteAfter });
      // Không cần emit vì setAutoDeleteSetting đã emit 'autoDeleteSettingUpdated' trong conversation.service.js
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error setting auto-delete', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('getAutoDeleteSetting', async ({ targetUserId }) => {
    try {
      if (!targetUserId || typeof targetUserId !== 'string') {
        throw new Error('Thiếu hoặc targetUserId không hợp lệ!');
      }
      const result = await getAutoDeleteSetting(socket.userId, targetUserId);
      logger.info('[CONVERSATION_SOCKET] Fetched auto-delete setting', { userId: socket.userId, targetUserId });
      socket.emit('getAutoDeleteSettingSuccess', { success: true, autoDeleteAfter: result });
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching auto-delete setting', { userId: socket.userId, error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

 
  socket.on('disconnect', () => {
    logger.info('[CONVERSATION_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
  });
};

module.exports = { initializeConversationSocket };