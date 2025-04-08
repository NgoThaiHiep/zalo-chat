const express = require('express');
const authMiddleware = require('../middlewares/authMiddleware');
const {
  createGroupController,
  joinGroupController,
  leaveGroupController,
  kickMemberController,
  deleteGroupController,
  getUserGroupsController,
  sendGroupMessageController,
  getGroupMessagesController,
  forwardGroupMessageController,
  recallGroupMessageController,
  pinGroupMessageController,
  setReminderController,
  deleteGroupMessageController,
  restoreGroupMessageController,
} = require('../controllers/groupController');

const router = express.Router();

router.post('/create', authMiddleware, createGroupController);
router.post('/:groupId/join', authMiddleware, joinGroupController);
router.post('/:groupId/leave', authMiddleware, leaveGroupController);
router.post('/:groupId/kick', authMiddleware, kickMemberController);
router.delete('/:groupId', authMiddleware, deleteGroupController);
router.get('/list', authMiddleware, getUserGroupsController);
router.post('/:groupId/messages', authMiddleware, sendGroupMessageController);
router.post('/:groupId/forward', authMiddleware, forwardGroupMessageController);
router.patch('/:groupId/messages/:messageId/recall', authMiddleware, recallGroupMessageController);
router.patch('/:groupId/pin', authMiddleware, pinGroupMessageController);
router.patch('/:groupId/messages/:messageId/remind', authMiddleware, setReminderController);
router.delete('/:groupId/messages/:messageId', authMiddleware, deleteGroupMessageController);
router.patch('/:groupId/messages/:messageId/restore', authMiddleware, restoreGroupMessageController);
router.get('/:groupId/messages', authMiddleware, getGroupMessagesController);

module.exports = router;