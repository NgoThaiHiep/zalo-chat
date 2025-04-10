const express = require('express');
const router = express.Router();
const FriendController = require('../controllers/friendController');
const {authMiddleware, checkOwnership } = require('../middlewares/authMiddleware');

router.use(authMiddleware); // Bảo vệ tất cả route bằng JWT

router.post('/send', FriendController.sendFriendRequestController);
router.get('/received', FriendController.getReceivedFriendRequestsController); // Yêu cầu đã nhận
router.get('/sent', FriendController.getSentFriendRequestsController);         // Yêu cầu đã gửi
router.post('/accept', FriendController.acceptFriendRequestController);     //Chấp nhận kết bạn
router.post('/reject', FriendController.rejectFriendRequestController);     //Từ chối kết bạn
router.get('/list', FriendController.getFriendsController);                 // Danh sách bạn bè
router.post('/cancel', FriendController.cancelFriendRequestController);    // Hủy yêu cầu
router.post('/block', FriendController.blockUserController);              // Chặn
router.get('/blocked', FriendController.getBlockedUsersController);       // Danh sách chặn
router.post('/unblock', FriendController.unblockUserController);          // Xóa chặn
router.post('/remove', FriendController.removeFriendController);          // Xóa bạn
router.get('/search', FriendController.searchUsersController);             //Tìm kiếm người dùng

router.get('/suggestions', FriendController.getFriendSuggestionsController); //Gợi ý kết bạn
router.get('/status/:targetUserId', FriendController.getUserStatusController); //Kiểm tra trạng thái bạn bè/người lạ
router.get('/profile/:targetUserId', FriendController.getUserProfileController);//Ẩn trạng thái với người lạ
router.post('/favorite/mark', FriendController.markFavoriteController);//Đánh dấu bạn bè yêu thích.
router.post('/favorite/unmark', FriendController.unmarkFavoriteController);//Bỏ đánh dấu yêu thích.
router.get('/favorites', FriendController.getFavoriteFriendsController); //Lấy danh sách bạn bè yêu thích.
router.get('/mutual/:targetUserId', FriendController.getMutualFriends); //Nhóm bạn chung
module.exports = router;