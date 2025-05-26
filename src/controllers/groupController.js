const groupService = require('../services/group.service');
const logger = require('../config/logger');
const multer = require('multer');
const { AppError } = require('../utils/errorHandler');
const { isValidUUID } = require('../utils/helpers');
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
    const requestingUserId = req.user.id;

    logger.info('Gán vai trò cho thành viên nhóm', { groupId, targetUserId, role, requestingUserId });

    const result = await groupService.assignMemberRole(groupId, targetUserId, role, requestingUserId);

    // Phát sự kiện Socket.IO khi vai trò được gán
    req.io.of('/group').to(`group:${groupId}`).emit('memberRoleAssigned', {
      groupId,
      targetUserId,
      role,
      assignedBy: requestingUserId,
    });

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
    const createdBy = req.user.id;
    if (!name || !members || !Array.isArray(members)) {
      throw new AppError('name và members (array) là bắt buộc', 400);
    }
    members.forEach(memberId => {
      if (!isValidUUID(memberId)) {
        throw new AppError(`memberId ${memberId} không hợp lệ`, 400);
      }
    });

    const newGroup = await groupService.createGroup(name, createdBy, members, initialRoles);
    res.status(201).json({ success: true, data: newGroup });
  } catch (error) {
    logger.error('[createGroupController] Lỗi', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi tạo nhóm', error.statusCode || 500);
  }
};
// Controller: Cập nhật thông tin nhóm
const updateGroupInfoController = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.params;
    const { name } = req.body;
    const avatarFile = req.file;

    const result = await groupService.updateGroupInfo(groupId, userId, {
      name,
      avatarFile,
    });

    // Phát sự kiện Socket.IO khi thông tin nhóm được cập nhật
    req.io.of('/group').to(`group:${groupId}`).emit('groupInfoUpdated', {
     success: true,
        data: {
          groupId,
          name: result.name,
          avatar: result.avatar,
        },
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('❌ Lỗi trong updateGroupInfoController:', error.message);
    return next(error);
  }
};

const joinGroupController = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;
    const result = await groupService.joinGroup(groupId, userId);

    // Phát sự kiện Socket.IO khi có yêu cầu tham gia nhóm
    const group = await groupService.getGroupInfo(groupId, userId);
    const adminMembers = group.members?.filter((memberId) =>
      ['admin', 'co-admin'].includes(group.roles[memberId])
    ) || [];

    adminMembers.forEach((adminId) => {
      req.io.of('/group').to(`group:${groupId}`).emit('newJoinRequest', {
        success: true,
        data: {
          groupId,
          userId,
          requestedAt: new Date().toISOString(),
        },
      });
    });

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

    // Phát sự kiện Socket.IO khi thành viên được thêm
    req.io.of('/group').to(`group:${groupId}`).emit('memberAdded', {
      groupId,
      userId: newUserId,
      addedBy: inviterId,
    });

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
    const { groupId, userId: targetUserId, approve, reason } = req.body;
    const adminUserId = req.user.id;

    const result = await groupService.approveJoinRequest(groupId, adminUserId, targetUserId, approve, reason);

    // Phát sự kiện Socket.IO khi yêu cầu tham gia được xử lý
    req.io.of('/group').to(`group:${groupId}`).emit('joinRequestHandled', {
      groupId,
      userId: targetUserId,
      approved: approve,
      reason: reason || null,
    });

    // Nếu phê duyệt, phát sự kiện thành viên được thêm
    if (approve) {
      req.io.of('/group').to(`group:${groupId}`).emit('memberAdded', {
        groupId,
        userId: targetUserId,
      });
    }

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
    const { groupId, userId: targetUserId, reason } = req.body;
    const adminUserId = req.user.id;

    const result = await groupService.rejectJoinRequest(groupId, adminUserId, targetUserId, reason);

    // Phát sự kiện Socket.IO khi yêu cầu tham gia bị từ chối
    req.io.of('/group').to(`group:${groupId}`).emit('joinRequestHandled', {
      groupId,
      userId: targetUserId,
      approved: false,
      reason: reason || null,
    });

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

    // Phát sự kiện Socket.IO khi thành viên rời nhóm
    req.io.of('/group').to(`group:${groupId}`).emit('memberLeft', {
      groupId,
      userId,
    });

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
    if (!isValidUUID(groupId)) {
      throw new AppError('groupId không hợp lệ', 400);
    }
    const result = await groupService.deleteGroup(groupId, adminUserId);
    req.io.of('/group').to(`group:${groupId}`).emit('groupDeleted', {
      success: true,
      data: { groupId, deletedBy: adminUserId },
    });
    logger.info(`[GroupController] Emitted groupDeleted to group:${groupId}`);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    logger.error('[deleteGroupController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi xóa nhóm', error.statusCode || 500);
  }
};

