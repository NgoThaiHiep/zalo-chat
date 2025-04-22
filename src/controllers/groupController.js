const groupService = require('../services/group.service');
const logger = require('../config/logger');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/heic', 'image/gif',
      'video/mp4',
      'audio/mpeg', 'audio/wav', 'audio/mp4',
      'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/vnd.rar', 'text/plain',
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('MIME type không được hỗ trợ!'), false);
    }
  },
});
const { uploadProfileImages } = require('../middlewares/uploadMiddleware');

// Controller: Lấy danh sách yêu cầu tham gia nhóm
const getGroupJoinRequestsController = async (req, res, next) => {
  try {
    const { groupId } = req.query;
    const adminUserId = req.user.id;
    const { status = 'pending', limit = 50, lastEvaluatedKey } = req.query;

    const result = await groupService.getGroupJoinRequests(groupId, adminUserId, status, parseInt(limit), lastEvaluatedKey ? JSON.parse(lastEvaluatedKey) : null);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Lỗi trong getGroupJoinRequestsController:', error.message);
    next(error);
  }
};

const assignMemberRoleController = async (req, res) => {
  try {
    const { groupId, userId: targetUserId, role } = req.body;
    const requestingUserId = req.user.id; // Lấy từ authMiddleware

    logger.info('Gán vai trò cho thành viên nhóm', { groupId, targetUserId, role, requestingUserId });

    const result = await groupService.assignMemberRole(groupId, targetUserId, role, requestingUserId);

    res.status(200).json({
      success: true,
      message: 'Gán vai trò thành công!',
      data: result,
    });
  } catch (error) {
    logger.error('Lỗi khi gán vai trò cho thành viên nhóm', { error: error.message });
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Lỗi server khi gán vai trò',
    });
  }
};

const createGroupController = async (req, res) => {
    try {
      const { name, members, initialRoles } = req.body;
      const createdBy = req.user.id; // Lấy từ middleware xác thực
      const newGroup = await groupService.createGroup(name, createdBy, members, initialRoles);
      res.status(201).json({
        success: true,
        message: 'Tạo nhóm thành công!',
        data: newGroup,
      });
    } catch (error) {
      logger.error('Lỗi khi tạo nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi tạo nhóm',
      });
    }
};
// Controller: Cập nhật thông tin nhóm 

const updateGroupInfoController = async (req, res, next) => {
  try {
    const userId = req.user.id; // hoặc req.auth.id tùy vào middleware
    const { groupId } = req.params;
    const { name } = req.body;
    const avatarFile = req.file; // Multer upload.single('avatar') sẽ gán file vào đây

    const result = await groupService.updateGroupInfo(groupId, userId, {
      name,
      avatarFile,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('❌ Lỗi trong updateGroupInfoController:', error.message);
    return next(error); // chuyển lỗi cho middleware xử lý lỗi chung
  }
};
  
  const joinGroupController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const result = await groupService.joinGroup(groupId, userId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi tham gia nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi tham gia nhóm',
      });
    }
  };
  
  const addMemberToGroupController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const { newUserId } = req.body;
      const inviterId = req.user.id;
      const result = await groupService.addMemberToGroup(groupId, inviterId, newUserId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi thêm thành viên vào nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi thêm thành viên vào nhóm',
      });
    }
  };
  
// Controller: Phê duyệt yêu cầu tham gia nhóm
const approveJoinRequestController = async (req, res, next) => {
  try {
    const { groupId, userId, approve, reason } = req.body;
    const adminUserId = req.user.id;

    const result = await groupService.approveJoinRequest(groupId, adminUserId, userId, approve, reason);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Lỗi trong approveJoinRequestController:', error.message);
    next(error);
  }
};

