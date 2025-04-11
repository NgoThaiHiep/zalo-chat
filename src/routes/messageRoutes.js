const express = require('express');
const { 
  sendMessage, 
  getMessages, 
  getConversationUsers,
  forwardMessageController,
  recallMessageController,
  pinMessageController,
  setReminderController,
  deleteMessageController,
  restoreMessageController,
  retryMessageController,
  markMessageAsSeenController,
  muteConversationController,
  hideConversationController,
  unhideConversationController,
  setConversationNicknameController,
  checkBlockStatusController,
  setAutoDeleteSettingController,
  getAutoDeleteSettingController,
} = require('../controllers/messageController');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/send', authMiddleware, sendMessage);
router.get('/user/:userId', authMiddleware, getMessages);
router.get('/conversations', authMiddleware, getConversationUsers);
router.post('/forward', authMiddleware, forwardMessageController);
router.patch('/messages/:messageId/recall', authMiddleware, recallMessageController);
router.patch('/messages/:messageId/pin', authMiddleware, pinMessageController);
router.patch('/messages/:messageId/remind', authMiddleware, setReminderController);
router.delete('/messages/:messageId', authMiddleware, deleteMessageController);
router.patch('/messages/:messageId/restore', authMiddleware, restoreMessageController);
router.post('/api/messages/retry', retryMessageController);
router.patch('/api/messages/:messageId/seen', markMessageAsSeenController);
router.post('/mute', authMiddleware, muteConversationController);
router.post('/hide', authMiddleware, hideConversationController);
router.post('/unhide', authMiddleware, unhideConversationController);
router.post('/nickname', authMiddleware, setConversationNicknameController);
router.get('/check-block-status', authMiddleware, checkBlockStatusController);
router.post('/set-auto-delete', authMiddleware, setAutoDeleteSettingController);
router.get('/get-auto-delete/:targetUserId', authMiddleware, getAutoDeleteSettingController);
module.exports = router;