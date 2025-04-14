const express = require('express');
const { 
  sendMessageController, 
  getMessagesBetweenController, 
  getConversationUsers,
  forwardMessageController,
  recallMessageController,
  pinMessageController,
  unpinMessageController,
  getPinnedMessagesController,

  setReminderController,
  unsetReminderController,
  getRemindersBetweenUsersController,
  getReminderHistoryController,
  editReminderController,
  
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

router.post('/send', authMiddleware, sendMessageController);
router.get('/user/:userId', authMiddleware, getMessagesBetweenController);
router.get('/conversations', authMiddleware, getConversationUsers);
router.post('/forward', authMiddleware, forwardMessageController);
router.patch('/recall/:messageId', authMiddleware, recallMessageController);

router.patch('/pin/:messageId', authMiddleware, pinMessageController);
router.patch('/unpin/:messageId', authMiddleware, unpinMessageController);
router.get('/pinned/:otherUserId', authMiddleware, getPinnedMessagesController);

router.patch('/remind/:messageId', authMiddleware, setReminderController);
router.delete('/reminder/:messageId', authMiddleware, unsetReminderController);
router.patch('/reminder/:messageId', authMiddleware, editReminderController);
router.get('/reminders/:otherUserId', authMiddleware, getRemindersBetweenUsersController);
router.get('/reminder-history/:otherUserId', authMiddleware, getReminderHistoryController);

router.delete('/:messageId', authMiddleware, deleteMessageController);
router.patch('/:messageId/restore', authMiddleware, restoreMessageController);
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

