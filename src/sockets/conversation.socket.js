const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');
const ConversationService = require('../services/conversation.service');
const { dynamoDB } = require('../config/aws.config');
const { AppError } = require('../utils/errorHandler');

const getFriends = async (userId) => {
  try {
    const result = await dynamoDB.scan({
      TableName: 'Friends',
      FilterExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();
    return result.Items.map(item => item.friendId);
  } catch (error) {
    logger.error('[ConversationSocket] Error fetching friends', { userId, error: error.message });
    throw new AppError('Failed to fetch friends', 500);
  }
};

const initializeConversationSocket = (conversationIo) => {
  conversationIo.use(authenticateSocket);

  conversationIo.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[ConversationSocket] User connected: ${userId} (Socket ID: ${socket.id})`);

    socket.join(userId);

    socket.on('conversation:mute', async ({ mutedUserId, duration }, callback) => {
      try {
        if (!mutedUserId || !duration) {
          throw new AppError('mutedUserId and duration are required', 400);
        }
        const result = await ConversationService.muteConversation(userId, mutedUserId, duration);
        callback({ success: true, data: { message: result.message, mutedUserId, muteUntil: result.muteUntil } });

        const isFriend = await dynamoDB.get({
          TableName: 'Friends',
          Key: { userId, friendId: mutedUserId },
        }).promise().then(res => !!res.Item);
        if (isFriend) {
          conversationIo.to(mutedUserId).emit('conversation:mute:notify', {
            mutedBy: userId,
            duration,
          });
        }
        logger.info(`[ConversationSocket] User ${userId} muted conversation with ${mutedUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error muting conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:hide', async ({ hiddenUserId, password }, callback) => {
      try {
        if (!hiddenUserId || !password) {
          throw new AppError('hiddenUserId and password are required', 400);
        }
        const result = await ConversationService.hideConversation(userId, hiddenUserId, password);
        callback({ success: true, data: { message: result.message, hiddenUserId } });
        logger.info(`[ConversationSocket] User ${userId} hid conversation with ${hiddenUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error hiding conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:unhide', async ({ hiddenUserId, password }, callback) => {
      try {
        if (!hiddenUserId || !password) {
          throw new AppError('hiddenUserId and password are required', 400);
        }
        const result = await ConversationService.unhideConversation(userId, hiddenUserId, password);
        callback({ success: true, data: { message: result.message, hiddenUserId } });
        logger.info(`[ConversationSocket] User ${userId} unhid conversation with ${hiddenUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error unhiding conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:pin', async ({ pinnedUserId }, callback) => {
      try {
        if (!pinnedUserId) {
          throw new AppError('pinnedUserId is required', 400);
        }
        const result = await ConversationService.pinConversation(userId, pinnedUserId);
        callback({ success: true, data: { message: result.message, pinnedUserId } });
        logger.info(`[ConversationSocket] User ${userId} pinned conversation with ${pinnedUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error pinning conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:unpin', async ({ pinnedUserId }, callback) => {
      try {
        if (!pinnedUserId) {
          throw new AppError('pinnedUserId is required', 400);
        }
        const result = await ConversationService.unpinConversation(userId, pinnedUserId);
        callback({ success: true, data: { message: result.message, pinnedUserId } });
        logger.info(`[ConversationSocket] User ${userId} unpinned conversation with ${pinnedUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error unpinning conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:setAutoDelete', async ({ targetUserId, autoDeleteAfter }, callback) => {
      try {
        if (!targetUserId || !autoDeleteAfter) {
          throw new AppError('targetUserId and autoDeleteAfter are required', 400);
        }
        const result = await ConversationService.setAutoDeleteSetting(userId, targetUserId, autoDeleteAfter);
        callback({ success: true, data: { message: result.message, targetUserId, autoDeleteAfter } });
        logger.info(`[ConversationSocket] User ${userId} set auto-delete for ${targetUserId} to ${autoDeleteAfter}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error setting auto-delete for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('conversation:create', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId) {
          throw new AppError('targetUserId is required', 400);
        }
        const result = await ConversationService.createConversation(userId, targetUserId);
        callback({
          success: true,
          data: {
            message: result.conversationId ? 'Conversation created successfully' : 'Conversation already exists',
            conversationId: result.conversationId,
            targetUserId,
          },
        });

        if (result.conversationId) {
          conversationIo.to(targetUserId).emit('conversation:created', {
            conversationId: result.conversationId,
            createdBy: userId,
          });
        }
        logger.info(`[ConversationSocket] User ${userId} created conversation with ${targetUserId}`);
      } catch (error) {
        logger.error(`[ConversationSocket] Error creating conversation for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info(`[ConversationSocket] User disconnected: ${userId}`);
    });
  });
};

module.exports = initializeConversationSocket;