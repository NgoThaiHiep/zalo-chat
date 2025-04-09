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
  restoreMessageController
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

module.exports = router;