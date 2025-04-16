const express = require('express');
const { 
  sendMessageController, 
  getMessagesBetweenController,

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


  checkBlockStatusController,
  searchMessagesBetweenUsers,
  getConversationSummaryController
} = require('../controllers/messageController');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');

const router = express.Router();

// Nhóm: Gửi và lấy tin nhắn
router.post('/send', authMiddleware, sendMessageController);// Gửi tin nhắn
router.get('/user/:userId', authMiddleware, getMessagesBetweenController); // Lấy tin nhắn giữa hai người dùng trong đoạn hội thoại
router.get('/summary', authMiddleware, getConversationSummaryController); // Lấy tóm tắt hội người nhận với nhiều người


// Nhóm: Chuyển tiếp và thu hồi tin nhắn
router.post('/forward', authMiddleware, forwardMessageController); // Chuyển tiếp tin nhắn
router.patch('/recall/:messageId', authMiddleware, recallMessageController);// Thu hồi tin nhắn

// Nhóm: Ghim tin nhắn
router.route('/pin/:messageId')
      .patch( authMiddleware, pinMessageController) // Ghim tin nhắn
      .delete( authMiddleware, unpinMessageController); // Bỏ ghim tin nhắn
router.get('/pinned/:otherUserId', authMiddleware, getPinnedMessagesController); // Lấy danh sách tin nhắn đã ghim

// Nhóm: Nhắc nhở tin nhắn
router.route('/reminder/:messageId')
      .patch( authMiddleware, setReminderController) // Đặt nhắc nhở
      .delete( authMiddleware, unsetReminderController) // Xóa nhắc nhở
      .put(authMiddleware, editReminderController); // Sửa nhắc nhở
router.get('/reminders/:otherUserId', authMiddleware, getRemindersBetweenUsersController); // Lấy danh sách nhắc nhở
router.get('/reminder-history/:otherUserId', authMiddleware, getReminderHistoryController); // Lấy lịch sử nhắc nhở

// Nhóm: Xóa và khôi phục tin nhắn
router.delete('/:messageId', authMiddleware, deleteMessageController); // Xóa tin nhắn
router.patch('/:messageId/restore', authMiddleware, restoreMessageController) ; // Khôi phục tin nhắn

// Nhóm: Các hành động khác
router.post('/retry',authMiddleware, retryMessageController); // Thử gửi lại tin nhắn
router.patch('/seen/:messageId', authMiddleware,markMessageAsSeenController); // Đánh dấu tin nhắn đã xem
router.get('/check-block-status', authMiddleware, checkBlockStatusController); // Kiểm tra trạng thái chặn
router.get('/search', authMiddleware, searchMessagesBetweenUsers); // Tìm kiếm tin nhắn


module.exports = router;



