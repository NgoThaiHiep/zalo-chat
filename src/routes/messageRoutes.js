const express = require('express');
const { 
  sendMessage, 
  getMessagesBetweenController, 
  getConversationUsers,
  forwardMessageController,
  recallMessageController,
  pinMessageController,
  unpinMessageController,
  getPinnedMessagesController,
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
router.get('/user/:userId', authMiddleware, getMessagesBetweenController);
router.get('/conversations', authMiddleware, getConversationUsers);
router.post('/forward', authMiddleware, forwardMessageController);
router.patch('recall/:messageId/', authMiddleware, recallMessageController);

router.patch('/pin/:messageId', authMiddleware, pinMessageController);
router.patch('/unpin/:messageId', authMiddleware, unpinMessageController);
router.get('/pinned/:otherUserId', authMiddleware, getPinnedMessagesController);

router.patch('/remind/:messageId', authMiddleware, setReminderController);
router.delete('/:messageId', authMiddleware, deleteMessageController);
router.patch(':messageId/restore', authMiddleware, restoreMessageController);
router.post('/retry', retryMessageController);
router.patch('/seen/:messageId', markMessageAsSeenController);
router.post('/mute', authMiddleware, muteConversationController);
router.post('/hide', authMiddleware, hideConversationController);
router.post('/unhide', authMiddleware, unhideConversationController);
router.post('/nickname', authMiddleware, setConversationNicknameController);
router.get('/check-block-status', authMiddleware, checkBlockStatusController);
router.post('/set-auto-delete', authMiddleware, setAutoDeleteSettingController);
router.get('/get-auto-delete/:targetUserId', authMiddleware, getAutoDeleteSettingController);

module.exports = router;

