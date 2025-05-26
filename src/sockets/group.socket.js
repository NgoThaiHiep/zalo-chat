const groupService = require('../services/group.service');
const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');

module.exports = (groupIo) => {
  groupIo.use(authenticateSocket);

  groupIo.on('connection', async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    logger.info('[GroupSocket] User connected', { userId, socketId: socket.id });

    try {
      const groups = await groupService.getUserGroups(userId);
      groups.forEach(({ groupId }) => {
        socket.join(`group:${groupId}`);
        logger.info('[GroupSocket] Người dùng tham gia phòng nhóm', { userId, groupId });
      });
    } catch (error) {
      logger.error('[GroupSocket] Lỗi khi tham gia phòng nhóm', { userId, error: error.message });
    }

    socket.on('createGroup', async (data, callback = () => {}) => {
      try {
        if (!data.name || !Array.isArray(data.members)) {
          callback({ success: false, message: 'name and members (array) are required' });
          logger.error('[GroupSocket] Error creating group', { error: 'name and members (array) are required' });
          return;
        }
        const group = await groupService.createGroup(userId, data);
        socket.join(`group:${group.groupId}`);
        group.members.forEach((memberId) => {
          groupIo.to(`user:${memberId}`).emit('groupCreated', {
            groupId: group.groupId,
            name: group.name,
            createdBy: userId,
            members: group.members,
          });
        });
        callback({ success: true, data: group });
        logger.info('[GroupSocket] Group created', { groupId: group.groupId, createdBy: userId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error creating group', { error: error.message });
      }
    });

    socket.on('sendGroupMessage', async (data, callback = () => {}) => {
      try {
        if (!data.groupId || !data.type) {
          callback({ success: false, message: 'groupId and type are required' });
          logger.error('[GroupSocket] Error sending group message', { error: 'groupId and type are required' });
          return;
        }
        const message = await groupService.sendGroupMessage(data.groupId, userId, data);
        groupIo.to(`group:${data.groupId}`).emit('newGroupMessage', { groupId: data.groupId, message });
        // Phát tín hiệu để cập nhật danh sách chat-item
        groupIo.to(`group:${data.groupId}`).emit('updateChatList', {
          conversationId: data.groupId,
          message,
        });
        callback({ success: true, data: message });
        logger.info('[GroupSocket] Group message sent', {
          groupId: data.groupId,
          messageId: message.messageId,
          senderId: userId,
        });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error sending group message', { error: error.message });
      }
    });

    socket.on('joinGroupRequest', async (data, callback = () => {}) => {
      try {
        if (!data.groupId) {
          callback({ success: false, message: 'groupId is required' });
          logger.error('[GroupSocket] Error processing join group request', { error: 'groupId is required' });
          return;
        }
        const result = await groupService.joinGroup(data.groupId, userId);
        const groupInfo = await groupService.getGroupInfo(data.groupId);
        const adminIds = Object.keys(groupInfo.roles || {}).filter((id) => groupInfo.roles[id] === 'admin');
        adminIds.forEach((adminId) => {
          groupIo.to(`user:${adminId}`).emit('newJoinRequest', {
            groupId: data.groupId,
            userId,
            requestedAt: new Date().toISOString(),
          });
        });
        callback({ success: true, data: result });
        logger.info('[GroupSocket] Join group request sent', { groupId: data.groupId, userId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error processing join group request', { error: error.message });
      }
    });

    socket.on('handleJoinRequest', async (data, callback = () => {}) => {
      try {
        if (!data.groupId || !data.userId) {
          callback({ success: false, message: 'groupId and userId are required' });
          logger.error('[GroupSocket] Error handling join request', { error: 'groupId and userId are required' });
          return;
        }
        const result = await groupService.approveJoinRequest(data.groupId, data.userId, data.approve, userId);
        groupIo.to(`user:${data.userId}`).emit('joinRequestHandled', {
          groupId: data.groupId,
          userId: data.userId,
          approved: data.approve,
          reason: data.reason || null,
        });
        if (data.approve) {
          groupIo.to(`group:${data.groupId}`).emit('memberAdded', { groupId: data.groupId, userId: data.userId });
        }
        callback({ success: true, data: result });
        logger.info('[GroupSocket] Join request handled', {
          groupId: data.groupId,
          targetUserId: data.userId,
          approved: data.approve,
        });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error handling join request', { error: error.message });
      }
    });

    socket.on('updateGroupInfo', async (data, callback = () => {}) => {
      try {
        if (!data.groupId) {
          callback({ success: false, message: 'groupId is required' });
          logger.error('[GroupSocket] Error updating group info', { error: 'groupId is required' });
          return;
        }
        const result = await groupService.updateGroupInfo(data.groupId, userId, data);
        groupIo.to(`group:${data.groupId}`).emit('groupInfoUpdated', {
          groupId: data.groupId,
          name: result.name,
          avatar: result.avatar,
        });
        callback({ success: true, data: result });
        logger.info('[GroupSocket] Group info updated', { groupId: data.groupId, userId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error updating group info', { error: error.message });
      }
    });

    socket.on('leaveGroup', async (data, callback = () => {}) => {
      try {
        if (!data.groupId) {
          callback({ success: false, message: 'groupId is required' });
          logger.error('[GroupSocket] Error leaving group', { error: 'groupId is required' });
          return;
        }
        const result = await groupService.leaveGroup(data.groupId, userId);
        socket.leave(`group:${data.groupId}`);
        groupIo.to(`group:${data.groupId}`).emit('memberLeft', { groupId: data.groupId, userId });
        callback({ success: true, data: result });
        logger.info('[GroupSocket] User left group', { groupId: data.groupId, userId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error leaving group', { error: error.message });
      }
    });

    socket.on('kickMember', async (data, callback = () => {}) => {
      try {
        if (!data.groupId || !data.targetUserId) {
          callback({ success: false, message: 'groupId and targetUserId are required' });
          logger.error('[GroupSocket] Error kicking member', { error: 'groupId and targetUserId are required' });
          return;
        }
        const result = await groupService.kickMember(data.groupId, data.targetUserId, userId);
        groupIo.to(`user:${data.targetUserId}`).emit('memberKicked', {
          groupId: data.groupId,
          targetUserId: data.targetUserId,
          adminUserId: userId,
        });
        groupIo.to(`group:${data.groupId}`).emit('memberKicked', {
          groupId: data.groupId,
          targetUserId: data.targetUserId,
          adminUserId: userId,
        });
        callback({ success: true, data: result });
        logger.info('[GroupSocket] Member kicked', { groupId: data.groupId, targetUserId: data.targetUserId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error kicking member', { error: error.message });
      }
    });

    socket.on('deleteGroup', async (data, callback = () => {}) => {
      try {
        if (!data.groupId) {
          callback({ success: false, message: 'groupId là bắt buộc' });
          logger.error('[GroupSocket] Error deleting group', { error: 'groupId là bắt buộc' });
          return;
        }
        const result = await groupService.deleteGroup(data.groupId, userId);
        groupIo.to(`group:${data.groupId}`).emit('groupDeleted', { success: true, data: result });
        callback({ success: true, data: result });
        logger.info(`[GroupSocket] Group ${data.groupId} deleted by ${userId}`);
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error deleting group', { error: error.message });
      }
    });

    socket.on('assignMemberRole', async (data, callback = () => {}) => {
      try {
        if (!data.groupId || !data.targetUserId || !data.role) {
          callback({ success: false, message: 'groupId, targetUserId và role là bắt buộc' });
          logger.error('[GroupSocket] Error assigning role', { error: 'groupId, targetUserId và role là bắt buộc' });
          return;
        }
        const result = await groupService.assignMemberRole(data.groupId, data.targetUserId, data.role, userId);
        groupIo.to(`group:${data.groupId}`).emit('memberRoleAssigned', {
          success: true,
          data: { groupId: data.groupId, targetUserId: data.targetUserId, role: data.role, assignedBy: userId },
        });
        callback({ success: true, data: result });
        logger.info(`[GroupSocket] Role ${data.role} assigned to ${data.targetUserId} in group ${data.groupId}`);
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error assigning role', { error: error.message });
      }
    });

    socket.on('recallGroupMessage', async (data, callback = () => {}) => {
      try {
        if (!data.groupId || !data.messageId) {
          callback({ success: false, message: 'groupId and messageId are required' });
          logger.error('[GroupSocket] Error recalling group message', { error: 'groupId and messageId are required' });
          return;
        }
        const result = await groupService.recallGroupMessage(data.groupId, data.messageId, userId);
        groupIo.to(`group:${data.groupId}`).emit('messageRecalled', {
          groupId: data.groupId,
          messageId: data.messageId,
          userId,
        });
        callback({ success: true, data: result });
        logger.info('[GroupSocket] Group message recalled', { groupId: data.groupId, messageId: data.messageId, userId });
      } catch (error) {
        callback({ success: false, message: error.message });
        logger.error('[GroupSocket] Error recalling group message', { error: error.message });
      }
    });

    socket.on('disconnect', async () => {
      try {
        const groups = await groupService.getUserGroups(userId);
        groups.forEach(({ groupId }) => {
          socket.leave(`group:${groupId}`);
          logger.info('[GroupSocket] Người dùng rời phòng nhóm', { userId, groupId });
        });
        logger.info('[GroupSocket] Người dùng ngắt kết nối', { userId });
      } catch (error) {
        logger.error('[GroupSocket] Lỗi khi xử lý ngắt kết nối', { userId, error: error.message });
      }
    });
  });
};