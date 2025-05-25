const express = require('express');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');
const {
  assignMemberRoleController,
  createGroupController,
  getGroupJoinRequestsController,
  approveJoinRequestController,
  rejectJoinRequestController,
  updateGroupInfoController,
  joinGroupController,
  addMemberToGroupController,
  getGroupInfoController,
  leaveGroupController,
  deleteGroupController,
  kickMemberController,
  sendGroupMessageController,
  recallGroupMessageController,
  pinGroupMessageController,
  deleteGroupMessageController,
  restoreGroupMessageController,
  getGroupMembersController,
  updateCommunitySettingsController,
  generateGroupLinkController,
  getUserGroupsController,
  getGroupMessagesController,
  forwardGroupMessageToUserController,
  forwardGroupMessageController,
 
} = require('../controllers/groupController');
const { uploadProfileImages } = require('../middlewares/uploadMiddleware');
const upload = require('../middlewares/upload');
const router = express.Router();

router.use(authMiddleware);
// Tạo nhóm mới
router.post('/create', createGroupController);

// Cập nhật thông tin nhóm
router.put('/info/:groupId',  upload.single('avatar'),updateGroupInfoController );


// Tham gia nhóm
router.post('/join/:groupId', joinGroupController);

// Thêm thành viên vào nhóm
router.post('/members/:groupId', addMemberToGroupController);

// Phê duyệt yêu cầu tham gia nhóm
router.put('/requests/:groupId/:userId', approveJoinRequestController);

// lấy danh sách yêu cầu tham gia nhóm
router.get('/join-requests', authMiddleware, getGroupJoinRequestsController);

// Từ chối yêu cầu tham gia nhóm
router.post('/join-request/reject', authMiddleware, rejectJoinRequestController);

// Lấy thông tin nhóm
router.get('/infoGroup/:groupId', getGroupInfoController);

// Rời nhóm
router.delete('/leave/:groupId', leaveGroupController);

// Xóa nhóm
router.delete('/:groupId', deleteGroupController);

// Đá thành viên khỏi nhóm
router.delete('/members/:groupId/:targetUserId', kickMemberController);

// Cập nhật vai trò thành viên nhóm
router.post('/assignRole', assignMemberRoleController);

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

// Xóa tin nhắn ghim trong nhóm
router.delete('/pin/messages/:groupId/:messageId', pinGroupMessageController);

router.delete('/pin/messages/:groupId/:messageId', pinGroupMessageController); // Bỏ ghim tin nhắn nhóm
module.exports = router;