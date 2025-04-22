const express = require('express');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');
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
  forwardGroupMessageToUserController,
  recallGroupMessageController,
  pinGroupMessageController,
  getGroupMembersController,
  updateGroupInfoController,
  updateCommunitySettingsController,
  generateGroupLinkController,
  approveJoinRequestController,
  addMemberToGroupController,
  getGroupInfoController,
  deleteGroupMessageController,
  restoreGroupMessageController,
} = require('../controllers/groupController');

const router = express.Router();

router.use(authMiddleware);
// Tạo nhóm mới
router.post('/create', createGroupController);

// Cập nhật thông tin nhóm
router.put('/:groupId', updateGroupInfoController);

// Tham gia nhóm
router.post('/join/:groupId', joinGroupController);

// Thêm thành viên vào nhóm
router.post('/members/:groupId', addMemberToGroupController);

// Phê duyệt yêu cầu tham gia nhóm
router.put('/requests/:groupId/:userId', approveJoinRequestController);

// Lấy thông tin nhóm
router.get('/:groupId', getGroupInfoController);

// Rời nhóm
router.delete('/leave/:groupId', leaveGroupController);

// Xóa nhóm
router.delete('/:groupId', deleteGroupController);

// Đá thành viên khỏi nhóm
router.delete('/members/:groupId/:targetUserId', kickMemberController);

// Gửi tin nhắn nhóm
router.post('/messages/:groupId', sendGroupMessageController);

// Chuyển tiếp tin nhắn nhóm
router.post('/forward-to-user', authMiddleware, forwardGroupMessageToUserController); // Chuyển tiếp tin nhắn từ nhóm đến người dùng
router.post('/forward-to-group', authMiddleware, forwardGroupMessageController); // Chuyển tiếp tin nhắn đến nhóm

// Thu hồi tin nhắn nhóm
router.put('/recall/messages/:groupId/:messageId', recallGroupMessageController);

// Ghim tin nhắn nhóm
router.put('/pin/messages/:groupId/:messageId', pinGroupMessageController);

// Xóa tin nhắn nhóm
router.delete('/messages/:groupId/:messageId', deleteGroupMessageController);

// Khôi phục tin nhắn nhóm
router.put('/restore/messages/:groupId/:messageId', restoreGroupMessageController);

// Lấy danh sách thành viên nhóm
router.get('/members/:groupId', getGroupMembersController);

// Cập nhật cài đặt cộng đồng
router.put('/settings/:groupId', updateCommunitySettingsController);

// Tạo link tham gia nhóm
router.get('/link/:groupId', generateGroupLinkController);

// Lấy danh sách nhóm của người dùng
router.get('/listGroup', getUserGroupsController);

// Lấy tin nhắn nhóm
router.get('/messages/:groupId', getGroupMessagesController);

module.exports = router;