// Controller: Từ chối yêu cầu tham gia nhóm
const rejectJoinRequestController = async (req, res, next) => {
  try {
    const { groupId, userId, reason } = req.body;
    const adminUserId = req.user.id;

    const result = await groupService.rejectJoinRequest(groupId, adminUserId, userId, reason);
    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Lỗi trong rejectJoinRequestController:', error.message);
    next(error);
  }
};

  const getGroupInfoController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const groupInfo = await groupService.getGroupInfo(groupId, userId);
      res.status(200).json({
        success: true,
        message: 'Lấy thông tin nhóm thành công!',
        data: groupInfo,
      });
    } catch (error) {
      logger.error('Lỗi khi lấy thông tin nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi lấy thông tin nhóm',
      });
    }
  };
  
  const leaveGroupController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const result = await groupService.leaveGroup(groupId, userId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi rời nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi rời nhóm',
      });
    }
  };
  
  const deleteGroupController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const adminUserId = req.user.id;
      const result = await groupService.deleteGroup(groupId, adminUserId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi xóa nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi xóa nhóm',
      });
    }
  };
  
  const kickMemberController = async (req, res) => {
    try {
      const { groupId, targetUserId } = req.params;
      const adminUserId = req.user.id;
      const result = await groupService.kickMember(groupId, adminUserId, targetUserId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi đá thành viên', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi đá thành viên',
      });
    }
  };
  
  const sendGroupMessageController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const senderId = req.user.id;
      const { type, content, isAnonymous, isSecret, quality, replyToMessageId, metadata } = req.body;
      const file = req.file; // Lấy file từ req.file (do multer xử lý)
  
      // Tạo messageData với đầy đủ thông tin, bao gồm file
      const messageData = {
        type,
        content,
        file: file ? file.buffer : null, // Dữ liệu nhị phân của file
        fileName: file ? file.originalname : null, // Tên file gốc
        mimeType: file ? file.mimetype : null, // MIME type của file
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata, // Xử lý metadata nếu có
        isAnonymous: isAnonymous === true || isAnonymous === 'true',
        isSecret: isSecret === true || isSecret === 'true',
        quality,
        replyToMessageId,
      };
  
      logger.info('Gửi tin nhắn nhóm', { groupId, senderId, messageData });
  
      const message = await groupService.sendGroupMessage(groupId, senderId, messageData);
      res.status(200).json({
        success: true,
        message: 'Gửi tin nhắn nhóm thành công!',
        data: message,
      });
    } catch (error) {
      logger.error('Lỗi khi gửi tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi gửi tin nhắn nhóm',
      });
    }
  };

// Controller: Chuyển tiếp tin nhắn nhóm đến người dùng
  const forwardGroupMessageToUserController = async (req, res) => {
    try {
      console.log('Request body:', req.body);
      const { messageId, sourceGroupId, targetReceiverId } = req.body;
      const senderId = req.user.id;
      console.log('Sender ID:', senderId);
      console.log('Forward group message to user request:', {
        senderId,
        messageId,
        sourceGroupId,
        targetReceiverId,
      });
  
      // Kiểm tra đầu vào
      if (!messageId || !sourceGroupId || !targetReceiverId) {
        return res.status(400).json({
          success: false,
          message: 'Thiếu messageId, sourceGroupId hoặc targetReceiverId',
        });
      }
  
      const result = await groupService.forwardGroupMessageToUser(
        senderId,
        messageId,
        sourceGroupId,
        targetReceiverId
      );
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.error('Error in forwardGroupMessageToUserController:', error);
      const statusCode =
        error.message.includes('là bắt buộc') ||
        error.message.includes('Thiếu') ||
        error.message.includes('Tham số không hợp lệ')
          ? 400
          : error.message.includes('không tồn tại') || error.message.includes('quyền')
          ? 403
          : 500;
      return res.status(statusCode).json({ success: false, message: error.message });
    }
  };

// Controller: Chuyển tiếp tin nhắn nhóm đến nhóm khác
  const forwardGroupMessageController = async (req, res) => {
    try {
      console.log('Request body:', req.body);
      const { messageId, sourceGroupId, targetGroupId } = req.body;
      const senderId = req.user.id;
      console.log('Sender ID:', senderId);
      console.log('Forward group message request:', {
        senderId,
        messageId,
        sourceGroupId,
        targetGroupId,
      });
  
      // Kiểm tra đầu vào
      if (!messageId || !sourceGroupId || !targetGroupId) {
        return res.status(400).json({
          success: false,
          message: 'Thiếu messageId, sourceGroupId hoặc targetGroupId',
        });
      }
  
      const result = await groupService.forwardGroupMessage(
        senderId,
        messageId,
        sourceGroupId,
        targetGroupId
      );
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.error('Error in forwardGroupMessageController:', error);
      const statusCode =
        error.message.includes('là bắt buộc') ||
        error.message.includes('Thiếu') ||
        error.message.includes('Tham số không hợp lệ')
          ? 400
          : error.message.includes('không tồn tại') || error.message.includes('quyền')
          ? 403
          : 500;
      return res.status(statusCode).json({ success: false, message: error.message });
    }
  };