const kickMemberController = async (req, res) => {
  try {
    const { groupId, targetUserId } = req.params;
    const adminUserId = req.user.id;
    const result = await groupService.kickMember(groupId, adminUserId, targetUserId);

    // Phát sự kiện Socket.IO khi thành viên bị đá
    req.io.of('/group').to(`group:${groupId}`).emit('memberKicked', {
      groupId,
      targetUserId,
      adminUserId,
    });

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
    const file = req.file;

    const messageData = {
      type,
      content,
      file: file ? file.buffer : null,
      fileName: file ? file.originalname : null,
      mimeType: file ? file.mimetype : null,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
      isAnonymous: isAnonymous === true || isAnonymous === 'true',
      isSecret: isSecret === true || isSecret === 'true',
      quality,
      replyToMessageId,
    };

    logger.info('Gửi tin nhắn nhóm', { groupId, senderId, messageData });

    const message = await groupService.sendGroupMessage(groupId, senderId, messageData);

    // Phát sự kiện Socket.IO khi tin nhắn nhóm được gửi
    req.io.of('/group').to(`group:${groupId}`).emit('newGroupMessage', {
      groupId,
      message,
    });

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
    const { messageId, sourceGroupId, targetReceiverId } = req.body;
    const senderId = req.user.id;

    if (!messageId || !sourceGroupId || !targetReceiverId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu messageId, sourceGroupId hoặc targetReceiverId',
      });
    }

    const result = await groupService.forwardGroupMessageToUser(senderId, messageId, sourceGroupId, targetReceiverId);

    // Phát sự kiện Socket.IO đến người gửi và người nhận
    try {
      req.io.of('/chat').to(`user:${senderId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
      logger.info(`[Controller] Emitted receiveMessage to user:${senderId}`);
    } catch (error) {
      logger.error(`[Controller] Error emitting receiveMessage`, { error: error.message });
    }
    if (senderId !== targetReceiverId) {
      req.io.of('/chat').to(`user:${targetReceiverId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
    }

    logger.info(`[GroupController] Emitted receiveMessage to user:${senderId} and user:${targetReceiverId}`);
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
    const { messageId, sourceGroupId, targetGroupId } = req.body;
    const senderId = req.user.id;

    if (!messageId || !sourceGroupId || !targetGroupId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu messageId, sourceGroupId hoặc targetGroupId',
      });
    }

    const result = await groupService.forwardGroupMessage(senderId, messageId, sourceGroupId, targetGroupId);

    // Phát sự kiện Socket.IO đến nhóm đích
    req.io.of('/group').to(`group:${targetGroupId}`).emit('newGroupMessage', {
      success: true,
      data: {
        groupId: targetGroupId,
        message: result,
      },
    });

    // Thông báo cho người gửi (nếu họ là thành viên nhóm đích)
    try {
      req.io.of('/chat').to(`user:${senderId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
      logger.info(`[Controller] Emitted receiveMessage to user:${senderId}`);
    } catch (error) {
      logger.error(`[Controller] Error emitting receiveMessage`, { error: error.message });
    }
    
    logger.info(`[GroupController] Emitted newGroupMessage to group:${targetGroupId} and receiveMessage to user:${senderId}`);
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
    const senderId = req.user.id;
    const result = await groupService.recallGroupMessage(groupId, senderId, messageId);

    // Phát sự kiện Socket.IO khi tin nhắn được thu hồi
    req.io.of('/group').to(`group:${groupId}`).emit('messageRecalled', {
      groupId,
      messageId,
      userId: senderId,
    });

    res.status(200).json






({
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

    if (req.method === 'PUT') {
      const result = await groupService.pinGroupMessage(groupId, senderId, messageId);

      // Phát sự kiện Socket.IO khi tin nhắn được ghim
      req.io.of('/group').to(`group:${groupId}`).emit('messagePinned', {
        groupId,
        messageId,
        pinnedBy: senderId,
      });

      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } else if (req.method === 'DELETE') {
      const result = await groupService.unpinGroupMessage(groupId, senderId, messageId);

      // Phát sự kiện Socket.IO khi tin nhắn được bỏ ghim
      req.io.of('/group').to(`group:${groupId}`).emit('messageUnpinned', {
        groupId,
        messageId,
        unpinnedBy: senderId,
      });

      res.status(200).json({
        success: true,
        message: result.message,
        data: result,
      });
    } else {
      throw new AppError('Phương thức không được hỗ trợ!', 405);
    }
  } catch (error) {
    logger.error('Lỗi khi xử lý ghim/bỏ ghim tin nhắn nhóm', { error: error.message });
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Lỗi server khi xử lý ghim/bỏ ghim tin nhắn nhóm',
    });
  }
};

const deleteGroupMessageController = async (req, res) => {
  try {
    const { groupId, messageId } = req.params;
    const senderId = req.user.id;
    const result = await groupService.deleteGroupMessage(groupId, senderId, messageId);

    // Phát sự kiện Socket.IO khi tin nhắn được xóa
    req.io.of('/group').to(`group:${groupId}`).emit('messageDeleted', {
      groupId,
      messageId,
      deletedBy: senderId,
    });

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

    // Phát sự kiện Socket.IO khi tin nhắn được khôi phục
    req.io.of('/group').to(`group:${groupId}`).emit('messageRestored', {
      groupId,
      messageId,
      restoredBy: senderId,
    });

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

    // Phát sự kiện Socket.IO khi cài đặt cộng đồng được cập nhật
    req.io.of('/group').to(`group:${groupId}`).emit('communitySettingsUpdated', {
      groupId,
      settings,
      updatedBy: adminUserId,
    });

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

    // Phát sự kiện Socket.IO khi link nhóm được tạo
    req.io.of('/group').to(`group:${groupId}`).emit('groupLinkGenerated', {
      groupId,
      link: result.link,
      generatedBy: userId,
    });

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
    const userId = req.user.id;
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

const markGroupMessageAsSeenController = async (req, res) => {
  try {
    const { groupId, messageId } = req.params;
    const userId = req.user.id;
    const result = await groupService.markGroupMessageAsSeen(groupId, userId, messageId);

    // Emit a Socket.IO event if needed
    req.io.of('/group').to(`group:${groupId}`).emit('messageSeen', {
      groupId,
      messageId,
      seenBy: userId,
    });

    res.status(200).json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    logger.error('Lỗi khi đánh dấu tin nhắn nhóm là đã xem', { error: error.message });
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Lỗi server khi đánh dấu tin nhắn nhóm là đã xem',
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
  getGroupMessagesController,
  markGroupMessageAsSeenController,
  upload,
};