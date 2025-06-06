const FriendService = require('../services/friend.service');
const ConversationService = require('../services/conversation.service');
const logger = require('../config/logger');
const { dynamoDB } = require('../config/aws.config');
const { isValidUUID } = require('../utils/helpers');
const { AppError } = require('../utils/errorHandler');

const sendFriendRequestController = async (req, res) => {
  const { receiverId, message } = req.body;
  const senderId = req.user.id;

  try {
    if (!receiverId) {
      throw new AppError('receiverId là bắt buộc', 400);
    }
    if (!isValidUUID(receiverId)) {
      throw new AppError('receiverId không hợp lệ', 400);
    }
    const result = await FriendService.sendFriendRequest(senderId, receiverId, message);
    req.io.of('/friend').to(`user:${senderId}`).emit('friend:sendRequest', {
      success: true,
      data: { message: result.message, requestId: result.requestId },
    });
    req.io.of('/friend').to(`user:${receiverId}`).emit('friend:requestReceived', {
      requestId: result.requestId,
      senderId,
      message,
    });
    logger.info(`[FriendController] Emitted friend:sendRequest to user:${senderId} and friend:requestReceived to user:${receiverId}`);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    logger.error('[sendFriendRequestController] Error', { error: error.message });
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Lỗi khi gửi yêu cầu kết bạn',
    });
  }
};

const acceptFriendRequestController = async (req, res) => {
  const { requestId } = req.query;
  const userId = req.user.id;
  logger.info(`Xử lý POST /api/friends/accept`, { requestId, userId });

  if (!requestId || !userId) {
    logger.error('Thiếu requestId hoặc userId', { requestId, userId });
    return res.status(400).json({ message: 'Yêu cầu phải có requestId và userId' });
  }

  const requestIdPattern = /^[0-9a-f-]{36}#\d+$/;
  if (!requestIdPattern.test(requestId)) {
    logger.error('Định dạng requestId không hợp lệ', { requestId });
    return res.status(400).json({ message: 'requestId không hợp lệ' });
  }

  try {
    const result = await FriendService.acceptFriendRequest(userId, requestId);

    const senderId = requestId.split('#')[0];
    if (!senderId) {
      logger.error('Không thể trích xuất senderId từ requestId', { requestId });
      throw new AppError('requestId không hợp lệ', 400);
    }

    const [userInfo, senderInfo] = await Promise.all([
      FriendService.getUserName(userId, userId),
      FriendService.getUserName(userId, senderId),
    ]);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:acceptRequest:success', {
      message: result.message,
      conversationIds: result.conversationIds,
    });

    req.io.of('/friend').to(`user:${senderId}`).emit('friend:requestAccepted', {
      accepterId: userId,
      conversationId: result.conversationIds[senderId] || 'existing',
    });

    const messageForUser = `Bạn và ${senderInfo.name} đã trở thành bạn bè`;
    const messageForSender = `Bạn và ${userInfo.name} đã trở thành bạn bè`;

    req.io.of('/friend').to(`user:${userId}`).emit('friend:friendshipEstablished', {
      friendId: senderId,
      friendName: senderInfo.name,
      message: messageForUser,
      conversationId: result.conversationIds[userId],
    });

    req.io.of('/friend').to(`user:${senderId}`).emit('friend:friendshipEstablished', {
      friendId: userId,
      friendName: userInfo.name,
      message: messageForSender,
      conversationId: result.conversationIds[senderId] || 'existing',
    });

    logger.info(
      `[FriendController] Đã phát sự kiện friend:acceptRequest:success và friend:friendshipEstablished cho user:${userId} và friend:requestAccepted và friend:friendshipEstablished cho user:${senderId}`
    );

    return res.status(200).json(result);
  } catch (error) {
    logger.error('[acceptFriendRequestController] Lỗi', { error: error.message });
    if (error.message === 'Không tìm thấy yêu cầu kết bạn') {
      return res.status(404).json({ message: 'Không tìm thấy yêu cầu kết bạn' });
    }
    if (error.message === 'Yêu cầu kết bạn không phải đang chờ xử lý') {
      return res.status(400).json({ message: 'Yêu cầu kết bạn không phải đang chờ xử lý' });
    }
    return res.status(error.statusCode || 500).json({
      message: 'Lỗi khi chấp nhận yêu cầu',
      error: error.message,
    });
  }
};

