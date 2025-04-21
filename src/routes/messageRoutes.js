const express = require('express');
const { 
  sendMessageController, 
  getMessagesBetweenController,

  forwardMessageController,
  forwardMessageToGroupController,
  recallMessageController,

  pinMessageController,
  unpinMessageController,
  getPinnedMessagesController,

  deleteMessageController,
  restoreMessageController,
  retryMessageController,
  markMessageAsSeenController,


  checkBlockStatusController,
 
  getConversationSummaryController
} = require('../controllers/messageController');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');

const router = express.Router();

// Nhóm: Gửi và lấy tin nhắn
router.post('/send', authMiddleware, sendMessageController);// Gửi tin nhắn
router.get('/user/:userId', authMiddleware, getMessagesBetweenController); // Lấy tin nhắn giữa hai người dùng trong đoạn hội thoại



// Nhóm: Chuyển tiếp và thu hồi tin nhắn
router.post('/forward', authMiddleware, forwardMessageController); // Chuyển tiếp tin nhắn
router.post('/forward-to-group', authMiddleware, forwardMessageToGroupController); // Chuyển tiếp tin nhắn đến nhóm
router.patch('/recall/:messageId', authMiddleware, recallMessageController);// Thu hồi tin nhắn

// Nhóm: Ghim tin nhắn
router.route('/pin/:messageId')
      .patch( authMiddleware, pinMessageController) // Ghim tin nhắn
      .delete( authMiddleware, unpinMessageController); // Bỏ ghim tin nhắn
router.get('/pinned/:otherUserId', authMiddleware, getPinnedMessagesController); // Lấy danh sách tin nhắn đã ghim


// Nhóm: Xóa và khôi phục tin nhắn
router.delete('/:messageId', authMiddleware, deleteMessageController); // Xóa tin nhắn
router.patch('/:messageId/restore', authMiddleware, restoreMessageController) ; // Khôi phục tin nhắn

// Nhóm: Các hành động khác
router.post('/retry',authMiddleware, retryMessageController); // Thử gửi lại tin nhắn
router.patch('/seen/:messageId', authMiddleware,markMessageAsSeenController); // Đánh dấu tin nhắn đã xem
router.get('/check-block-status', authMiddleware, checkBlockStatusController); // Kiểm tra trạng thái chặn



module.exports = router;



