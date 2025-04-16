const SearchService = require('../services/search.service');
const { AppError } = require('../utils/errorHandler');

// Tìm kiếm toàn bộ (người dùng và tin nhắn)
const searchAllController = async (req, res) => {
  const { keyword } = req.query;
  const userId = req.user.id;

  try {
    if (!keyword) {
      throw new AppError('Vui lòng cung cấp từ khóa tìm kiếm', 400);
    }

    const result = await SearchService.searchAll(userId, keyword);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm',
    });
  }
};

// Tìm kiếm tin nhắn giữa hai người dùng
const searchMessagesBetweenUsersController = async (req, res) => {
  const { otherUserId, keyword } = req.query;
  const userId = req.user.id;

  try {
    if (!otherUserId || !keyword) {
      throw new AppError('Vui lòng cung cấp otherUserId và từ khóa tìm kiếm', 400);
    }

    const result = await SearchService.searchMessagesBetweenUsers(userId, otherUserId, keyword);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm tin nhắn',
    });
  }
};

// Tìm kiếm người dùng theo tên hoặc số điện thoại
const searchUsersByNameAndPhoneController = async (req, res) => {
  const { keyword } = req.query;
  const userId = req.user.id;

  try {
    if (!keyword) {
      throw new AppError('Vui lòng cung cấp từ khóa tìm kiếm', 400);
    }

    const result = await SearchService.searchUsersByNameAndPhone(userId, keyword);
    res.status(200).json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm người dùng',
    });
  }
};

module.exports = {
  searchAllController,
  searchMessagesBetweenUsersController,
  searchUsersByNameAndPhoneController,
};