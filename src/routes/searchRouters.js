const express = require('express');
const router = express.Router();
const {
  searchUsersByNameController,
  searchFriendsByPhoneNumberController,
  searchAllUsersByPhoneNumberController,
  searchMessagesBetweenUsersController,
  searchMessagesInGroupController,
  searchAllController,
} = require('../controllers/searchController');
const {authMiddleware} = require('../middlewares/authMiddleware'); // Assuming you have an auth middleware

// Routes for search functionality
router.get('/users/by-name', authMiddleware, searchUsersByNameController); // Search users by name
router.get('/friends/by-phone', authMiddleware, searchFriendsByPhoneNumberController); // Search friends by phone
router.get('/users/by-phone', authMiddleware, searchAllUsersByPhoneNumberController); // Search all users by phone
router.get('/messages/1-1', authMiddleware, searchMessagesBetweenUsersController); // Search 1-1 messages
router.get('/messages/group', authMiddleware, searchMessagesInGroupController); // Search group messages
router.get('/all', authMiddleware, searchAllController); // Search all (users, 1-1 messages, group messages)

module.exports = router;