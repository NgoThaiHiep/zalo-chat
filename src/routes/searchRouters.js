const express = require('express');
const router = express.Router();
const {
  searchAllController,
  searchMessagesBetweenUsersController,
  searchUsersByNameAndPhoneController,
} = require('../controllers/searchController');
const {authMiddleware} = require('../middlewares/authMiddleware');

// Route tìm kiếm toàn bộ (người dùng và tin nhắn)
router.get('/search', authMiddleware, searchAllController);

// Route tìm kiếm tin nhắn giữa hai người dùng
router.get('/search/messages', authMiddleware, searchMessagesBetweenUsersController);

// Route tìm kiếm người dùng theo tên hoặc số điện thoại
router.get('/search/users', authMiddleware, searchUsersByNameAndPhoneController);

module.exports = router;