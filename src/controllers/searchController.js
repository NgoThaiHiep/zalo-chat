const {
  searchUsersByName,
  searchFriendsByPhoneNumber,
  searchAllUsersByPhoneNumber,
  searchMessagesBetweenUsers,
  searchMessagesInGroup,
  searchAll,
} = require('../services/search.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');

// Validate keyword parameter
const validateKeyword = (keyword) => {
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }
};

// Validate user ID or group ID
const validateId = (id, type = 'user') => {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new AppError(`ID ${type} không hợp lệ!`, 400);
  }
};

// 1. Search users by name (friends or past conversations)
const searchUsersByNameController = async (req, res) => {
  try {
    const { keyword } = req.query;
    const currentUserId = req.user.userId; // Assuming user ID comes from auth middleware

    validateKeyword(keyword);
    logger.info(`Tìm kiếm người dùng theo tên: ${keyword} bởi ${currentUserId}`);

    const result = await searchUsersByName(currentUserId, keyword);
    if (!result.success) {
      throw new AppError(result.error, 400);
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchUsersByNameController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

// 2. Search friends by phone number
const searchFriendsByPhoneNumberController = async (req, res) => {
  try {
    const { phoneNumber } = req.query;
    const currentUserId = req.user.userId;

    validateKeyword(phoneNumber);
    logger.info(`Tìm kiếm bạn bè theo số điện thoại: ${phoneNumber} bởi ${currentUserId}`);

    const result = await searchFriendsByPhoneNumber(currentUserId, phoneNumber);
    if (!result.success) {
      throw new AppError(result.error, 400);
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchFriendsByPhoneNumberController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

// 3. Search all users by phone number
const searchAllUsersByPhoneNumberController = async (req, res) => {
  try {
    const { phoneNumber } = req.query;
    const currentUserId = req.user.userId;

    validateKeyword(phoneNumber);
    logger.info(`Tìm kiếm tất cả người dùng theo số điện thoại: ${phoneNumber} bởi ${currentUserId}`);

    const result = await searchAllUsersByPhoneNumber(currentUserId, phoneNumber);
    if (!result.success) {
      throw new AppError(result.error, 400);
    }

    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchAllUsersByPhoneNumberController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

// 4. Search messages in 1-1 conversation
const searchMessagesBetweenUsersController = async (req, res) => {
  try {
    const { otherUserId, keyword } = req.query;
    const currentUserId = req.user.userId;

    validateId(otherUserId);
    validateKeyword(keyword);
    logger.info(`Tìm kiếm tin nhắn 1-1 giữa ${currentUserId} và ${otherUserId}`);

    const result = await searchMessagesBetweenUsers(currentUserId, otherUserId, keyword);
    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchMessagesBetweenUsersController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

// 5. Search messages in group conversation
const searchMessagesInGroupController = async (req, res) => {
  try {
    const { groupId, keyword } = req.query;
    const currentUserId = req.user.userId;

    validateId(groupId, 'group');
    validateKeyword(keyword);
    logger.info(`Tìm kiếm tin nhắn nhóm ${groupId} bởi ${currentUserId}`);

    const result = await searchMessagesInGroup(currentUserId, groupId, keyword);
    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchMessagesInGroupController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

// 6. Search all (users, 1-1 messages, group messages)
const searchAllController = async (req, res) => {
  try {
    const { keyword } = req.query;
    const currentUserId = req.user.userId;

    validateKeyword(keyword);
    logger.info(`Tìm kiếm toàn bộ với từ khóa: ${keyword} bởi ${currentUserId}`);

    const result = await searchAll(currentUserId, keyword);
    res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    logger.error('Lỗi trong searchAllController:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
};

module.exports = {
  searchUsersByNameController,
  searchFriendsByPhoneNumberController,
  searchAllUsersByPhoneNumberController,
  searchMessagesBetweenUsersController,
  searchMessagesInGroupController,
  searchAllController,
};