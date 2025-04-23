const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');
const AuthService = require('../services/auth.service');
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
    logger.error('[AuthSocket] Error fetching friends', { userId, error: error.message });
    throw new AppError('Failed to fetch friends', 500);
  }
};

const initializeAuthSocket = (authIo) => {
  authIo.use(authenticateSocket);

  authIo.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[AuthSocket] User connected: ${userId} (Socket ID: ${socket.id})`);

    socket.join(userId);

    socket.on('user:login', async () => {
      try {
        await AuthService.updateUserOnlineStatus(userId, true);
        const friends = await getFriends(userId);
        authIo.to(friends).emit('user:status', { userId, status: 'online' });
        socket.emit('user:status', { userId, status: 'online' });
        logger.info(`[AuthSocket] User ${userId} is online`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating online status for ${userId}`, { error: error.message });
        socket.emit('user:login:error', { message: error.message });
      }
    });

    socket.on('profile:update', async ({ updates, files }, callback) => {
      try {
        const updatedProfile = await AuthService.updateUserProfile(userId, updates, files);
        const friends = await getFriends(userId);
        authIo.to(friends).emit('profile:update', {
          userId,
          updatedFields: {
            name: updatedProfile.name,
            avatar: updatedProfile.avatar,
            coverPhoto: updatedProfile.coverPhoto,
            bio: updatedProfile.bio,
          },
        });
        callback({ success: true, data: updatedProfile });
        logger.info(`[AuthSocket] Profile updated for ${userId}, notified ${friends.length} friends`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating profile for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('privacy:update', async ({ showOnline }, callback) => {
      try {
        if (!['everyone', 'friends_only', 'none'].includes(showOnline)) {
          throw new AppError('Invalid showOnline value', 400);
        }
        await AuthService.updatePrivacySettings(userId, showOnline);
        const friends = await getFriends(userId);
        const status = showOnline === 'none' ? 'hidden' : 'online';
        authIo.to(friends).emit('user:status', { userId, status });
        callback({ success: true, message: 'Privacy settings updated' });
        logger.info(`[AuthSocket] Privacy settings updated for ${userId}: ${showOnline}`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating privacy settings for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('restrictStrangerMessages:update', async ({ restrict }, callback) => {
      try {
        await AuthService.updateRestrictStrangerMessages(userId, restrict);
        callback({ success: true, message: `Stranger messages restriction set to ${restrict}` });
        logger.info(`[AuthSocket] Stranger messages restriction updated for ${userId}: ${restrict}`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating stranger messages restriction for ${userId}`, {
          error: error.message,
        });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('readReceipts:update', async ({ showReadReceipts }, callback) => {
      try {
        await AuthService.updateReadReceiptsSetting(userId, showReadReceipts);
        callback({ success: true, message: `Read receipts setting set to ${showReadReceipts}` });
        logger.info(`[AuthSocket] Read receipts setting updated for ${userId}: ${showReadReceipts}`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating read receipts setting for ${userId}`, {
          error: error.message,
        });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('disconnect', async () => {
      try {
        await AuthService.updateUserOnlineStatus(userId, false);
        const friends = await getFriends(userId);
        authIo.to(friends).emit('user:status', { userId, status: 'offline' });
        logger.info(`[AuthSocket] User disconnected: ${userId}`);
      } catch (error) {
        logger.error(`[AuthSocket] Error updating offline status for ${userId}`, { error: error.message });
      }
    });

    socket.on('user:logout', async () => {
      try {
        await AuthService.updateUserOnlineStatus(userId, false);
        const friends = await getFriends(userId);
        authIo.to(friends).emit('user:status', { userId, status: 'offline' });
        socket.disconnect();
        logger.info(`[AuthSocket] User logged out: ${userId}`);
      } catch (error) {
        logger.error(`[AuthSocket] Error during logout for ${userId}`, { error: error.message });
      }
    });
  });
};

module.exports = initializeAuthSocket;