const rejectFriendRequestController = async (req, res) => {
  const { requestId } = req.body;
  const userId = req.user.id;

  try {
    const result = await FriendService.rejectFriendRequest(userId, requestId);

    const senderId = requestId.split('#')[0];
    req.io.of('/friend').to(`user:${userId}`).emit('friend:rejectRequest:success', {
      message: result.message,
    });
    req.io.of('/friend').to(`user:${senderId}`).emit('friend:requestRejected', {
      rejecterId: userId,
    });
    logger.info(`[FriendController] Emitted friend:rejectRequest:success to user:${userId} and friend:requestRejected to user:${senderId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[rejectFriendRequestController] Error', { error: error.message });
    res.status(500).json({ message: 'Error rejecting request', error: error.message });
  }
};

const cancelFriendRequestController = async (req, res) => {
  const { requestId } = req.body;
  const senderId = req.user.id;

  try {
    const result = await FriendService.cancelFriendRequest(senderId, requestId);

    // Truy vấn receiverId trước khi xóa
    const checkResult = await dynamoDB.query({
      TableName: 'FriendRequests',
      IndexName: 'SenderIdIndex',
      KeyConditionExpression: 'senderId = :senderId',
      FilterExpression: 'requestId = :requestId', // Chuyển requestId vào FilterExpression
      ExpressionAttributeValues: {
        ':senderId': senderId,
        ':requestId': requestId,
      },
    }).promise();

    let receiverId;
    if (checkResult.Items.length > 0) {
      receiverId = checkResult.Items[0]?.userId;
    }

    if (receiverId) {
      req.io.of('/friend').to(`user:${senderId}`).emit('friend:cancelRequest:success', {
        message: result.message,
      });
      req.io.of('/friend').to(`user:${receiverId}`).emit('friend:requestCancelled', {
        senderId,
      });
      logger.info(`[FriendController] Emitted friend:cancelRequest:success to user:${senderId} and friend:requestCancelled to user:${receiverId}`);
    }

    res.status(200).json(result);
  } catch (error) {
    logger.error('[cancelFriendRequestController] Error', { error: error.message });
    res.status(error.statusCode || 500).json({ message: error.message || 'Lỗi khi thu hồi lời mời kết bạn', error: error.message });
  }
};

const blockUserController = async (req, res) => {
  const { blockedUserId } = req.body;
  const userId = req.user.id;

  try {
    const result = await FriendService.blockUser(userId, blockedUserId);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:block:success', {
      message: result.message,
      blockedUserId,
    });
    logger.info(`[FriendController] Emitted friend:block:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[blockUserController] Error', { error: error.message });
    if (error.message === 'Bạn không thể chặn chính mình!') {
      return res.status(400).json({ message: 'Bạn không thể chặn chính mình!' });
    }
    if (error.message === 'User is already blocked') {
      return res.status(400).json({ message: 'User is already blocked' });
    }
    res.status(500).json({ message: 'Error blocking user', error: error.message });
  }
};

const unblockUserController = async (req, res) => {
  const { blockedUserId } = req.body;
  const userId = req.user.id;

  try {
    const result = await FriendService.unblockUser(userId, blockedUserId);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:unblock:success', {
      message: result.message,
      blockedUserId,
    });
    logger.info(`[FriendController] Emitted friend:unblock:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[unblockUserController] Error', { error: error.message });
    res.status(500).json({ message: 'Error unblocking user', error: error.message });
  }
};

const markFavoriteController = async (req, res) => {
  const { friendId } = req.body;
  const userId = req.user.id;

  try {
    const result = await FriendService.markFavorite(userId, friendId);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:markFavorite:success', {
      message: result.message,
      friendId,
    });
    logger.info(`[FriendController] Emitted friend:markFavorite:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[markFavoriteController] Error', { error: error.message });
    res.status(500).json({ message: 'Error marking favorite', error: error.message });
  }
};

