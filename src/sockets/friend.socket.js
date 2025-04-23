const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');
const FriendService = require('../services/friend.service');
const ConversationService = require('../services/conversation.service');
const { dynamoDB } = require('../config/aws.config');
const { AppError } = require('../utils/errorHandler');
const { isValidUUID } = require('../utils/helpers');

const initializeFriendSocket = (friendIo) => {
  friendIo.use(authenticateSocket);

  friendIo.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info(`[FriendSocket] User connected: ${userId} (Socket ID: ${socket.id})`);

    socket.join(userId);

    socket.on('friend:sendRequest', async ({ receiverId, message }, callback) => {
      try {
        if (!receiverId) {
          throw new AppError('receiverId is required', 400);
        }
        const result = await FriendService.sendFriendRequest(userId, receiverId, message);
        callback({ success: true, data: { requestId: result.requestId, message: result.message } });
        friendIo.to(receiverId).emit('friend:requestReceived', {
          requestId: result.requestId,
          senderId: userId,
          message,
        });
        logger.info(`[FriendSocket] User ${userId} sent friend request to ${receiverId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error sending friend request for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:acceptRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId) {
          throw new AppError('requestId is required', 400);
        }
        const result = await FriendService.acceptFriendRequest(userId, requestId);
        callback({ success: true, data: { message: result.message, conversationIds: result.conversationIds } });

        const senderId = requestId.split('#')[0];
        friendIo.to(senderId).emit('friend:requestAccepted', {
          accepterId: userId,
          conversationId: result.conversationIds[senderId],
        });

        await ConversationService.createConversation(userId, senderId);
        await ConversationService.createConversation(senderId, userId);

        logger.info(`[FriendSocket] User ${userId} accepted friend request ${requestId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error accepting friend request for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:rejectRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId) {
          throw new AppError('requestId is required', 400);
        }
        const result = await FriendService.rejectFriendRequest(userId, requestId);
        callback({ success: true, message: result.message });

        const senderId = requestId.split('#')[0];
        friendIo.to(senderId).emit('friend:requestRejected', { rejecterId: userId });
        logger.info(`[FriendSocket] User ${userId} rejected friend request ${requestId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error rejecting friend request for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:cancelRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId) {
          throw new AppError('requestId is required', 400);
        }
        const result = await FriendService.cancelFriendRequest(userId, requestId);
        callback({ success: true, message: result.message });

        const receiverId = (await dynamoDB.query({
          TableName: 'FriendRequests',
          IndexName: 'SenderIdIndex',
          KeyConditionExpression: 'senderId = :senderId AND requestId = :requestId',
          ExpressionAttributeValues: {
            ':senderId': userId,
            ':requestId': requestId,
          },
        }).promise()).Items[0]?.userId;
        if (receiverId) {
          friendIo.to(receiverId).emit('friend:requestCancelled', { senderId: userId });
        }
        logger.info(`[FriendSocket] User ${userId} cancelled friend request ${requestId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error cancelling friend request for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:block', async ({ blockedUserId }, callback) => {
      try {
        if (!blockedUserId) {
          throw new AppError('blockedUserId is required', 400);
        }
        const result = await FriendService.blockUser(userId, blockedUserId);
        callback({ success: true, data: { message: result.message, blockedUserId } });
        logger.info(`[FriendSocket] User ${userId} blocked user ${blockedUserId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error blocking user for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:unblock', async ({ blockedUserId }, callback) => {
      try {
        if (!blockedUserId) {
          throw new AppError('blockedUserId is required', 400);
        }
        const result = await FriendService.unblockUser(userId, blockedUserId);
        callback({ success: true, data: { message: result.message, blockedUserId } });
        logger.info(`[FriendSocket] User ${userId} unblocked user ${blockedUserId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error unblocking user for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:remove', async ({ friendId }, callback) => {
      try {
        if (!friendId) {
          throw new AppError('friendId là bắt buộc', 400);
        }
        if (!isValidUUID(friendId)) {
          throw new AppError('friendId không hợp lệ', 400);
        }
        const result = await FriendService.removeFriend(userId, friendId);
        callback({ success: true, data: { message: result.message, friendId } });
        friendIo.to(friendId).emit('friend:removed', { removerId: userId });
        logger.info(`[FriendSocket] User ${userId} removed friend ${friendId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error removing friend for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:markFavorite', async ({ friendId }, callback) => {
      try {
        if (!friendId) {
          throw new AppError('friendId is required', 400);
        }
        const result = await FriendService.markFavorite(userId, friendId);
        callback({ success: true, data: { message: result.message, friendId } });
        logger.info(`[FriendSocket] User ${userId} marked ${friendId} as favorite`);
      } catch (error) {
        logger.error(`[FriendSocket] Error marking favorite for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:unmarkFavorite', async ({ friendId }, callback) => {
      try {
        if (!friendId) {
          throw new AppError('friendId is required', 400);
        }
        const result = await FriendService.unmarkFavorite(userId, friendId);
        callback({ success: true, data: { message: result.message, friendId } });
        logger.info(`[FriendSocket] User ${userId} unmarked ${friendId} as favorite`);
      } catch (error) {
        logger.error(`[FriendSocket] Error unmarking favorite for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('friend:setNickname', async ({ targetUserId, nickname }, callback) => {
      try {
        if (!targetUserId || !nickname) {
          throw new AppError('targetUserId and nickname are required', 400);
        }
        const result = await FriendService.setConversationNickname(userId, targetUserId, nickname);
        callback({ success: true, data: { message: result.message, targetUserId, nickname } });
        logger.info(`[FriendSocket] User ${userId} set nickname for ${targetUserId}`);
      } catch (error) {
        logger.error(`[FriendSocket] Error setting nickname for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info(`[FriendSocket] User disconnected: ${userId}`);
    });
  });
};

module.exports = initializeFriendSocket;