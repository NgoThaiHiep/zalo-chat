const express = require('express');
const {
    muteConversationController,
    getMutedConversationsController,
    hideConversationController,
    unhideConversationController,
    getHiddenConversationsController,
    setAutoDeleteSettingController,
    getAutoDeleteSettingController,
    pinConversationController,
    unpinConversationController,
    createConversationController,
    getConversationController,
    getPinnedConversationsController,
    getConversationSummaryController,

}= require('../controllers/conversationController');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/create', createConversationController);
router.get('/', getConversationController); // Lấy hội thoại giữa 2 người dùng

// Tắt thông báo hội thoại
router.route('/mute')
  .post(authMiddleware, muteConversationController) // Tắt thông báo hội thoại
  .get(authMiddleware, getMutedConversationsController); // Lấy danh sách hội thoại bị tắt thông báo


router.route('/hide')
        .post( authMiddleware, hideConversationController) //Ản hội thoại
        .get( authMiddleware, getHiddenConversationsController); // Lấy danh sách hội thoại ẩn
router.post('/unhide', authMiddleware, unhideConversationController); //Bỏ ẩn hội thoại
router.get('/summary', authMiddleware, getConversationSummaryController); // Lấy tóm tắt hội người nhận với nhiều người

//ghim hội thoại
router.post('/pin-conversation', authMiddleware, pinConversationController); // Ghim hội thoại
router.post('/unpin-conversation', authMiddleware, unpinConversationController);// Ghim hội thoại


//tự động xóa tin nhắn
router.post('/set-auto-delete', authMiddleware, setAutoDeleteSettingController);// Cài đặt tự động xóa
router.get('/get-auto-delete/:targetUserId', authMiddleware, getAutoDeleteSettingController);// Lấy cài đặt tự động xóa

module.exports = router;