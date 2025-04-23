// src/services/group.service.js
const { v4: uuidv4 } = require('uuid');
const { dynamoDB, s3 } = require('../config/aws.config');
const logger = require('../config/logger');
const { sendMessageCore } = require('./messageCore');
const { AppError } = require('../utils/errorHandler');
const { io } = require('../socket');
const { copyS3File, uploadS3File} = require('../utils/messageUtils');
const { createConversation } = require('./conversation.service');
const { MESSAGE_STATUSES,GET_DEFAULT_CONTENT_BY_TYPE } = require('../config/constants');
const { getOwnProfile } = require('../services/auth.service');



const TABLE_NAME = 'GroupMessages';
const GROUP_TABLE = 'Groups';

const USER_RECALLS_TABLE = 'UserRecalls';
const bucketName = process.env.BUCKET_NAME_GroupChat_Send;

const isValidUUID = (uuid) => {
  if (typeof uuid !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
};

const retryQuery = async (params, maxRetries = 3, delay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    const result = await dynamoDB.query(params).promise();
    if (result.Items?.length > 0) return result;
    logger.warn(`Thử lại lần ${i + 1} cho truy vấn`, { params });
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return { Items: [] };
};

const getUserIds = async (members, createdBy) => {
  const memberIds = new Set([createdBy, ...members].filter(id => id && isValidUUID(id)));
  return Array.from(memberIds);
};

// Hàm phụ trợ: Thêm thành viên vào nhóm
const addMemberCore = async (groupId, userId, group, inviterName = null) => {
  const updatedMembers = [...group.members, userId];
  const updatedRoles = { ...group.roles, [userId]: 'member' };
  const userProfile = await getOwnProfile(userId);
  const userName = userProfile.name;

  try {
    await dynamoDB.update({
      TableName: 'Groups',
      Key: { groupId },
      UpdateExpression: 'SET members = :members, #roles = :roles',
      ExpressionAttributeNames: { '#roles': 'roles' },
      ExpressionAttributeValues: {
        ':members': updatedMembers,
        ':roles': updatedRoles,
      },
    }).promise();

    await dynamoDB.put({
      TableName: 'GroupMembers',
      Item: {
        groupId,
        userId,
        role: 'member',
        createdAt: new Date().toISOString(),
      },
    }).promise();

    const conversationId = uuidv4();
    await dynamoDB.put({
      TableName: 'Conversations',
      Item: {
        userId,
        targetUserId: groupId,
        conversationId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: null,
        settings: {
          autoDelete: 'never',
          pinnedMessages: [],
          mute: false,
          block: false,
          
          isGroup: true,
        },
      },
      ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(targetUserId)',
    }).promise();

    await sendMessageCore({
      groupId,
      senderId: null,
      type: 'text',
      content: inviterName
        ? `${userName} đã được ${inviterName} thêm vào nhóm${group.settings.requireApproval && !['admin', 'co-admin'].includes(group.roles[inviterName]) ? ' sau khi được phê duyệt.' : '.'}`
        : `${userName} đã tham gia nhóm${group.settings.requireApproval ? ' sau khi được phê duyệt.' : '.'}`,
      metadata: { system: true, userId, inviterId: inviterName ? group.members.find(id => id !== userId) : null },
      isAnonymous: false,
      isSecret: false,
      ownerId: groupId,
      status: MESSAGE_STATUSES.SENT,
    }, 'GroupMessages', process.env.BUCKET_NAME_Chat_Send);

    io().to(updatedMembers).emit('groupEvent', {
      event: 'memberAdded',
      groupId,
      userName,
      inviterName,
    });
    io().to(userId).emit('conversationCreated', { conversationId, targetUserId: groupId, groupName: group.name });

    logger.info('Thêm thành viên vào nhóm thành công', { groupId, userId, inviterName });
    return updatedMembers;
  } catch (error) {
    try {
      await dynamoDB.delete({ TableName: 'GroupMembers', Key: { groupId, userId } }).promise();
      await dynamoDB.delete({ TableName: 'Conversations', Key: { userId, targetUserId: groupId } }).promise();
      await dynamoDB.update({
        TableName: 'Groups',
        Key: { groupId },
        UpdateExpression: 'SET members = :members, #roles = :roles',
        ExpressionAttributeNames: { '#roles': 'roles' },
        ExpressionAttributeValues: {
          ':members': group.members,
          ':roles': group.roles,
        },
      }).promise();
      logger.info('Đã rollback việc thêm thành viên', { groupId, userId });
    } catch (rollbackError) {
      logger.error('Lỗi khi rollback thêm thành viên', { groupId, userId, error: rollbackError.message });
    }
    throw error instanceof AppError ? error : new AppError(`Lỗi khi thêm thành viên: ${error.message}`, 500);
  }
};

// Hàm phụ trợ: Xóa thành viên khỏi nhóm
const removeMemberCore = async (groupId, userId, group, isKicked = false, adminUserId = null) => {
  const userProfile = await getOwnProfile(userId);
  const userName = userProfile.name;
  const memberCount = group.members.length;
  const newMembers = group.members.filter(member => member !== userId);

  try {
    await dynamoDB.delete({
      TableName: 'Conversations',
      Key: { userId, targetUserId: groupId },
    }).promise();

    await sendMessageCore({
      groupId,
      senderId: null,
      type: 'text',
      content: isKicked ? `${userName} đã bị đá khỏi nhóm.` : `${userName} đã rời nhóm.`,
      metadata: { system: true, userId, adminUserId },
      isAnonymous: false,
      isSecret: false,
      ownerId: groupId,
      status: MESSAGE_STATUSES.SENT,
    }, 'GroupMessages', process.env.BUCKET_NAME_Chat_Send);

    let newAdminId = null;
    if (memberCount === 1) {
      await dynamoDB.delete({ TableName: 'GroupMembers', Key: { groupId, userId } }).promise();
      await dynamoDB.delete({ TableName: 'Groups', Key: { groupId } }).promise();
      await deleteGroupMessages(groupId);
      io().to(userId).emit('groupEvent', { event: 'groupDeleted', groupId });
      io().to(userId).emit('conversationDeleted', { targetUserId: groupId });
      return { newMembers: [], newAdminId: null, groupDeleted: true };
    } else if (memberCount === 2) {
      const remainingMemberId = group.members.find(member => member !== userId);
      await dynamoDB.delete({ TableName: 'GroupMembers', Key: { groupId, userId } }).promise();
      await dynamoDB.update({
        TableName: 'Groups',
        Key: { groupId },
        UpdateExpression: 'SET members = :newMembers, #roles.#remainingId = :adminRole REMOVE #roles.#userId',
        ExpressionAttributeNames: { '#roles': 'roles', '#remainingId': remainingMemberId, '#userId': userId },
        ExpressionAttributeValues: { ':newMembers': newMembers, ':adminRole': 'admin' },
      }).promise();
      await dynamoDB.update({
        TableName: 'GroupMembers',
        Key: { groupId, userId: remainingMemberId },
        UpdateExpression: 'SET #role = :adminRole',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':adminRole': 'admin' },
      }).promise();
      io().to(remainingMemberId).emit('groupEvent', {
        event: isKicked ? 'memberKicked' : 'memberLeft',
        groupId,
        userName,
        newAdmin: remainingMemberId,
      });
      io().to(userId).emit('conversationDeleted', { targetUserId: groupId });
      return { newMembers, newAdminId: remainingMemberId, groupDeleted: false };
    } else {
      const isAdmin = group.roles[userId] === 'admin';
      if (isAdmin) {
        const memberRecords = await dynamoDB.query({
          TableName: 'GroupMembers',
          KeyConditionExpression: 'groupId = :groupId',
          ExpressionAttributeValues: { ':groupId': groupId },
        }).promise();
        const otherMembers = memberRecords.Items
          .filter(member => member.userId !== userId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (otherMembers.length > 0) newAdminId = otherMembers[0].userId;
      }

      const updateExpression = isAdmin && newAdminId
        ? 'SET members = :newMembers, #roles.#newAdminId = :adminRole REMOVE #roles.#userId'
        : 'SET members = :newMembers REMOVE #roles.#userId';
      const expressionAttributeNames = { '#roles': 'roles', '#userId': userId };
      const expressionAttributeValues = { ':newMembers': newMembers };

      if (isAdmin && newAdminId) {
        expressionAttributeNames['#newAdminId'] = newAdminId;
        expressionAttributeValues[':adminRole'] = 'admin';
      }

      await dynamoDB.update({
        TableName: 'Groups',
        Key: { groupId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }).promise();

      if (isAdmin && newAdminId) {
        await dynamoDB.update({
          TableName: 'GroupMembers',
          Key: { groupId, userId: newAdminId },
          UpdateExpression: 'SET #role = :adminRole',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: { ':adminRole': 'admin' },
        }).promise();
      }

      await dynamoDB.delete({ TableName: 'GroupMembers', Key: { groupId, userId } }).promise();
      io().to(group.members).emit('groupEvent', {
        event: isKicked ? 'memberKicked' : 'memberLeft',
        groupId,
        userName,
        newAdmin: newAdminId,
      });
      io().to(userId).emit('conversationDeleted', { targetUserId: groupId });
      return { newMembers, newAdminId, groupDeleted: false };
    }
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi xóa thành viên: ${error.message}`, 500);
  }
};

// Hàm phụ trợ: Quản lý xóa/thu hồi tin nhắn
const assignMemberRole = async (groupId, targetUserId, role, requestingUserId) => {
  // 1. Kiểm tra định dạng groupId, targetUserId và requestingUserId
  console.log('✅ groupId:', groupId);
  console.log('✅ targetUserId:', targetUserId);
  console.log('✅ requestingUserId:', requestingUserId);
  if (
    !groupId ||
    !targetUserId ||
    !requestingUserId ||
    !isValidUUID(groupId) ||
    !isValidUUID(targetUserId) ||
    !isValidUUID(requestingUserId)
  ) {
    throw new AppError('groupId, targetUserId hoặc requestingUserId không hợp lệ', 400);
  }

  // 2. Kiểm tra vai trò hợp lệ
  const validRoles = ['admin', 'co-admin', 'member'];
  if (!validRoles.includes(role)) {
    throw new AppError('Vai trò không hợp lệ. Vai trò phải là admin, co-admin hoặc member.', 400);
  }

  // 3. Kiểm tra nhóm có tồn tại không
  const groupResult = await dynamoDB
    .get({
      TableName: 'Groups',
      Key: { groupId },
    })
    .promise();

  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại', 404);
  }

  const group = groupResult.Item;

  // 4. Kiểm tra quyền của người yêu cầu (requestingUserId phải là admin)
  const requestingUserRole = group.roles?.[requestingUserId] || 'member';
  if (requestingUserRole !== 'admin') {
    throw new AppError('Bạn không có quyền gán vai trò. Chỉ admin mới có thể thực hiện hành động này.', 403);
  }

  // 5. Kiểm tra targetUserId có phải là thành viên của nhóm không
  const member = await dynamoDB.get({
    TableName: 'GroupMembers',
    Key: {
      groupId,
      userId: targetUserId,
    },
  }).promise();
  
  if (!member.Item) {
    throw new AppError('Người dùng không phải là thành viên của nhóm', 400);
  }

  // 6. Kiểm tra số lượng admin trong nhóm
  if (role === 'admin') {
    const adminCount = Object.values(group.roles).filter(r => r === 'admin').length;
    
    if (adminCount >= 1) {
      throw new AppError('Mỗi nhóm chỉ được phép có 1 admin.', 400);
    }
  }

  // 7. Kiểm tra số lượng co-admin trong nhóm
  if (role === 'co-admin') {
    const coAdminCount = Object.values(group.roles).filter(r => r === 'co-admin').length;
    
    if (coAdminCount >= 2) {
      throw new AppError('Mỗi nhóm chỉ được phép có tối đa 2 co-admin.', 400);
    }
  }

  // 8. Cập nhật vai trò trong bảng Groups (dùng ExpressionAttributeNames để tránh lỗi reserved keyword)
  const updatedRoles = {
    ...group.roles,
    [targetUserId]: role,
  };

  // Log the updated roles to verify the change
  console.log('Updated roles:', updatedRoles);

  try {
    // Cập nhật bảng Groups
    await dynamoDB.update({
      TableName: 'Groups',
      Key: { groupId },
      UpdateExpression: 'SET #roles = :roles',
      ExpressionAttributeNames: {
        '#roles': 'roles', // Thay thế từ khóa 'roles'
      },
      ExpressionAttributeValues: {
        ':roles': updatedRoles,
      },
    }).promise();

    // Cập nhật vai trò trong bảng GroupMembers
    await dynamoDB.update({
      TableName: 'GroupMembers',
      Key: { groupId, userId: targetUserId },
      UpdateExpression: 'SET #role = :role',
      ExpressionAttributeNames: {
        '#role': 'role', // Thay thế từ khóa 'role'
      },
      ExpressionAttributeValues: {
        ':role': role,
      },
    }).promise();

    console.log('Roles updated successfully in both tables.');
  } catch (error) {
    console.error('Error updating roles:', error);
    throw new AppError('Không thể cập nhật vai trò', 500);
  }

  // 9. Trả về thông tin vai trò đã được cập nhật
  return {
    groupId,
    userId: targetUserId,
    role,
  };
};

const createGroup = async (name, createdBy, members = []) => {
  // 1. Kiểm tra và làm sạch dữ liệu đầu vào
  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) {
    throw new AppError('Tên nhóm phải từ 1 đến 50 ký tự!', 400);
  }
  if (!createdBy || !isValidUUID(createdBy)) {
    throw new AppError('createdBy không hợp lệ!', 400);
  }

  // 2. Kiểm tra nhóm trùng tên
  const existingGroups = await dynamoDB
    .query({
      TableName: 'Groups',
      IndexName: 'CreatedByIndex',
      KeyConditionExpression: 'createdBy = :createdBy',
      FilterExpression: '#groupName = :name',
      ExpressionAttributeNames: { '#groupName': 'name' },
      ExpressionAttributeValues: { ':createdBy': createdBy, ':name': name.trim() },
    })
    .promise();

  if (existingGroups.Items?.length > 0) {
    throw new AppError('Bạn đã tạo nhóm với tên này trước đó. Vui lòng đặt tên khác.', 400);
  }

  // 3. Lấy danh sách thành viên hợp lệ
  const memberIds = await getUserIds(members, createdBy);
  if (memberIds.length < 3) {
    throw new AppError('Nhóm phải có ít nhất 3 thành viên!', 400);
  }

  // 4. Tạo groupId và thông tin cơ bản
  const groupId = uuidv4();
  const createdAt = new Date().toISOString();

  // 5. Gán vai trò ban đầu: chỉ admin và member
  const roles = {};
  roles[createdBy] = 'admin'; // Người tạo nhóm là admin
  logger.info('Gán vai trò admin cho người tạo nhóm', { createdBy, groupId });

  // Tất cả thành viên khác là member
  for (const memberId of memberIds) {
    if (memberId === createdBy) continue; // Bỏ qua người tạo
    roles[memberId] = 'member';
    logger.info('Gán vai trò member cho thành viên', { memberId, groupId });
  }

  // 6. Tạo nhóm trong bảng Groups
  const newGroup = {
    groupId,
    name: name.trim(),
    createdBy,
    members: memberIds,
    roles, // Vai trò chỉ có admin và member
    settings: {
      restrictMessaging: false,
      allowChangeGroupInfo: false,
      showAllMembers: true,
      allowAddMembers: true,
      requireApproval: false,
      autoDelete: 'never',
      pinnedMessages: [],
      mute: false,
      block: false,
      isGroup: true,
    },
    avatar: null,
    createdAt,
  };

  try {
    // 7. Lưu nhóm vào bảng Groups
    await dynamoDB
      .put({
        TableName: 'Groups',
        Item: newGroup,
      })
      .promise();

    // 8. Thêm thành viên vào bảng GroupMembers
    const groupMemberItems = memberIds.map(memberId => ({
      PutRequest: {
        Item: {
          groupId,
          userId: memberId,
          role: roles[memberId],
          createdAt,
        },
      },
    }));

    for (let i = 0; i < groupMemberItems.length; i += 25) {
      await dynamoDB
        .batchWrite({
          RequestItems: { 'GroupMembers': groupMemberItems.slice(i, i + 25) },
        })
        .promise();
    }

    // 9. Tạo hội thoại trong bảng Conversations
    const conversationItems = memberIds.map(memberId => ({
      PutRequest: {
        Item: {
          userId: memberId,
          targetUserId: groupId,
          conversationId: uuidv4(),
          createdAt,
          updatedAt: createdAt,
          lastMessage: null,
          settings: {
            autoDelete: 'never',
            pinnedMessages: [],
            mute: false,
            block: false,
            isGroup: true,
          },
        },
      },
    }));

    for (let i = 0; i < conversationItems.length; i += 25) {
      await dynamoDB
        .batchWrite({
          RequestItems: { 'Conversations': conversationItems.slice(i, i + 25) },
        })
        .promise();
    }

    // 10. Phát sự kiện qua Socket.IO
    io().to(memberIds).emit('groupEvent', {
      event: 'groupCreated',
      groupId,
      name: name.trim(),
      roles, // Gửi thông tin vai trò (chỉ admin và member)
    });

    memberIds.forEach(memberId => {
      io().to(memberId).emit('conversationCreated', {
        conversationId: uuidv4(),
        targetUserId: groupId,
        groupName: name.trim(),
        role: roles[memberId], // Gửi vai trò của thành viên (admin hoặc member)
      });
    });

    logger.info('Tạo nhóm và hội thoại thành công', { groupId, memberIds });
    return newGroup;
  } catch (error) {
    // 11. Rollback nếu có lỗi
    try {
      await dynamoDB
        .delete({
          TableName: 'Groups',
          Key: { groupId },
        })
        .promise();

      const deleteMemberPromises = memberIds.map(memberId =>
        dynamoDB
          .delete({
            TableName: 'GroupMembers',
            Key: { groupId, userId: memberId },
          })
          .promise()
      );

      const deleteConversationPromises = memberIds.map(memberId =>
        dynamoDB
          .delete({
            TableName: 'Conversations',
            Key: { userId: memberId, targetUserId: groupId },
          })
          .promise()
      );

      await Promise.all([...deleteMemberPromises, ...deleteConversationPromises]);
      logger.info('Đã rollback việc tạo nhóm', { groupId });
    } catch (rollbackError) {
      logger.error('Lỗi khi rollback tạo nhóm', { groupId, error: rollbackError.message });
    }

    throw error instanceof AppError ? error : new AppError(`Lỗi khi tạo nhóm: ${error.message}`, 500);
  }
};

const updateGroupInfo = async (groupId, userId, { name, avatarFile }) => {
  try {
    // Validate đầu vào
    if (!isValidUUID(groupId) || !isValidUUID(userId)) {
      throw new AppError('groupId hoặc userId không hợp lệ!', 400);
    }

    if (!name && !avatarFile) {
      throw new AppError('Phải cung cấp ít nhất tên hoặc ảnh đại diện để cập nhật!', 400);
    }

    if (name && (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50)) {
      throw new AppError('Tên nhóm phải từ 1 đến 50 ký tự!', 400);
    }

    // Lấy thông tin nhóm
    const groupResult = await dynamoDB.get({
      TableName: 'Groups',
      Key: { groupId }
    }).promise();

    const group = groupResult.Item;
    if (!group) throw new AppError('Nhóm không tồn tại!', 404);
    if (!group.members?.includes(userId)) {
      throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
    }

    const role = group.roles?.[userId];
    const allowUpdate = group.settings?.allowChangeGroupInfo || ['admin', 'co-admin'].includes(role);
    if (!allowUpdate) {
      throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới được phép thay đổi thông tin nhóm!', 403);
    }

    // Lấy thông tin người dùng để tạo tin nhắn hệ thống
    const userProfile = await getOwnProfile(userId);
    if (!userProfile) throw new AppError('Người dùng không tồn tại!', 404);

    const userName = userProfile.name;

    // Xử lý upload ảnh nếu có
    let avatarUrl = group.avatar;
    if (avatarFile) {
      const mimeType = avatarFile.mimetype;
      const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
      if (!allowedTypes.includes(mimeType)) {
        throw new AppError(`Định dạng ảnh không hỗ trợ! MIME type: ${mimeType}`, 400);
      }

      const s3Key = `groups/${groupId}/${uuidv4()}.${mimeType.split('/')[1]}`;
      await s3.upload({
        Bucket: process.env.BUCKET_NAME_GroupChat_Send,
        Key: s3Key,
        Body: avatarFile.buffer,
        ContentType: mimeType,
      }).promise();
      avatarUrl = `https://${process.env.BUCKET_NAME_GroupChat_Send}.s3.amazonaws.com/${s3Key}`;
    }

    // Chuẩn bị dữ liệu update
    const updateExpressionParts = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (name) {
      updateExpressionParts.push("#name = :name");
      expressionAttributeValues[":name"] = name.trim();
      expressionAttributeNames["#name"] = "name";
    }
    if (avatarFile) {
      updateExpressionParts.push("avatar = :avatar");
      expressionAttributeValues[":avatar"] = avatarUrl;
    }

    if (updateExpressionParts.length > 0) {
      await dynamoDB.update({
        TableName: "Groups",
        Key: { groupId },
        UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
        ExpressionAttributeValues: expressionAttributeValues,
        ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined
      }).promise();
    }

    // Tạo tin nhắn hệ thống
    const messageContent = name && avatarFile
      ? `${userName} đã thay đổi tên nhóm thành "${name}" và cập nhật ảnh đại diện.`
      : name
        ? `${userName} đã thay đổi tên nhóm thành "${name}".`
        : `${userName} đã cập nhật ảnh đại diện nhóm.`;

    await sendMessageCore({
      groupId,
      senderId: null,
      type: 'text',
      content: messageContent,
      metadata: { system: true, userId, name, avatar: avatarUrl },
      isAnonymous: false,
      isSecret: false,
      ownerId: groupId,
      status: MESSAGE_STATUSES.SENT,
    }, 'GroupMessages', process.env.BUCKET_NAME_Chat_Send);

    // Emit socket
    io().to(group.members).emit('groupEvent', {
      event: 'groupInfoUpdated',
      groupId,
      name: name || group.name,
      avatar: avatarUrl,
      updatedBy: userName,
    });

    logger.info('Cập nhật thông tin nhóm thành công', { groupId, userId, name, avatar: avatarUrl });

    return {
      message: 'Cập nhật thông tin nhóm thành công!',
      groupId,
      name: name || group.name,
      avatar: avatarUrl,
    };
  } catch (error) {
    logger.error("❌ Lỗi trong updateGroupInfo:", error);
    throw error instanceof AppError
      ? error
      : new AppError(`Lỗi khi cập nhật thông tin nhóm: ${error.message}`, 500);
  }
};



const joinGroup = async (groupId, userId) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (group.members.includes(userId)) {
    throw new AppError('Bạn đã là thành viên của nhóm này!', 400);
  }

  const userProfile = await getOwnProfile(userId);
  if (!userProfile) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  const userName = userProfile.name;

  if (group.settings.requireApproval) {
    const request = {
      groupId,
      userId,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      inviterId: null,
    };

    await dynamoDB.put({
      TableName: 'GroupJoinRequests',
      Item: request,
    }).promise();

    const adminMembers = group.members.filter(memberId => ['admin', 'co-admin'].includes(group.roles[memberId]));
    io().to(adminMembers).emit('groupEvent', {
      event: 'joinRequest',
      groupId,
      userId,
      userName,
      inviterName: null,
    });

    logger.info('Tạo yêu cầu tham gia nhóm thành công', { groupId, userId });
    return {
      message: `Yêu cầu tham gia nhóm đã được gửi, chờ phê duyệt!`,
      groupId,
      userId,
    };
  }

  await addMemberCore(groupId, userId, group);
  return { message: `${userName} đã tham gia nhóm!`, groupId };
};

