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
  setAutoDeleteSetting,
  getAutoDeleteSetting,
} = require('../services/conversation.service');
const logger = require('../config/logger');

const initializeConversationSocket = (socket) => {
  logger.info('[CONVERSATION_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

  // Middleware xác thực
  socket.use(([event], next) => {
    if (!socket.userId) return next(new Error('Chưa xác thực!'));
    next();
  });

  // Xử lý lỗi socket
  socket.on('error', (error) => {
    logger.error('[CONVERSATION_SOCKET] Socket error', { socketId: socket.id, error: error.message });
    socket.emit('error', { message: error.message });
  });

  // Ẩn hội thoại
  socket.on('hideConversation', async ({ hiddenUserId, password }) => {
    try {
      const result = await hideConversation(socket.userId, hiddenUserId, password);
      logger.info('[CONVERSATION_SOCKET] Conversation hidden', { userId: socket.userId, hiddenUserId });
      socket.emit('hideConversationSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error hiding conversation', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Bỏ ẩn hội thoại
  socket.on('unhideConversation', async ({ hiddenUserId, password }) => {
    try {
      const result = await unhideConversation(socket.userId, hiddenUserId, password);
      logger.info('[CONVERSATION_SOCKET] Conversation unhidden', { userId: socket.userId, hiddenUserId });
      socket.emit('unhideConversationSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error unhiding conversation', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách hội thoại ẩn
  socket.on('getHiddenConversations', async () => {
    try {
      const result = await getHiddenConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched hidden conversations', { userId: socket.userId });
      socket.emit('getHiddenConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching hidden conversations', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Mute hội thoại
  socket.on('muteConversation', async ({ mutedUserId, duration }) => {
    try {
      const result = await muteConversation(socket.userId, mutedUserId, duration);
      logger.info('[CONVERSATION_SOCKET] Conversation muted', { userId: socket.userId, mutedUserId, duration });
      socket.emit('muteConversationSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error muting conversation', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Kiểm tra trạng thái mute
  socket.on('checkMuteStatus', async ({ mutedUserId }) => {
    try {
      const result = await checkMuteStatus(socket.userId, mutedUserId);
      logger.info('[CONVERSATION_SOCKET] Checked mute status', { userId: socket.userId, mutedUserId });
      socket.emit('checkMuteStatusSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error checking mute status', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách hội thoại mute
  socket.on('getMutedConversations', async () => {
    try {
      const result = await getMutedConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched muted conversations', { userId: socket.userId });
      socket.emit('getMutedConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching muted conversations', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Ghim hội thoại
  socket.on('pinConversation', async ({ pinnedUserId }) => {
    try {
      const result = await pinConversation(socket.userId, pinnedUserId);
      logger.info('[CONVERSATION_SOCKET] Conversation pinned', { userId: socket.userId, pinnedUserId });
      socket.emit('pinConversationSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error pinning conversation', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Bỏ ghim hội thoại
  socket.on('unpinConversation', async ({ pinnedUserId }) => {
    try {
      const result = await unpinConversation(socket.userId, pinnedUserId);
      logger.info('[CONVERSATION_SOCKET] Conversation unpinned', { userId: socket.userId, pinnedUserId });
      socket.emit('unpinConversationSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error unpinning conversation', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách hội thoại ghim
  socket.on('getPinnedConversations', async () => {
    try {
      const result = await getPinnedConversations(socket.userId);
      logger.info('[CONVERSATION_SOCKET] Fetched pinned conversations', { userId: socket.userId });
      socket.emit('getPinnedConversationsSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching pinned conversations', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Đặt cài đặt tự động xóa
  socket.on('setAutoDeleteSetting', async ({ targetUserId, autoDeleteAfter }) => {
    try {
      const result = await setAutoDeleteSetting(socket.userId, targetUserId, autoDeleteAfter);
      logger.info('[CONVERSATION_SOCKET] Auto-delete setting updated', { userId: socket.userId, targetUserId, autoDeleteAfter });
      socket.emit('setAutoDeleteSettingSuccess', result);
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error setting auto-delete', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy cài đặt tự động xóa
  socket.on('getAutoDeleteSetting', async ({ targetUserId }) => {
    try {
      const result = await getAutoDeleteSetting(socket.userId, targetUserId);
      logger.info('[CONVERSATION_SOCKET] Fetched auto-delete setting', { userId: socket.userId, targetUserId });
      socket.emit('getAutoDeleteSettingSuccess', { success: true, autoDeleteAfter: result });
    } catch (error) {
      logger.error('[CONVERSATION_SOCKET] Error fetching auto-delete setting', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info('[CONVERSATION_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
  });
};

module.exports = { initializeConversationSocket };