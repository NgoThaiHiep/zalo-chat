const express = require('express');
const router = express.Router();
const FriendController = require('../controllers/friendController');
const {authMiddleware, checkOwnership } = require('../middlewares/authMiddleware');

router.use(authMiddleware); // Bảo vệ tất cả route bằng JWT

// Nhóm: Quản lý yêu cầu kết bạn
router.post('/send', FriendController.sendFriendRequestController);     // Gửi yêu cầu kết bạn
router.get('/received', FriendController.getReceivedFriendRequestsController); // Lấy yêu cầu kết bạn đã nhận
router.get('/sent', FriendController.getSentFriendRequestsController);        // Lấy yêu cầu kết bạn đã gửi
router.post('/accept', FriendController.acceptFriendRequestController);     // Chấp nhận kết bạn
router.post('/reject', FriendController.rejectFriendRequestController);     //Từ chối kết bạn
router.post('/cancel', FriendController.cancelFriendRequestController);    // Hủy yêu cầu kêt bạn

// Nhóm: Quản lý danh sách bạn bè
router.get('/list', FriendController.getFriendsController);     
router.post('/remove', checkOwnership, FriendController.removeFriendController);             // Lấy danh sách bạn bè
router.post('/favorite/mark', FriendController.markFavoriteController);  //Đánh dấu bạn bè yêu thích.
router.post('/favorite/unmark', FriendController.unmarkFavoriteController);//Bỏ đánh dấu yêu thích.
router.get('/favorites', FriendController.getFavoriteFriendsController); //Lấy danh sách bạn bè yêu thích.
router.get('/mutual/:targetUserId', FriendController.getMutualFriends); //Lấy bạn chung

// Nhóm: Quản lý chặn người dùng
router.post('/block',checkOwnership, FriendController.blockUserController);              // Chặn người dùng
router.get('/blocked', FriendController.getBlockedUsersController);       // Lấy danh sách người bị chặn
router.post('/unblock',checkOwnership, FriendController.unblockUserController);          // Bỏ chặn người dùng

// Nhóm: Tìm kiếm và hồ sơ
// router.get('/search', FriendController.searchUsersController);             // Tìm kiếm người dùng
router.get('/suggestions', FriendController.getFriendSuggestionsController); //Gợi ý kết bạn
router.get('/status/:targetUserId', FriendController.getUserStatusController); //Kiểm tra trạng thái bạn bè/người lạ
router.get('/profile/:targetUserId', FriendController.getUserProfileController); // Lấy thông tin người dùng

// Nhóm: Quản lý biệt danh
router.post('/nickname', authMiddleware, FriendController. setConversationNicknameController); // Đặt biệt danh hội thoại
router.get('/nickname/:targetUserId', authMiddleware, FriendController.getConversationNicknameController); //Lấy biệt danh hội thoại

module.exports = router;