const addMemberToGroup = async (groupId, inviterId, newUserId) => {
  // Kiểm tra hợp lệ các tham số đầu vào
  if (!groupId || !isValidUUID(groupId) || !inviterId || !isValidUUID(inviterId) || !newUserId || !isValidUUID(newUserId)) {
    throw new AppError('groupId, inviterId hoặc newUserId không hợp lệ!', 400);
  }

  // Kiểm tra xem người mời có cố gắng mời chính mình không
  if (inviterId === newUserId) {
    throw new AppError('Bạn không thể tự thêm chính mình vào nhóm!', 400);
  }

  // Kiểm tra xem nhóm có tồn tại không
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;

  // Kiểm tra xem người mời có phải là thành viên của nhóm không
  if (!group.members?.includes(inviterId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  // Kiểm tra quyền thêm thành viên dựa trên cài đặt nhóm
  if (!group.settings.allowAddMembers && !['admin', 'co-admin'].includes(group.roles[inviterId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới được phép thêm thành viên!', 403);
  }

  // Kiểm tra số lượng thành viên trong nhóm
  if (group.members.length >= 100) {
    throw new AppError('Nhóm đã đầy, không thể thêm thành viên!', 400);
  }

  // Kiểm tra người dùng mới đã là thành viên chưa
  if (group.members.includes(newUserId)) {
    throw new AppError('Người dùng đã là thành viên của nhóm!', 400);
  }

  // Lấy thông tin người mời và người mới
  const inviterProfile = await getOwnProfile(inviterId);
  const newUserProfile = await getOwnProfile(newUserId);
  if (!inviterProfile || !newUserProfile) {
    throw new AppError('Người mời hoặc người được mời không tồn tại!', 404);
  }
  const inviterName = inviterProfile.name;
  const newUserName = newUserProfile.name;

  // Nếu yêu cầu phê duyệt, tạo yêu cầu tham gia nhóm
  if (group.settings.requireApproval && !['admin', 'co-admin'].includes(group.roles[inviterId])) {
    const request = {
      groupId,
      userId: newUserId,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      inviterId,
    };

    await dynamoDB.put({
      TableName: 'GroupJoinRequests',
      Item: request,
    }).promise();

    // Gửi sự kiện yêu cầu tham gia đến các quản trị viên
    const adminMembers = group.members.filter(memberId => ['admin', 'co-admin'].includes(group.roles[memberId]));
    io().to(adminMembers).emit('groupEvent', {
      event: 'joinRequest',
      groupId,
      userId: newUserId,
      userName: newUserName,
      inviterName,
    });

    logger.info('Tạo yêu cầu tham gia nhóm thành công', { groupId, newUserId, inviterId });
    return {
      message: `Yêu cầu tham gia nhóm của ${newUserName} đã được gửi, chờ phê duyệt!`,
      groupId,
      userId: newUserId,
    };
  }

  // Nếu không yêu cầu phê duyệt, thêm thành viên vào nhóm ngay lập tức
  await addMemberCore(groupId, newUserId, group, inviterName);
  return { message: `${newUserName} đã được thêm vào nhóm thành công!`, groupId };
};

const approveJoinRequest = async (groupId, adminUserId, userId, approve, reason = null) => {
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId, adminUserId hoặc userId không hợp lệ!', 400);
  }
  if (typeof approve !== 'boolean') {
    throw new AppError('approve phải là boolean!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (!['admin', 'co-admin'].includes(group.roles[adminUserId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới có quyền phê duyệt!', 403);
  }

  const requestResult = await dynamoDB.get({ TableName: 'GroupJoinRequests', Key: { groupId, userId } }).promise();
  if (!requestResult.Item || requestResult.Item.status !== 'pending') {
    throw new AppError('Yêu cầu tham gia không tồn tại hoặc đã được xử lý!', 400);
  }

  const request = requestResult.Item;
  const userProfile = await getOwnProfile(userId);
  if (!userProfile) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  const userName = userProfile.name;

  try {
    if (approve) {
      if (group.members.includes(userId)) {
        throw new AppError('Người dùng đã là thành viên của nhóm!', 400);
      }
      const inviterName = request.inviterId ? (await getOwnProfile(request.inviterId))?.name : null;
      await addMemberCore(groupId, userId, group, inviterName);

      await dynamoDB.update({
        TableName: 'GroupJoinRequests',
        Key: { groupId, userId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'approved',
        },
      }).promise();

      io().to(userId).emit('groupEvent', {
        event: 'joinRequestProcessed',
        groupId,
        approved: true,
        groupName: group.name,
      });

      logger.info('Yêu cầu tham gia nhóm đã được phê duyệt', { groupId, userId, adminUserId });
      return {
        message: `Yêu cầu tham gia nhóm của ${userName} đã được phê duyệt!`,
        groupId,
        userId,
        approved: true,
      };
    } else {
      // Gọi hàm rejectJoinRequest khi từ chối
      return await rejectJoinRequest(groupId, adminUserId, userId, reason);
    }
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi xử lý yêu cầu tham gia nhóm: ${error.message}`, 500);
  }
};

const rejectJoinRequest = async (groupId, adminUserId, userId, reason = null) => {
  // 1. Kiểm tra tham số đầu vào
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId, adminUserId hoặc userId không hợp lệ!', 400);
  }

  // 2. Kiểm tra nhóm tồn tại
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;

  // 3. Kiểm tra quyền của adminUserId
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (!['admin', 'co-admin'].includes(group.roles[adminUserId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới có quyền từ chối yêu cầu!', 403);
  }

  // 4. Kiểm tra yêu cầu tham gia
  const requestResult = await dynamoDB.get({ TableName: 'GroupJoinRequests', Key: { groupId, userId } }).promise();
  if (!requestResult.Item || requestResult.Item.status !== 'pending') {
    throw new AppError('Yêu cầu tham gia không tồn tại hoặc đã được xử lý!', 400);
  }

  const request = requestResult.Item;

  // 5. Lấy thông tin người dùng
  const userProfile = await getOwnProfile(userId);
  if (!userProfile) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  const userName = userProfile.name;

  try {
    // 6. Cập nhật trạng thái yêu cầu thành 'rejected'
    await dynamoDB.update({
      TableName: 'GroupJoinRequests',
      Key: { groupId, userId },
      UpdateExpression: 'SET #status = :status' + (reason ? ', rejectionReason = :reason' : ''),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'rejected',
        ...(reason && { ':reason': reason }),
      },
    }).promise();

    // 7. Phát sự kiện Socket.IO
    io().to(userId).emit('groupEvent', {
      event: 'joinRequestProcessed',
      groupId,
      approved: false,
      groupName: group.name,
      ...(reason && { rejectionReason: reason }),
    });

    // 8. Ghi log và trả về kết quả
    logger.info('Yêu cầu tham gia nhóm đã được từ chối', { groupId, userId, adminUserId, reason });
    return {
      message: `Yêu cầu tham gia nhóm của ${userName} đã được từ chối!`,
      groupId,
      userId,
      approved: false,
      ...(reason && { rejectionReason: reason }),
    };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi từ chối yêu cầu tham gia nhóm: ${error.message}`, 500);
  }
};

const getGroupJoinRequests = async (groupId, adminUserId, status = 'pending', limit = 50, lastEvaluatedKey = null) => {
  // 1. Kiểm tra tham số đầu vào
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId)) {
    throw new AppError('groupId hoặc adminUserId không hợp lệ!', 400);
  }

  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new AppError('Trạng thái không hợp lệ! Phải là pending, approved hoặc rejected.', 400);
  }

  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

  // 2. Kiểm tra nhóm tồn tại
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;

  // 3. Kiểm tra quyền của adminUserId
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (!['admin', 'co-admin'].includes(group.roles[adminUserId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới có quyền xem danh sách yêu cầu!', 403);
  }

  // 4. Truy vấn danh sách yêu cầu tham gia nhóm
  const params = {
    TableName: 'GroupJoinRequests',
    IndexName: 'GroupStatusIndex',
    KeyConditionExpression: 'groupId = :groupId AND #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':groupId': groupId,
      ':status': status,
    },
    Limit: limit,
    ExclusiveStartKey: lastEvaluatedKey,
  };

  const requestResult = await dynamoDB.query(params).promise();

  // 5. Lấy thông tin profile của từng người dùng yêu cầu
  const requests = await Promise.all(
    (requestResult.Items || []).map(async (request) => {
      const userProfile = await getOwnProfile(request.userId);
      const inviterProfile = request.inviterId ? await getOwnProfile(request.inviterId) : null;

      return {
        groupId: request.groupId,
        userId: request.userId,
        userName: userProfile?.name || 'Không xác định',
        userAvatar: userProfile?.avatar || null,
        status: request.status,
        requestedAt: request.requestedAt,
        inviterId: request.inviterId,
        inviterName: inviterProfile?.name || null,
      };
    })
  );

  // 6. Trả về kết quả
  logger.info('Lấy danh sách yêu cầu tham gia nhóm thành công', { groupId, adminUserId, status });
  return {
    requests,
    lastEvaluatedKey: requestResult.LastEvaluatedKey || null,
    total: requests.length,
  };
};