const unmarkFavoriteController = async (req, res) => {
  const { friendId } = req.body;
  const userId = req.user.id;

  try {
    const result = await FriendService.unmarkFavorite(userId, friendId);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:unmarkFavorite:success', {
      message: result.message,
      friendId,
    });
    logger.info(`[FriendController] Emitted friend:unmarkFavorite:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[unmarkFavoriteController] Error', { error: error.message });
    res.status(500).json({ message: 'Error unmarking favorite', error: error.message });
  }
};

const setConversationNicknameController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId, nickname } = req.body;

    if (!targetUserId || !nickname) {
      return res.status(400).json({ success: false, message: 'targetUserId và nickname là bắt buộc!' });
    }

    const result = await FriendService.setConversationNickname(userId, targetUserId, nickname);

    req.io.of('/friend').to(`user:${userId}`).emit('friend:setNickname:success', {
      message: result.message,
      targetUserId,
      nickname,
    });
    logger.info(`[FriendController] Emitted friend:setNickname:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[setConversationNicknameController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
};

const getReceivedFriendRequestsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getReceivedFriendRequests(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getReceivedFriendRequestsController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching received friend requests', error: error.message });
  }
};

const getSentFriendRequestsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getSentFriendRequests(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getSentFriendRequestsController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching sent friend requests', error: error.message });
  }
};

const getFriendsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getFriends(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getFriendsController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching friends', error: error.message });
  }
};

const getBlockedUsersController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getBlockedUsers(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getBlockedUsersController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching blocked users', error: error.message });
  }
};

const removeFriendController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { friendId } = req.body;
    if (!friendId) {
      throw new AppError('friendId là bắt buộc', 400);
    }
    if (!isValidUUID(friendId)) {
      throw new AppError('friendId không hợp lệ', 400);
    }
    const result = await FriendService.removeFriend(userId, friendId);
    req.io.of('/friend').to(`user:${userId}`).emit('friend:remove', {
      success: true,
      data: { message: result.message, friendId },
    });
    req.io.of('/friend').to(`user:${friendId}`).emit('friend:removed', {
      removerId: userId,
    });
    logger.info(`[FriendController] Emitted friend:remove to user:${userId} and friend:removed to user:${friendId}`);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    logger.error('[removeFriendController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi xóa bạn bè', error.statusCode || 500);
  }
};

const getFriendSuggestionsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getFriendSuggestions(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getFriendSuggestionsController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching friend suggestions', error: error.message });
  }
};

const getUserStatusController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.params;

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId là bắt buộc!' });
    }

    const result = await FriendService.getUserStatus(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getUserStatusController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching user status', error: error.message });
  }
};

const getUserProfileController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.params;

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId là bắt buộc!' });
    }

    const result = await FriendService.getUserProfile(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getUserProfileController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching user profile', error: error.message });
  }
};

const getUserNameController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.query;

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId là bắt buộc!' });
    }

    const result = await FriendService.getUserName(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getUserNameController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching user name', error: error.message });
  }
};

const getFavoriteFriendsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await FriendService.getFavoriteFriends(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getFavoriteFriendsController] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching favorite friends', error: error.message });
  }
};

const getMutualFriends = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.query;

    if (!targetUserId) {
      return res.status(400).json({ message: 'targetUserId là bắt buộc!' });
    }

    const result = await FriendService.getMutualFriends(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getMutualFriends] Error', { error: error.message });
    res.status(500).json({ message: 'Error fetching mutual friends', error: error.message });
  }
};

const getConversationNicknameController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.query;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
    }

    const result = await FriendService.getConversationNickname(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getConversationNicknameController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  acceptFriendRequestController,
  getReceivedFriendRequestsController,
  getSentFriendRequestsController,
  getFriendsController,
  rejectFriendRequestController,
  sendFriendRequestController,
  cancelFriendRequestController,
  blockUserController,
  getBlockedUsersController,
  unblockUserController,
  removeFriendController,
  getFriendSuggestionsController,
  getUserStatusController,
  getUserProfileController,
  getUserNameController,
  markFavoriteController,
  unmarkFavoriteController,
  getFavoriteFriendsController,
  getMutualFriends,
  setConversationNicknameController,
  getConversationNicknameController,
};