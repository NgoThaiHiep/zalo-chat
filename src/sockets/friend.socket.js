const {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  getReceivedFriendRequests,
  getSentFriendRequests,
  getFriends,
  blockUser,
  unblockUser,
  removeFriend,
  getFriendSuggestions,
  getUserStatus,
  getUserProfile,
  markFavorite,
  unmarkFavorite,
  getFavoriteFriends,
  getMutualFriends,
  getUserName,
  setConversationNickname,
  getConversationNickname,
} = require('../services/friend.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler')
const { io } = require('../socket');

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('[FRIEND_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

    socket.on('sendFriendRequest', async ({ receiverId }, callback) => {
      try {
        if (!receiverId || typeof receiverId !== 'string') {
          throw new AppError('Thiếu hoặc receiverId không hợp lệ!', 400);
        }
        const result = await sendFriendRequest(socket.userId, receiverId);
        logger.info('[FRIEND_SOCKET] Sent friend request', { senderId: socket.userId, receiverId });
        io.to(receiverId).emit('friendRequestReceived', {
          senderId: socket.userId,
          requestId: result.requestId,
        });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to send friend request', { userId: socket.userId, receiverId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('acceptFriendRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId || typeof requestId !== 'string') {
          throw new AppError('Thiếu hoặc requestId không hợp lệ!', 400);
        }
        const result = await acceptFriendRequest(socket.userId, requestId);
        logger.info('[FRIEND_SOCKET] Accepted friend request', { userId: socket.userId, requestId });
        const senderId = requestId.split('#')[0];
        io.to(senderId).emit('friendRequestAccepted', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to accept friend request', { userId: socket.userId, requestId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('rejectFriendRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId || typeof requestId !== 'string') {
          throw new AppError('Thiếu hoặc requestId không hợp lệ!', 400);
        }
        const result = await rejectFriendRequest(socket.userId, requestId);
        logger.info('[FRIEND_SOCKET] Rejected friend request', { userId: socket.userId, requestId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to reject friend request', { userId: socket.userId, requestId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('cancelFriendRequest', async ({ requestId }, callback) => {
      try {
        if (!requestId || typeof requestId !== 'string') {
          throw new AppError('Thiếu hoặc requestId không hợp lệ!', 400);
        }
        const result = await cancelFriendRequest(socket.userId, requestId);
        logger.info('[FRIEND_SOCKET] Canceled friend request', { userId: socket.userId, requestId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to cancel friend request', { userId: socket.userId, requestId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getReceivedFriendRequests', async (callback) => {
      try {
        const result = await getReceivedFriendRequests(socket.userId);
        logger.info('[FRIEND_SOCKET] Got received friend requests', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get received friend requests', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getSentFriendRequests', async (callback) => {
      try {
        const result = await getSentFriendRequests(socket.userId);
        logger.info('[FRIEND_SOCKET] Got sent friend requests', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get sent friend requests', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getFriends', async (callback) => {
      try {
        const result = await getFriends(socket.userId);
        logger.info('[FRIEND_SOCKET] Got friends list', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get friends list', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('blockUser', async ({ blockedUserId }, callback) => {
      try {
        if (!blockedUserId || typeof blockedUserId !== 'string') {
          throw new AppError('Thiếu hoặc blockedUserId không hợp lệ!', 400);
        }
        const result = await blockUser(socket.userId, blockedUserId);
        logger.info('[FRIEND_SOCKET] Blocked user', { userId: socket.userId, blockedUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to block user', { userId: socket.userId, blockedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unblockUser', async ({ blockedUserId }, callback) => {
      try {
        if (!blockedUserId || typeof blockedUserId !== 'string') {
          throw new AppError('Thiếu hoặc blockedUserId không hợp lệ!', 400);
        }
        const result = await unblockUser(socket.userId, blockedUserId);
        logger.info('[FRIEND_SOCKET] Unblocked user', { userId: socket.userId, blockedUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to unblock user', { userId: socket.userId, blockedUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('removeFriend', async ({ friendId }, callback) => {
      try {
        if (!friendId || typeof friendId !== 'string') {
          throw new AppError('Thiếu hoặc friendId không hợp lệ!', 400);
        }
        const result = await removeFriend(socket.userId, friendId);
        logger.info('[FRIEND_SOCKET] Removed friend', { userId: socket.userId, friendId });
        io.to(friendId).emit('friendRemoved', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to remove friend', { userId: socket.userId, friendId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getFriendSuggestions', async (callback) => {
      try {
        const result = await getFriendSuggestions(socket.userId);
        logger.info('[FRIEND_SOCKET] Got friend suggestions', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get friend suggestions', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getUserStatus', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId không hợp lệ!', 400);
        }
        const result = await getUserStatus(socket.userId, targetUserId);
        logger.info('[FRIEND_SOCKET] Got user status', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get user status', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getUserProfile', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId không hợp lệ!', 400);
        }
        const result = await getUserProfile(socket.userId, targetUserId);
        logger.info('[FRIEND_SOCKET] Got user profile', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get user profile', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getUserName', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId không hợp lệ!', 400);
        }
        const result = await getUserName(socket.userId, targetUserId);
        logger.info('[FRIEND_SOCKET] Got user name', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get user name', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('markFavorite', async ({ friendId }, callback) => {
      try {
        if (!friendId || typeof friendId !== 'string') {
          throw new AppError('Thiếu hoặc friendId không hợp lệ!', 400);
        }
        const result = await markFavorite(socket.userId, friendId);
        logger.info('[FRIEND_SOCKET] Marked favorite', { userId: socket.userId, friendId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to mark favorite', { userId: socket.userId, friendId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('unmarkFavorite', async ({ friendId }, callback) => {
      try {
        if (!friendId || typeof friendId !== 'string') {
          throw new AppError('Thiếu hoặc friendId không hợp lệ!', 400);
        }
        const result = await unmarkFavorite(socket.userId, friendId);
        logger.info('[FRIEND_SOCKET] Unmarked favorite', { userId: socket.userId, friendId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to unmark favorite', { userId: socket.userId, friendId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getFavoriteFriends', async (callback) => {
      try {
        const result = await getFavoriteFriends(socket.userId);
        logger.info('[FRIEND_SOCKET] Got favorite friends', { userId: socket.userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get favorite friends', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getMutualFriends', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId không hợp lệ!', 400);
        }
        const result = await getMutualFriends(socket.userId, targetUserId);
        logger.info('[FRIEND_SOCKET] Got mutual friends', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get mutual friends', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('setConversationNickname', async ({ targetUserId, nickname }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string' || !nickname || typeof nickname !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId/nickname không hợp lệ!', 400);
        }
        const result = await setConversationNickname(socket.userId, targetUserId, nickname);
        logger.info('[FRIEND_SOCKET] Set conversation nickname', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to set conversation nickname', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('getConversationNickname', async ({ targetUserId }, callback) => {
      try {
        if (!targetUserId || typeof targetUserId !== 'string') {
          throw new AppError('Thiếu hoặc targetUserId không hợp lệ!', 400);
        }
        const result = await getConversationNickname(socket.userId, targetUserId);
        logger.info('[FRIEND_SOCKET] Got conversation nickname', { userId: socket.userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[FRIEND_SOCKET] Failed to get conversation nickname', { userId: socket.userId, targetUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('disconnect', () => {
      logger.info('[FRIEND_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
    });
  });
};