const getGroupInfo = async (groupId, userId) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  return {
    groupId: group.groupId,
    name: group.name,
    avatar: group.avatar,
    memberCount: `${group.members.length} thành viên`,
    createdBy: group.createdBy,
    createdAt: group.createdAt,
    settings: group.settings,
    userRole: group.roles[userId],
  };
};

const leaveGroup = async (groupId, userId) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 400);
  }

  const userProfile = await getOwnProfile(userId);
  if (!userProfile) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  const userName = userProfile.name;

  const { newMembers, newAdminId, groupDeleted } = await removeMemberCore(groupId, userId, group);
  if (groupDeleted) {
    return { message: 'Nhóm đã bị xóa vì không còn thành viên!', groupId };
  }
  return {
    message: `${userName} đã rời nhóm!`,
    groupId,
    newAdmin: newAdminId,
  };
};

const deleteGroup = async (groupId, adminUserId) => {
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId)) {
    throw new AppError('adminUserId hoặc groupId không hợp lệ!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (group.roles[adminUserId] !== 'admin') {
    throw new AppError('Bạn không có quyền xóa nhóm!', 403);
  }

  const members = group.members;

  try {
    const conversationDeleteRequests = members.map(userId => ({
      DeleteRequest: { Key: { userId, targetUserId: groupId } },
    }));

    for (let i = 0; i < conversationDeleteRequests.length; i += 25) {
      await dynamoDB.batchWrite({
        RequestItems: { 'Conversations': conversationDeleteRequests.slice(i, i + 25) },
      }).promise();
    }

    const memberDeleteRequests = members.map(userId => ({
      DeleteRequest: { Key: { groupId, userId } },
    }));

    for (let i = 0; i < memberDeleteRequests.length; i += 25) {
      await dynamoDB.batchWrite({
        RequestItems: { 'GroupMembers': memberDeleteRequests.slice(i, i + 25) },
      }).promise();
    }

    await dynamoDB.delete({ TableName: 'Groups', Key: { groupId } }).promise();
    await deleteGroupMessages(groupId);

    io().to(members).emit('groupEvent', { event: 'groupDeleted', groupId });
    members.forEach(memberId => {
      io().to(memberId).emit('conversationDeleted', { targetUserId: groupId });
    });

    logger.info('Xóa nhóm và hội thoại thành công', { groupId });
    return { message: 'Xóa nhóm thành công!', groupId };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi xóa nhóm: ${error.message}`, 500);
  }
};

const kickMember = async (groupId, adminUserId, targetUserId) => {
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId) || !targetUserId || !isValidUUID(targetUserId)) {
    throw new AppError('adminUserId hoặc targetUserId không hợp lệ!', 400);
  }
  if (adminUserId === targetUserId) {
    throw new AppError('Bạn không thể tự đá chính mình! Hãy dùng chức năng rời nhóm.', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (group.roles[adminUserId] !== 'admin') {
    throw new AppError('Bạn không có quyền đá thành viên khác!', 403);
  }
  if (!group.members.includes(targetUserId)) {
    throw new AppError('Thành viên cần đá không có trong nhóm!', 400);
  }

  const targetUserProfile = await getOwnProfile(targetUserId);
  if (!targetUserProfile) {
    throw new AppError('Thành viên cần đá không tồn tại!', 404);
  }
  const targetUserName = targetUserProfile.name;

  const { newMembers, newAdminId, groupDeleted } = await removeMemberCore(groupId, targetUserId, group, true, adminUserId);
  if (groupDeleted) {
    return { message: `Nhóm đã bị xóa vì không còn thành viên!`, groupId };
  }
  return {
    message: `${targetUserName} đã bị nhóm trưởng mời ra khỏi nhóm!`,
    groupId,
    newAdmin: newAdminId,
  };
};

const sendGroupMessage = async (groupId, senderId, messageData) => {
  if (!groupId || !isValidUUID(groupId) || !senderId || !isValidUUID(senderId) || !messageData || !messageData.type) {
    throw new AppError('groupId, senderId hoặc messageData không hợp lệ!', 400);
  }

  const { type, content, file, fileName, mimeType, metadata, isAnonymous = false, isSecret = false, quality, replyToMessageId } = messageData;

  const groupResult = await dynamoDB.get({ TableName: GROUP_TABLE, Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(senderId)) {
    throw new AppError('Bạn không phải thành viên nhóm!', 403);
  }

  if (replyToMessageId) {
    const result = await retryQuery({
      TableName: TABLE_NAME,
      IndexName: 'groupId-messageId-index',
      KeyConditionExpression: 'groupId = :gId AND messageId = :mId',
      ExpressionAttributeValues: { ':gId': groupId, ':mId': replyToMessageId },
    });
    if (!result.Items || result.Items.length === 0) {
      throw new AppError('Tin nhắn trả lời không tồn tại!', 400);
    }
  }

  const newMessage = {
    groupId,
    messageId: uuidv4(),
    senderId: isAnonymous ? null : senderId,
    type,
    content: content ? content.trim() : null,
    mediaUrl: null,
    fileName,
    mimeType,
    metadata: metadata || null,
    isAnonymous,
    isSecret,
    quality,
    replyToMessageId: replyToMessageId || null,
    file: file || null,
    timestamp: new Date().toISOString(),
  };

  const savedMessage = await sendMessageCore(newMessage, TABLE_NAME, bucketName);
  
  // Cập nhật lastMessage cho tất cả thành viên trong nhóm
  await updateLastMessageForGroup(groupId, savedMessage);

  io().to(groupId).emit('groupMessage', savedMessage);
  return savedMessage;
};

const updateLastMessageForGroup = async (groupId, message = null) => {
  try {
    const groupResult = await dynamoDB.get({
      TableName: 'Groups',
      Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
      logger.warn('Nhóm không tồn tại khi cập nhật lastMessage', { groupId });
      return;
    }

    const group = groupResult.Item;
    const members = group.members;

    // Nếu chưa truyền message vào → lấy tin nhắn mới nhất hợp lệ
    let lastMessage = message;
    if (!lastMessage) {
      const messagesResult = await dynamoDB.query({
        TableName: 'GroupMessages',
        IndexName: 'GroupMessagesIndex',
        KeyConditionExpression: 'groupId = :groupId',
        ExpressionAttributeValues: { ':groupId': groupId },
        ScanIndexForward: false,
      }).promise();

      lastMessage = (messagesResult.Items || []).find(
        msg => msg.status !== MESSAGE_STATUSES.DELETE && msg.status !== MESSAGE_STATUSES.RECALLED
      ) || null;
    }

    const lastMessageData = lastMessage
      ? {
          messageId: lastMessage.messageId,
          content:
            lastMessage.status === MESSAGE_STATUSES.RECALLED || lastMessage.status === MESSAGE_STATUSES.ADMINDRECALLED
              ? 'Tin nhắn đã bị thu hồi'
              : (lastMessage.content || GET_DEFAULT_CONTENT_BY_TYPE(lastMessage.type)),
          createdAt: lastMessage.timestamp,
          senderId: lastMessage.senderId,
          type: lastMessage.type,
          isRecalled: lastMessage.status === MESSAGE_STATUSES.RECALLED || lastMessage.status === MESSAGE_STATUSES.ADMINDRECALLED,
        }
      : null;

    const now = new Date().toISOString();

    await Promise.all(
      members.map((memberId) =>
        dynamoDB.update({
          TableName: 'Conversations',
          Key: { userId: memberId, targetUserId: groupId },
          UpdateExpression: 'SET lastMessage = :lastMessage, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':lastMessage': lastMessageData,
            ':updatedAt': now,
          },
        }).promise()
      )
    );

    logger.info('✅ Đã cập nhật lastMessage cho nhóm', {
      groupId,
      lastMessage: lastMessageData,
    });
  } catch (error) {
    logger.error('❌ Lỗi trong updateLastMessageForGroup', {
      groupId,
      error: error.message,
    });
  }
};


// Hàm cho group-1
const forwardGroupMessageToUser = async (senderId, messageId, sourceGroupId, targetReceiverId) => {
  const { forwardMessageUnified } = require('./message.service');
  return await forwardMessageUnified(senderId, messageId, true, false, sourceGroupId, targetReceiverId);
};

// Hàm cho group-group
const forwardGroupMessage = async (senderId, messageId, sourceGroupId, targetGroupId) => {
  const { forwardMessageUnified } = require('./message.service');
  return await forwardMessageUnified(senderId, messageId, true, true, sourceGroupId, targetGroupId);
};

const recallGroupMessage = async (groupId, senderId, messageId) => {
  const result = await manageGroupMessage(groupId, senderId, messageId, 'recall');

  if (result.success) {
    const conversations = await dynamoDB.query({
      TableName: 'Conversations',
      IndexName: 'targetUserId-index',
      KeyConditionExpression: 'targetUserId = :groupId',
      ExpressionAttributeValues: { ':groupId': groupId },
    }).promise();

    const shouldUpdateLastMessage = conversations.Items?.some(
      conv => conv.lastMessage?.messageId === messageId
    );

    if (shouldUpdateLastMessage) {
      await updateLastMessageForGroup(groupId);
    }
  }

  return result;
};

const deleteGroupMessage = async (groupId, senderId, messageId) => {
  // Gọi manageGroupMessage để thực hiện hành động xóa tin nhắn
  const result = await manageGroupMessage(groupId, senderId, messageId, 'delete');

  if (result.success) {
    // Kiểm tra xem tin nhắn vừa xóa có phải là lastMessage của thành viên đang xóa không
    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: senderId, targetUserId: groupId },
    }).promise();

    const shouldUpdateLastMessage = conversation.Item?.lastMessage?.messageId === messageId;

    if (shouldUpdateLastMessage) {
      // Lấy tin nhắn mới nhất hợp lệ (không bị xóa bởi senderId, không bị thu hồi)
      const messagesResult = await dynamoDB.query({
        TableName: 'GroupMessages',
        IndexName: 'GroupMessagesIndex',
        KeyConditionExpression: 'groupId = :groupId',
        ExpressionAttributeValues: { ':groupId': groupId },
        ScanIndexForward: false, // Lấy tin nhắn mới nhất
      }).promise();

      // Tìm tin nhắn mới nhất hợp lệ
      const lastMessage = (messagesResult.Items || []).find(
        msg =>
          // Không bị thu hồi
          ![MESSAGE_STATUSES.RECALLED, MESSAGE_STATUSES.ADMINDRECALLED].includes(msg.status) &&
          // Không bị xóa bởi senderId
          !(Array.isArray(msg.deletedBy) && msg.deletedBy.includes(senderId))
      ) || null;

      // Chuẩn bị dữ liệu lastMessage mới
      const lastMessageData = lastMessage
        ? {
            messageId: lastMessage.messageId,
            content:
              lastMessage.status === MESSAGE_STATUSES.RECALLED || lastMessage.status === MESSAGE_STATUSES.ADMINDRECALLED
                ? 'Tin nhắn đã bị thu hồi'
                : (lastMessage.content || GET_DEFAULT_CONTENT_BY_TYPE(lastMessage.type)),
            createdAt: lastMessage.timestamp,
            senderId: lastMessage.senderId,
            type: lastMessage.type,
            isRecalled: lastMessage.status === MESSAGE_STATUSES.RECALLED || lastMessage.status === MESSAGE_STATUSES.ADMINDRECALLED,
          }
        : null;

      // Cập nhật lastMessage chỉ cho thành viên đang xóa
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: senderId, targetUserId: groupId },
        UpdateExpression: 'SET lastMessage = :lastMessage, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':lastMessage': lastMessageData,
          ':updatedAt': new Date().toISOString(),
        },
      }).promise();

      logger.info('✅ Đã cập nhật lastMessage cho thành viên', {
        groupId,
        userId: senderId,
        lastMessage: lastMessageData,
      });
    }
  }

  return result;
};

const manageGroupMessage = async (groupId, senderId, messageId, action) => {
  // Kiểm tra tham số đầu vào
  if (!groupId || !isValidUUID(groupId) || !senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId)) {
    throw new AppError('Tham số không hợp lệ', 400);
  }
  if (!['delete', 'recall'].includes(action)) {
    throw new AppError('Hành động hoặc phạm vi không hợp lệ!', 400);  
  }

  // Lấy thông tin nhóm để kiểm tra vai trò và thành viên
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }
  const group = groupResult.Item;

  // Kiểm tra xem người dùng có phải là thành viên của nhóm không
  if (!group.members.includes(senderId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  const userRole = group.roles[senderId] || 'member';

  // Lấy thông tin tin nhắn
  const result = await retryQuery({
    TableName: TABLE_NAME,
    IndexName: 'groupId-messageId-index',
    KeyConditionExpression: 'groupId = :gId AND messageId = :mId',
    ExpressionAttributeValues: { ':gId': groupId, ':mId': messageId },
  });

  if (!result.Items || result.Items.length === 0) {
    throw new AppError('Tin nhắn không tồn tại!', 404);
  }

  const message = result.Items[0];

 
  if (action === 'recall' && [MESSAGE_STATUSES.RECALLED, MESSAGE_STATUSES.ADMINDRECALLED].includes(message.status)) {
    throw new AppError('Tin nhắn đã được thu hồi trước đó!', 400);
  }

  // Kiểm tra thời gian thu hồi (nếu là hành động recall)
  if (action === 'recall') {
    const messageTimestamp = new Date(message.timestamp).getTime();
    const currentTimestamp = new Date().getTime();
    const timeDiffHours = (currentTimestamp - messageTimestamp) / (1000 * 60 * 60);
    if (timeDiffHours > 24) {
      throw new AppError('Không thể thu hồi tin nhắn sau 24 giờ!', 400);
    }
  }

  // Xử lý hành động DELETE
  if (action === 'delete') {
    
      // Bất kỳ ai cũng có thể xóa tin nhắn cho chính mình
      const deletedBy = message.deletedBy || []; // Lấy danh sách deletedBy hiện tại, hoặc mảng rỗng nếu chưa có
      const deletedAt = message.deletedAt || {}; // Lấy deletedAt hiện tại, hoặc object rỗng nếu chưa có

      // Kiểm tra xem người dùng đã xóa tin nhắn chưa
      if (deletedBy.includes(senderId)) {
        throw new AppError('Bạn đã xóa tin nhắn này trước đó!', 400);
      }

      // Cập nhật deletedBy và deletedAt
      deletedBy.push(senderId); // Thêm senderId vào deletedBy
      deletedAt[senderId] = new Date().toISOString(); // Thêm thời gian xóa cho senderId

      // Cập nhật bản ghi tin nhắn
      await dynamoDB.update({
        TableName: TABLE_NAME,
        Key: { groupId, timestamp: message.timestamp },
        UpdateExpression: 'SET deletedBy = :deletedBy, deletedAt = :deletedAt',
        ExpressionAttributeValues: {
          ':deletedBy': deletedBy,
          ':deletedAt': deletedAt,
        },
      }).promise();

      io().to(senderId).emit('groupMessageDeleted', { groupId, messageId });
      return { success: true, message: 'Tin nhắn đã được xóa chỉ với bạn!' };
    
  }

  // Xử lý hành động RECALL
  if (action === 'recall') {
      // Thu hồi với phạm vi 'everyone'
      let recallStatus;
      if (message.senderId === senderId || userRole === 'admin') {
        // Người gửi hoặc admin thu hồi tin nhắn
        recallStatus = userRole === 'admin' && message.senderId !== senderId ? MESSAGE_STATUSES.ADMINDRECALLED : MESSAGE_STATUSES.RECALLED;
      } else {
        throw new AppError('Bạn không có quyền thu hồi tin nhắn này cho mọi người!', 403);
      }

      await dynamoDB.update({
        TableName: TABLE_NAME,
        Key: { groupId, timestamp: message.timestamp },
        UpdateExpression: 'SET #status = :r',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':r': recallStatus },
      }).promise();

      io().to(groupId).emit('groupMessageRecalled', { groupId, messageId, status: recallStatus });
      return { success: true, message: `Tin nhắn đã được thu hồi với mọi người! Trạng thái: ${recallStatus}` };
  }

  // Nếu không khớp với hành động nào
  throw new AppError('Hành động không được hỗ trợ!', 400);
};

const restoreGroupMessage = async (groupId, senderId, messageId) => {
  if (!groupId || !isValidUUID(groupId) || !senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId)) {
    throw new AppError('Tham số không hợp lệ cho restoreGroupMessage', 400);
  }

  const result = await retryQuery({
    TableName: TABLE_NAME,
    IndexName: 'groupId-messageId-index',
    KeyConditionExpression: 'groupId = :gId AND messageId = :mId',
    ExpressionAttributeValues: { ':gId': groupId, ':mId': messageId },
  });

  if (!result.Items || result.Items.length === 0) {
    throw new AppError('Tin nhắn không tồn tại hoặc đã bị xóa hoàn toàn!', 404);
  }

  const message = result.Items[0];
  if (message.senderId !== senderId) {
    throw new AppError('Bạn không có quyền khôi phục tin nhắn này!', 403);
  }

  await dynamoDB.delete({ TableName: USER_DELETED_TABLE, Key: { userId: senderId, messageId } }).promise();

  // Kiểm tra xem tin nhắn được khôi phục có phải là mới nhất không
  const latestMessageResult = await dynamoDB.query({
    TableName: 'GroupMessages',
    IndexName: 'GroupMessagesIndex',
    KeyConditionExpression: 'groupId = :groupId',
    ExpressionAttributeValues: { ':groupId': groupId },
    ScanIndexForward: false,
    Limit: 1,
  }).promise();

  const latestMessage = latestMessageResult.Items?.[0];
  if (latestMessage && latestMessage.messageId === messageId) {
    await updateLastMessageForGroup(groupId, message);
  }

  io().to(senderId).emit('groupMessageRestored', { groupId, messageId });
  return { success: true, message: 'Tin nhắn đã được khôi phục!' };
};

const pinGroupMessage = async (groupId, senderId, messageId) => {
  if (!groupId || !isValidUUID(groupId) || !senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId)) {
    throw new AppError('Tham số không hợp lệ cho pinGroupMessage', 400);
  }

  const group = await dynamoDB.get({ TableName: GROUP_TABLE, Key: { groupId } }).promise();
  if (!group.Item || !group.Item.members.includes(senderId)) {
    throw new AppError('Nhóm không tồn tại hoặc bạn không có quyền!', 403);
  }

  const pinnedMessages = group.Item.pinnedMessages || [];
  if (!pinnedMessages.includes(messageId)) {
    pinnedMessages.push(messageId);
    await dynamoDB.update({
      TableName: GROUP_TABLE,
      Key: { groupId },
      UpdateExpression: 'SET pinnedMessages = :p',
      ExpressionAttributeValues: { ':p': pinnedMessages },
    }).promise();
    io().to(groupId).emit('groupMessagePinned', { groupId, messageId });
  }

  return { success: true, message: 'Tin nhắn đã được ghim!' };
};

const getGroupMembers = async (groupId, userId) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  // Kiểm tra nhóm tồn tại
  const groupResult = await dynamoDB.get({
    TableName: 'Groups',
    Key: { groupId }
  }).promise();

  const group = groupResult.Item;
  if (!group) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  // Kiểm tra quyền truy cập nhóm
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  // Lấy danh sách thành viên
  const memberRecords = await dynamoDB.query({
    TableName: 'GroupMembers',
    KeyConditionExpression: 'groupId = :groupId',
    ExpressionAttributeValues: { ':groupId': groupId },
  }).promise();

  let members = memberRecords.Items;

  // Nếu không phải hiện toàn bộ thành viên, thì lọc theo điều kiện
  if (!group.settings?.showAllMembers) {
    members = members.filter(
      member =>
        member.userId === userId ||
        ['admin', 'co-admin'].includes(member.role)
    );
  }

  // Lấy thông tin profile của các thành viên (loại bỏ password)
  const membersToShow = (await Promise.all(
    members.map(async member => {
      const profile = await getOwnProfile(member.userId);
      if (!profile) return null;
      const { password, ...safeProfile } = profile;
      return {
        userId: member.userId,
        ...safeProfile,
        role: member.role,
        joinedAt: member.createdAt,
      };
    })
  )).filter(Boolean); // Loại null nếu có profile không tồn tại

  return {
    groupId,
    members: membersToShow,
    totalMembers: group.members.length,
  };
};

const updateCommunitySettings = async (groupId, adminUserId, settings) => {
  if (!groupId || !isValidUUID(groupId) || !adminUserId || !isValidUUID(adminUserId)) {
    throw new AppError('groupId hoặc adminUserId không hợp lệ!', 400);
  }

  // Extract new settings from the request body
  const { 
    allowChangeGroupInfo, 
    showAllMembers, 
    allowAddMembers, 
    requireApproval, 
    restrictMessaging 
  } = settings;

  // Ensure all settings are boolean values
  if (
    typeof allowChangeGroupInfo !== 'boolean' ||
    typeof showAllMembers !== 'boolean' ||
    typeof allowAddMembers !== 'boolean' ||
    typeof requireApproval !== 'boolean' ||
    typeof restrictMessaging !== 'boolean'
  ) {
    throw new AppError('Các cài đặt phải là boolean!', 400);
  }

  // Get the group from the database
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;

  // Check if the requesting user is a member and an admin of the group
  if (!group.members?.includes(adminUserId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }
  if (group.roles[adminUserId] !== 'admin') {
    throw new AppError('Chỉ trưởng nhóm mới có quyền thay đổi cài đặt này!', 403);
  }

  try {
    // Update the group's settings in the database
    await dynamoDB.update({
      TableName: 'Groups',
      Key: { groupId },
      UpdateExpression: 'SET #settings.#allowChangeGroupInfo = :allowChangeGroupInfo, ' +
                       '#settings.#showAllMembers = :showAllMembers, ' +
                       '#settings.#allowAddMembers = :allowAddMembers, ' +
                       '#settings.#requireApproval = :requireApproval, ' +
                       '#settings.#restrictMessaging = :restrictMessaging',
      ExpressionAttributeNames: {
        '#settings': 'settings',
        '#allowChangeGroupInfo': 'allowChangeGroupInfo',
        '#showAllMembers': 'showAllMembers',
        '#allowAddMembers': 'allowAddMembers',
        '#requireApproval': 'requireApproval',
        '#restrictMessaging': 'restrictMessaging'
      },
      ExpressionAttributeValues: {
        ':allowChangeGroupInfo': allowChangeGroupInfo,
        ':showAllMembers': showAllMembers,
        ':allowAddMembers': allowAddMembers,
        ':requireApproval': requireApproval,
        ':restrictMessaging': restrictMessaging
      },
    }).promise();

    // Prepare a message for the changes made
    const changes = [];
    if (group.settings.allowChangeGroupInfo !== allowChangeGroupInfo) {
      changes.push(
        allowChangeGroupInfo
          ? 'Tất cả thành viên được phép thay đổi tên và ảnh nhóm.'
          : 'Chỉ trưởng nhóm và phó nhóm được phép thay đổi tên và ảnh nhóm.'
      );
    }
    if (group.settings.showAllMembers !== showAllMembers) {
      changes.push(
        showAllMembers
          ? 'Tất cả thành viên được phép xem danh sách đầy đủ.'
          : 'Chỉ được xem trưởng nhóm, phó nhóm và chính mình.'
      );
    }
    if (group.settings.allowAddMembers !== allowAddMembers) {
      changes.push(
        allowAddMembers
          ? 'Tất cả thành viên được phép thêm người vào nhóm.'
          : 'Chỉ trưởng nhóm và phó nhóm được phép thêm người vào nhóm.'
      );
    }
    if (group.settings.requireApproval !== requireApproval) {
      changes.push(
        requireApproval
          ? 'Người dùng mới cần được phê duyệt để tham gia nhóm.'
          : 'Người dùng mới tự động trở thành thành viên khi được mời.'
      );
    }
    if (group.settings.restrictMessaging !== restrictMessaging) {
      changes.push(
        restrictMessaging
          ? 'Nhóm sẽ hạn chế nhắn tin cho các thành viên.'
          : 'Nhóm không còn hạn chế nhắn tin cho các thành viên.'
      );
    }

    // If there are any changes, send a message
    if (changes.length > 0) {
      const messageContent = `Trưởng nhóm đã cập nhật cài đặt nhóm: ${changes.join(' ')}`;
      
      await sendMessageCore({
        groupId,
        senderId: null,
        type: 'text',
        content: messageContent,
        metadata: { system: true, adminUserId, settings },
        isAnonymous: false,
        isSecret: false,
        ownerId: groupId,
        status: MESSAGE_STATUSES.SENT,
      }, 'GroupMessages', process.env.BUCKET_NAME_Chat_Send);

      // Emit a socket event notifying about the group settings update
      io().to(group.members).emit('groupEvent', {
        event: 'communitySettingsUpdated',
        groupId,
        settings: { allowChangeGroupInfo, showAllMembers, allowAddMembers, requireApproval, restrictMessaging },
        message: messageContent,
      });
    }

    // Log success and return the result
    logger.info('Cập nhật cài đặt quản lý cộng đồng thành công', { groupId, settings });
    return {
      message: 'Cập nhật cài đặt quản lý cộng đồng thành công!',
      groupId,
      settings: { allowChangeGroupInfo, showAllMembers, allowAddMembers, requireApproval, restrictMessaging },
    };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi cập nhật cài đặt quản lý cộng đồng: ${error.message}`, 500);
  }
};


