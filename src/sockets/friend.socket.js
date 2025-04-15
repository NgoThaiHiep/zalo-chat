const { io } = require('../socket');
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
  searchUserByPhoneNumber,
  searchUsersByName,
} = require('../services/friend.service');
const logger = require('../config/logger');

const initializeFriendSocket = (socket) => {
  logger.info('[FRIEND_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

  // Middleware xác thực (đảm bảo socket.userId tồn tại)
  socket.use(([event], next) => {
    if (!socket.userId) return next(new Error('Chưa xác thực!'));
    next();
  });

  // Xử lý lỗi socket
  socket.on('error', (error) => {
    logger.error('[FRIEND_SOCKET] Socket error', { socketId: socket.id, error: error.message });
    socket.emit('error', { message: error.message });
  });

  // Gửi yêu cầu kết bạn
  socket.on('sendFriendRequest', async ({ receiverId }) => {
    try {
      const result = await sendFriendRequest(socket.userId, receiverId);
      logger.info('[FRIEND_SOCKET] Friend request sent', { senderId: socket.userId, receiverId });
      io().to(receiverId).emit('friendRequestReceived', {
        senderId: socket.userId,
        requestId: result.requestId,
      });
      socket.emit('sendFriendRequestSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error sending friend request', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Chấp nhận yêu cầu kết bạn
  socket.on('acceptFriendRequest', async ({ requestId }) => {
    try {
      const result = await acceptFriendRequest(socket.userId, requestId);
      logger.info('[FRIEND_SOCKET] Friend request accepted', { userId: socket.userId, requestId });
      const senderId = requestId.split('#')[0];
      io().to(senderId).emit('friendRequestAccepted', { userId: socket.userId });
      socket.emit('acceptFriendRequestSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error accepting friend request', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Từ chối yêu cầu kết bạn
  socket.on('rejectFriendRequest', async ({ requestId }) => {
    try {
      const result = await rejectFriendRequest(socket.userId, requestId);
      logger.info('[FRIEND_SOCKET] Friend request rejected', { userId: socket.userId, requestId });
      socket.emit('rejectFriendRequestSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error rejecting friend request', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Hủy yêu cầu kết bạn
  socket.on('cancelFriendRequest', async ({ requestId }) => {
    try {
      const result = await cancelFriendRequest(socket.userId, requestId);
      logger.info('[FRIEND_SOCKET] Friend request cancelled', { userId: socket.userId, requestId });
      socket.emit('cancelFriendRequestSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error cancelling friend request', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách yêu cầu kết bạn đã nhận
  socket.on('getReceivedFriendRequests', async () => {
    try {
      const result = await getReceivedFriendRequests(socket.userId);
      logger.info('[FRIEND_SOCKET] Fetched received friend requests', { userId: socket.userId });
      socket.emit('getReceivedFriendRequestsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching received friend requests', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách yêu cầu kết bạn đã gửi
  socket.on('getSentFriendRequests', async () => {
    try {
      const result = await getSentFriendRequests(socket.userId);
      logger.info('[FRIEND_SOCKET] Fetched sent friend requests', { userId: socket.userId });
      socket.emit('getSentFriendRequestsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching sent friend requests', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách bạn bè
  socket.on('getFriends', async () => {
    try {
      const result = await getFriends(socket.userId);
      logger.info('[FRIEND_SOCKET] Fetched friends', { userId: socket.userId });
      socket.emit('getFriendsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching friends', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Chặn người dùng
  socket.on('blockUser', async ({ blockedUserId }) => {
    try {
      const result = await blockUser(socket.userId, blockedUserId);
      logger.info('[FRIEND_SOCKET] User blocked', { userId: socket.userId, blockedUserId });
      socket.emit('blockUserSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error blocking user', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Bỏ chặn người dùng
  socket.on('unblockUser', async ({ blockedUserId }) => {
    try {
      const result = await unblockUser(socket.userId, blockedUserId);
      logger.info('[FRIEND_SOCKET] User unblocked', { userId: socket.userId, blockedUserId });
      socket.emit('unblockUserSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error unblocking user', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Xóa bạn bè
  socket.on('removeFriend', async ({ friendId }) => {
    try {
      const result = await removeFriend(socket.userId, friendId);
      logger.info('[FRIEND_SOCKET] Friend removed', { userId: socket.userId, friendId });
      io().to(friendId).emit('friendRemoved', { userId: socket.userId });
      socket.emit('removeFriendSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error removing friend', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy gợi ý kết bạn
  socket.on('getFriendSuggestions', async () => {
    try {
      const result = await getFriendSuggestions(socket.userId);
      logger.info('[FRIEND_SOCKET] Fetched friend suggestions', { userId: socket.userId });
      socket.emit('getFriendSuggestionsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching friend suggestions', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Kiểm tra trạng thái người dùng
  socket.on('getUserStatus', async ({ targetUserId }) => {
    try {
      const result = await getUserStatus(socket.userId, targetUserId);
      logger.info('[FRIEND_SOCKET] Fetched user status', { userId: socket.userId, targetUserId });
      socket.emit('getUserStatusSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching user status', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy thông tin hồ sơ người dùng
  socket.on('getUserProfile', async ({ targetUserId }) => {
    try {
      const result = await getUserProfile(socket.userId, targetUserId);
      logger.info('[FRIEND_SOCKET] Fetched user profile', { userId: socket.userId, targetUserId });
      socket.emit('getUserProfileSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching user profile', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy tên người dùng
  socket.on('getUserName', async ({ targetUserId }) => {
    try {
      const result = await getUserName(socket.userId, targetUserId);
      logger.info('[FRIEND_SOCKET] Fetched user name', { userId: socket.userId, targetUserId });
      socket.emit('getUserNameSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching user name', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Đánh dấu bạn bè yêu thích
  socket.on('markFavorite', async ({ friendId }) => {
    try {
      const result = await markFavorite(socket.userId, friendId);
      logger.info('[FRIEND_SOCKET] Friend marked as favorite', { userId: socket.userId, friendId });
      socket.emit('markFavoriteSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error marking favorite', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Bỏ đánh dấu bạn bè yêu thích
  socket.on('unmarkFavorite', async ({ friendId }) => {
    try {
      const result = await unmarkFavorite(socket.userId, friendId);
      logger.info('[FRIEND_SOCKET] Friend unmarked as favorite', { userId: socket.userId, friendId });
      socket.emit('unmarkFavoriteSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error unmarking favorite', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách bạn bè yêu thích
  socket.on('getFavoriteFriends', async () => {
    try {
      const result = await getFavoriteFriends(socket.userId);
      logger.info('[FRIEND_SOCKET] Fetched favorite friends', { userId: socket.userId });
      socket.emit('getFavoriteFriendsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching favorite friends', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy danh sách bạn chung
  socket.on('getMutualFriends', async ({ targetUserId }) => {
    try {
      const result = await getMutualFriends(socket.userId, targetUserId);
      logger.info('[FRIEND_SOCKET] Fetched mutual friends', { userId: socket.userId, targetUserId });
      socket.emit('getMutualFriendsSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching mutual friends', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Đặt tên gợi nhớ
  socket.on('setConversationNickname', async ({ targetUserId, nickname }) => {
    try {
      const result = await setConversationNickname(socket.userId, targetUserId, nickname);
      logger.info('[FRIEND_SOCKET] Conversation nickname set', { userId: socket.userId, targetUserId });
      socket.emit('setConversationNicknameSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error setting conversation nickname', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Lấy tên gợi nhớ
  socket.on('getConversationNickname', async ({ targetUserId }) => {
    try {
      const result = await getConversationNickname(socket.userId, targetUserId);
      logger.info('[FRIEND_SOCKET] Fetched conversation nickname', { userId: socket.userId, targetUserId });
      socket.emit('getConversationNicknameSuccess', { success: true, data: result });
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error fetching conversation nickname', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Tìm kiếm người dùng theo số điện thoại
  socket.on('searchUserByPhoneNumber', async ({ phoneNumber }) => {
    try {
      const result = await searchUserByPhoneNumber(phoneNumber);
      logger.info('[FRIEND_SOCKET] Searched user by phone number', { userId: socket.userId, phoneNumber });
      socket.emit('searchUserByPhoneNumberSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error searching user by phone number', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  // Tìm kiếm người dùng theo tên
  socket.on('searchUsersByName', async ({ name }) => {
    try {
      const result = await searchUsersByName(socket.userId, name);
      logger.info('[FRIEND_SOCKET] Searched users by name', { userId: socket.userId, name });
      socket.emit('searchUsersByNameSuccess', result);
    } catch (error) {
      logger.error('[FRIEND_SOCKET] Error searching users by name', { error: error.message });
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info('[FRIEND_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
  });
};

module.exports = { initializeFriendSocket };