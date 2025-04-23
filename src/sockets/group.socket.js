const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');
const groupService = require('../services/group.service');
const { AppError } = require('../utils/errorHandler');
const { isValidUUID } = require('../utils/helpers');
const initializeGroupSocket = (groupIo) => {
  groupIo.use(authenticateSocket);

  groupIo.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info('[GroupSocket] User connected', { userId, socketId: socket.id });

    const joinUserGroups = async () => {
      try {
        const groups = await groupService.getUserGroups(userId);
        groups.forEach((group) => {
          socket.join(`group:${group.groupId}`);
          logger.info('[GroupSocket] User joined group room', { userId, groupId: group.groupId });
        });
      } catch (error) {
        logger.error('[GroupSocket] Failed to join user groups', { userId, error: error.message });
      }
    };

    joinUserGroups();

    socket.on('createGroup', async (data, callback) => {
      try {
        const { name, members, initialRoles } = data;
        if (!name || !members || !Array.isArray(members)) {
          throw new AppError('name and members (array) are required', 400);
        }
    
        const newGroup = await groupService.createGroup(name, userId, members, initialRoles);
    
        // Người tạo nhóm join room nhóm
        socket.join(`group:${newGroup.groupId}`);
    
        // Gửi sự kiện groupCreated tới từng thành viên
        members.forEach((memberId) => {
          groupIo.to(`user:${memberId}`).emit('groupCreated', {
            groupId: newGroup.groupId,
            name,
            createdBy: userId,
            members,
            roles: initialRoles,
          });
        });
    
        logger.info('[GroupSocket] Group created', {
          groupId: newGroup.groupId,
          createdBy: userId,
        });
    
        callback({ success: true, data: newGroup });
      } catch (error) {
        logger.error('[GroupSocket] Error creating group', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('sendGroupMessage', async (data, callback) => {
      try {
        const { groupId, type, content, isAnonymous, isSecret, quality, replyToMessageId, metadata, file } = data;
        if (!groupId || !type) {
          throw new AppError('groupId and type are required', 400);
        }

        const messageData = {
          type,
          content,
          file: file ? Buffer.from(file.data) : null,
          fileName: file ? file.name : null,
          mimeType: file ? file.mimeType : null,
          metadata,
          isAnonymous: !!isAnonymous,
          isSecret: !!isSecret,
          quality,
          replyToMessageId,
        };

        const message = await groupService.sendGroupMessage(groupId, userId, messageData);

        groupIo.to(`group:${groupId}`).emit('newGroupMessage', {
          groupId,
          message,
        });

        logger.info('[GroupSocket] Group message sent', { groupId, messageId: message.messageId, senderId: userId });
        callback({ success: true, data: message });
      } catch (error) {
        logger.error('[GroupSocket] Error sending group message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('joinGroupRequest', async (data, callback) => {
      try {
        const { groupId } = data;
        if (!groupId) {
          throw new AppError('groupId is required', 400);
        }
        const result = await groupService.joinGroup(groupId, userId);

        const group = await groupService.getGroupInfo(groupId, userId);
        const adminMembers = group.members?.filter((memberId) =>
          ['admin', 'co-admin'].includes(group.roles[memberId])
        ) || [];

        adminMembers.forEach((adminId) => {
          groupIo.to(`group:${groupId}`).emit('newJoinRequest', {
            groupId,
            userId,
            requestedAt: new Date().toISOString(),
          });
        });

        logger.info('[GroupSocket] Join group request sent', { groupId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error processing join group request', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('handleJoinRequest', async (data, callback) => {
      try {
        const { groupId, userId: targetUserId, approve, reason } = data;
        const adminUserId = socket.user.id;
        if (!groupId || !targetUserId) {
          throw new AppError('groupId and userId are required', 400);
        }

        const result = await groupService.approveJoinRequest(groupId, adminUserId, targetUserId, approve, reason);

        groupIo.to(`group:${groupId}`).emit('joinRequestHandled', {
          groupId,
          userId: targetUserId,
          approved: approve,
          reason: reason || null,
        });

        if (approve) {
          groupIo.to(`group:${groupId}`).emit('memberAdded', {
            groupId,
            userId: targetUserId,
          });
        }

        logger.info('[GroupSocket] Join request handled', { groupId, targetUserId, approved: approve });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error handling join request', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('updateGroupInfo', async (data, callback) => {
      try {
        const { groupId, name, avatarFile } = data;
        if (!groupId) {
          throw new AppError('groupId is required', 400);
        }
        const result = await groupService.updateGroupInfo(groupId, userId, { name, avatarFile });

        groupIo.to(`group:${groupId}`).emit('groupInfoUpdated', {
          groupId,
          name: result.name,
          avatar: result.avatar,
        });

        logger.info('[GroupSocket] Group info updated', { groupId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error updating group info', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('leaveGroup', async (data, callback) => {
      try {
        const { groupId } = data;
        if (!groupId) {
          throw new AppError('groupId is required', 400);
        }
        const result = await groupService.leaveGroup(groupId, userId);

        groupIo.to(`group:${groupId}`).emit('memberLeft', {
          groupId,
          userId,
        });

        socket.leave(`group:${groupId}`);

        logger.info('[GroupSocket] User left group', { groupId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error leaving group', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('kickMember', async (data, callback) => {
      try {
        const { groupId, targetUserId } = data;
        const adminUserId = socket.user.id;
        if (!groupId || !targetUserId) {
          throw new AppError('groupId and targetUserId are required', 400);
        }

        const result = await groupService.kickMember(groupId, adminUserId, targetUserId);

        groupIo.to(`group:${groupId}`).emit('memberKicked', {
          groupId,
          targetUserId,
          adminUserId,
        });

        logger.info('[GroupSocket] Member kicked', { groupId, targetUserId, adminUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error kicking member', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('deleteGroup', async ({ groupId }, callback) => {
      try {
        if (!groupId) {
          throw new AppError('groupId là bắt buộc', 400);
        }
        if (!isValidUUID(groupId)) {
          throw new AppError('groupId không hợp lệ', 400);
        }
        const result = await groupService.deleteGroup(groupId, userId);
        groupIo.to(`group:${groupId}`).emit('groupDeleted', {
          success: true,
          data: { groupId, deletedBy: userId },
        });
        callback({ success: true, data: result });
        logger.info(`[GroupSocket] Group ${groupId} deleted by ${userId}`);
      } catch (error) {
        logger.error(`[GroupSocket] Error deleting group for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('assignMemberRole', async ({ groupId, targetUserId, role }, callback) => {
      try {
        if (!groupId || !targetUserId || !role) {
          throw new AppError('groupId, targetUserId và role là bắt buộc', 400);
        }
        if (!isValidUUID(groupId) || !isValidUUID(targetUserId)) {
          throw new AppError('groupId hoặc targetUserId không hợp lệ', 400);
        }
        const result = await groupService.assignMemberRole(groupId, targetUserId, role, userId);
        groupIo.to(`group:${groupId}`).emit('memberRoleAssigned', {
          success: true,
          data: { groupId, targetUserId, role, assignedBy: userId },
        });
        callback({ success: true, data: result });
        logger.info(`[GroupSocket] Role ${role} assigned to ${targetUserId} in group ${groupId}`);
      } catch (error) {
        logger.error(`[GroupSocket] Error assigning role for ${userId}`, { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('recallGroupMessage', async (data, callback) => {
      try {
        const { groupId, messageId } = data;
        if (!groupId || !messageId) {
          throw new AppError('groupId and messageId are required', 400);
        }
        const result = await groupService.recallGroupMessage(groupId, userId, messageId);

        groupIo.to(`group:${groupId}`).emit('messageRecalled', {
          groupId,
          messageId,
          userId,
        });

        logger.info('[GroupSocket] Group message recalled', { groupId, messageId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[GroupSocket] Error recalling group message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('disconnect', () => {
      logger.info('[GroupSocket] User disconnected', { userId, socketId: socket.id });
    });
  });
};

module.exports = initializeGroupSocket;