const generateGroupLink = async (groupId, userId) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  const groupLink = `https://yourapp.com/join-group?groupId=${groupId}`;
  return {
    message: 'Đường link nhóm đã được tạo!',
    groupId,
    link: groupLink,
  };
};

const getUserGroups = async (userId) => {

  if (!userId || !isValidUUID(userId)) {
    
    throw new AppError('userId không hợp lệ', 400);
  }

  const groupMemberResult = await retryQuery({
    TableName: 'GroupMembers',
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
  });

  if (!groupMemberResult.Items || groupMemberResult.Items.length === 0) {
    return [];
  }

  const groupIds = groupMemberResult.Items.map(item => item.groupId);
  const groupPromises = groupIds.map(async groupId => {
    const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();

    if (!groupResult.Item) return null;

    const group = groupResult.Item;
    const userRole = group.roles?.[userId] || 'member';
    const memberCount = Array.isArray(group.members) ? group.members.length : 0;

    // Loại bỏ trường không cần thiết như quyền admin, quyền system...
    const { password, secretKey, ...groupSafeData } = group;

    return {
      ...groupSafeData,
      groupId: group.groupId,
      name: group.name,
      avatar: group.avatar || null,
      createdAt: group.createdAt,
      userRole,
      memberCount,
    };
  });

  const groups = await Promise.all(groupPromises);
  return groups.filter(group => group); // Loại bỏ null nếu có nhóm không tồn tại
};