// Controller: Thu hồi tin nhắn nhóm
  const recallGroupMessageController = async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const { recallType } = req.body;
      const senderId = req.user.id;
      const result = await groupService.recallGroupMessage(groupId, senderId, messageId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi thu hồi tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi thu hồi tin nhắn nhóm',
      });
    }
  };
  
  const pinGroupMessageController = async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const senderId = req.user.id;
      const result = await groupService.pinGroupMessage(groupId, senderId, messageId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi ghim tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi ghim tin nhắn nhóm',
      });
    }
  };
  
  const deleteGroupMessageController = async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const { deleteType } = req.body;
      const senderId = req.user.id;
      const result = await groupService.deleteGroupMessage(groupId, senderId, messageId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi xóa tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi xóa tin nhắn nhóm',
      });
    }
  };
  
  const restoreGroupMessageController = async (req, res) => {
    try {
      const { groupId, messageId } = req.params;
      const senderId = req.user.id;
      const result = await groupService.restoreGroupMessage(groupId, senderId, messageId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi khôi phục tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi khôi phục tin nhắn nhóm',
      });
    }
  };
  
// Controller: Lấy danh sách thành viên nhóm
  const getGroupMembersController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const members = await groupService.getGroupMembers(groupId, userId);
      res.status(200).json({
        success: true,
        message: 'Lấy danh sách thành viên nhóm thành công!',
        data: members,
      });
    } catch (error) {
      logger.error('Lỗi khi lấy danh sách thành viên nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi lấy danh sách thành viên nhóm',
      });
    }
  };
// Controller: Cập nhật cài đặt cộng đồng
  const updateCommunitySettingsController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const adminUserId = req.user.id;
      const settings = req.body;
      const result = await groupService.updateCommunitySettings(groupId, adminUserId, settings);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi cập nhật cài đặt cộng đồng', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi cập nhật cài đặt cộng đồng',
      });
    }
  };
  
  const generateGroupLinkController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const result = await groupService.generateGroupLink(groupId, userId);
      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error) {
      logger.error('Lỗi khi tạo link nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi tạo link nhóm',
      });
    }
  };

// Controller: Lấy danh sách nhóm của người dùng
  const getUserGroupsController = async (req, res) => {
    try {
    
      const userId = req.user.id; // Chuyển thành chuỗi và loại bỏ khoảng trắng
      const groups = await groupService.getUserGroups(userId);
      res.status(200).json({
        success: true,
        message: 'Lấy danh sách nhóm thành công!',
        data: groups,
      });
    } catch (error) {
      logger.error('Lỗi khi lấy danh sách nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi lấy danh sách nhóm',
      });
    }
  };
// Controller: Lấy danh sách tin nhắn nhóm
  const getGroupMessagesController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const userId = req.user.id;
      const { limit, lastEvaluatedKey } = req.query;
      const messages = await groupService.getGroupMessages(groupId, userId, limit, lastEvaluatedKey);
      res.status(200).json({
        success: true,
        message: 'Lấy tin nhắn nhóm thành công!',
        data: messages,
      });
    } catch (error) {
      logger.error('Lỗi khi lấy tin nhắn nhóm', { error: error.message });
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Lỗi server khi lấy tin nhắn nhóm',
      });
    }
  };

module.exports = {
    assignMemberRoleController,
    createGroupController,
    joinGroupController,
    leaveGroupController,
    kickMemberController,
    deleteGroupController,
    getUserGroupsController,
    sendGroupMessageController: [upload.single('file'), sendGroupMessageController],
    getGroupMessagesController,
    forwardGroupMessageToUserController,
    forwardGroupMessageController,
    recallGroupMessageController,
    pinGroupMessageController,
    getGroupMembersController,
    updateGroupInfoController,
    updateCommunitySettingsController,
    generateGroupLinkController,
    approveJoinRequestController,
    rejectJoinRequestController,
    getGroupJoinRequestsController,
    addMemberToGroupController,
    getGroupInfoController,
    deleteGroupMessageController,
    restoreGroupMessageController,
    upload,
  };