const getGroupMessages = async (groupId, userId, limit = 50, lastEvaluatedKey = null) => {
  // 1. Kiểm tra đầu vào
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }

  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

  // 2. Kiểm tra nhóm và thành viên
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }
  if (!groupResult.Item.members?.includes(userId)) {
    throw new AppError('Bạn không phải thành viên nhóm!', 403);
  }

  // 3. Lấy tin nhắn nhóm
  const params = {
    TableName: 'GroupMessages',
    IndexName: 'GroupMessagesIndex',
    KeyConditionExpression: 'groupId = :groupId',
    ExpressionAttributeValues: { ':groupId': groupId },
    ScanIndexForward: true,
    Limit: limit,
    ExclusiveStartKey: lastEvaluatedKey,
  };

  const messages = await retryQuery(params);

  const now = Math.floor(Date.now() / 1000);

  // 4. Lọc bỏ tin nhắn đã bị xóa hoặc hết hạn
  const visibleMessages = (messages.Items || []).filter(msg => {
    if (Array.isArray(msg.deletedBy) && msg.deletedBy.includes(userId)) return false;
    if (msg.expiresAt && msg.expiresAt <= now) return false;
    return true;
  });

  // 5. Lấy thông tin người dùng (4 trường: userId, name, avatar, phoneNumber) cho mỗi senderId
  const senderIds = [...new Set(visibleMessages.map(msg => msg.senderId))]; // Lấy danh sách senderId duy nhất
  const userPromises = senderIds.map(senderId =>
    dynamoDB
      .get({
        TableName: 'Users',
        Key: { userId: senderId },
      })
      .promise()
      .then(result => {
        if (result.Item) {
          // Lấy chỉ 4 trường cần thiết
          const { userId, name, avatar, phoneNumber } = result.Item;
          return { userId, name, avatar, phoneNumber }; // Trả về chỉ các trường này
        } else {
          // Log lỗi khi không có dữ liệu cho userId
          logger.error('User not found', { userId: senderId });
          return {
            userId: senderId,
            name: 'Chưa có tên',
            avatar: 'default-avatar.png',
            phoneNumber: 'Chưa có số điện thoại',
          };
        }
      })
      .catch(error => {
        logger.error('Failed to fetch user info', { userId: senderId, error: error.message });
        return {
          userId: senderId,
          name: 'Chưa có tên',
          avatar: 'default-avatar.png',
          phoneNumber: 'Chưa có số điện thoại',
        };
      })
  );

  const users = await Promise.all(userPromises);
  const userMap = users.reduce((map, user) => {
    map[user.userId] = user; // Thêm toàn bộ dữ liệu người dùng vào map
    return map;
  }, {});

  // 6. Gắn thông tin người dùng vào tin nhắn
  const enrichedMessages = visibleMessages.map(msg => ({
    ...msg,
    sender: {
      ...userMap[msg.senderId],
    },
  }));

  // 7. Trả về kết quả
  return {
    messages: enrichedMessages,
    lastEvaluatedKey: messages.LastEvaluatedKey,
  };
};





module.exports = {
  assignMemberRole ,
  createGroup,
  updateGroupInfo,
  joinGroup,
  addMemberToGroup,
  approveJoinRequest,
  rejectJoinRequest,
  getGroupJoinRequests,
  getGroupInfo,
  leaveGroup,
  deleteGroup,
  kickMember,
  sendGroupMessage,
  recallGroupMessage,
  pinGroupMessage,
  deleteGroupMessage,
  restoreGroupMessage,
  getGroupMembers,
  updateCommunitySettings,
  generateGroupLink,
  getUserGroups,
  getGroupMessages,
  forwardGroupMessageToUser,
  forwardGroupMessage,
};