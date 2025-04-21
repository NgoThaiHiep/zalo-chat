// src/services/group.service.js
const { v4: uuidv4 } = require('uuid');
const { dynamoDB, s3 } = require('../config/aws.config');
const logger = require('../config/logger');
const { sendMessageCore } = require('./messageCore');
const { AppError } = require('../utils/errorHandler');
const { io } = require('../socket');
const { copyS3File } = require('../utils/messageUtils');
const { createConversation } = require('./conversation.service');
const { MESSAGE_STATUSES } = require('../config/constants');
const { getOwnProfile } = require('../services/auth.service');
const { forwardMessageUnified } = require('./message.service');

const TABLE_NAME = 'GroupMessages';
const GROUP_TABLE = 'Groups';
const USER_DELETED_TABLE = 'UserDeletedMessages';
const USER_RECALLS_TABLE = 'UserRecalls';
const bucketName = process.env.BUCKET_NAME_GroupChat_Send;

const isValidUUID = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

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
const manageGroupMessage = async (groupId, senderId, messageId, action, scope = 'everyone') => {
  if (!groupId || !isValidUUID(groupId) || !senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId)) {
    throw new AppError('Tham số không hợp lệ', 400);
  }
  if (!['delete', 'recall'].includes(action) || !['everyone', 'self'].includes(scope)) {
    throw new AppError('Hành động hoặc phạm vi không hợp lệ!', 400);
  }

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
  if (message.senderId !== senderId) {
    throw new AppError(`Bạn không có quyền ${action === 'delete' ? 'xóa' : 'thu hồi'} tin nhắn này!`, 403);
  }

  if (action === 'recall') {
    const messageTimestamp = new Date(message.timestamp).getTime();
    const currentTimestamp = new Date().getTime();
    const timeDiffHours = (currentTimestamp - messageTimestamp) / (1000 * 60 * 60);
    if (timeDiffHours > 24) {
      throw new AppError('Không thể thu hồi tin nhắn sau 24 giờ!', 400);
    }
  }

  if (scope === 'everyone') {
    if (action === 'delete') {
      await dynamoDB.delete({ TableName: TABLE_NAME, Key: { groupId, timestamp: message.timestamp } }).promise();
      if (message.mediaUrl) {
        const key = message.mediaUrl.split('/').slice(3).join('/');
        await s3.deleteObject({ Bucket: bucketName, Key: key }).promise().catch(err => {
          logger.error('Lỗi khi xóa object S3:', { key, error: err.message });
        });
      }
    } else {
      await dynamoDB.update({
        TableName: TABLE_NAME,
        Key: { groupId, timestamp: message.timestamp },
        UpdateExpression: 'SET isRecalled = :r',
        ExpressionAttributeValues: { ':r': true },
      }).promise();
    }
    io().to(groupId).emit(`groupMessage${action === 'delete' ? 'Deleted' : 'Recalled'}`, { groupId, messageId, scope });
    return { success: true, message: `Tin nhắn đã được ${action === 'delete' ? 'xóa' : 'thu hồi'} với mọi người!` };
  } else {
    const table = action === 'delete' ? USER_DELETED_TABLE : USER_RECALLS_TABLE;
    const data = { userId: senderId, messageId, groupId, timestamp: new Date().toISOString() };
    await dynamoDB.put({ TableName: table, Item: data }).promise();
    io().to(senderId).emit(`groupMessage${action === 'delete' ? 'Deleted' : 'Recalled'}`, { groupId, messageId, scope });
    return { success: true, message: `Tin nhắn đã được ${action === 'delete' ? 'xóa' : 'thu hồi'} chỉ với bạn!` };
  }
};

const createGroup = async (name, createdBy, members = [], initialRoles = {}) => {
  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50) {
    throw new AppError('Tên nhóm phải từ 1 đến 50 ký tự!', 400);
  }
  if (!createdBy || !isValidUUID(createdBy)) {
    throw new AppError('createdBy không hợp lệ!', 400);
  }

  const existingGroups = await dynamoDB.query({
    TableName: 'Groups',
    IndexName: 'CreatedByIndex',
    KeyConditionExpression: 'createdBy = :createdBy',
    FilterExpression: '#groupName = :name',
    ExpressionAttributeNames: { '#groupName': 'name' },
    ExpressionAttributeValues: { ':createdBy': createdBy, ':name': name.trim() },
  }).promise();

  if (existingGroups.Items?.length > 0) {
    throw new AppError('Bạn đã tạo nhóm với tên này trước đó. Vui lòng đặt tên khác.', 400);
  }

  const memberIds = await getUserIds(members, createdBy);
  if (memberIds.length < 3) {
    throw new AppError('Nhóm phải có ít nhất 3 thành viên!', 400);
  }

  const roles = { [createdBy]: 'admin' };
  let coAdminCount = 0;
  memberIds.forEach(memberId => {
    if (memberId !== createdBy) {
      const assignedRole = initialRoles[memberId] === 'co-admin' && coAdminCount < 2 ? 'co-admin' : 'member';
      if (assignedRole === 'co-admin') coAdminCount++;
      roles[memberId] = assignedRole;
    }
  });

  const groupId = uuidv4();
  const createdAt = new Date().toISOString();
  const newGroup = {
    groupId,
    name: name.trim(),
    createdBy,
    members: memberIds,
    roles,
    settings: {
      restrictMessaging: false, // Tất cả thành viên có thể nhắn tin (true: chỉ admin/co-admin)
      allowChangeGroupInfo: false, // Tất cả thành viên có thể thay đổi tên/ảnh nhóm (false: chỉ admin/co-admin)
      showAllMembers: true,// Xem đầy đủ thành viên (false: chỉ thấy admin, co-admin, và mình)
      allowAddMembers: false,// Tất cả thành viên có thể thêm người (false: chỉ admin/co-admin)
      requireApproval: false, // Thêm cài đặt: Cần phê duyệt để tham gia (false: không cần phê duyệt)
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
    await dynamoDB.put({
      TableName: 'Groups',
      Item: newGroup,
    }).promise();

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
      await dynamoDB.batchWrite({
        RequestItems: { 'GroupMembers': groupMemberItems.slice(i, i + 25) },
      }).promise();
    }

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
      await dynamoDB.batchWrite({
        RequestItems: { 'Conversations': conversationItems.slice(i, i + 25) },
      }).promise();
    }

    io().to(memberIds).emit('groupEvent', { event: 'groupCreated', groupId, name });
    memberIds.forEach(memberId => {
      io().to(memberId).emit('conversationCreated', { conversationId: uuidv4(), targetUserId: groupId, groupName: name });
    });

    logger.info('Tạo nhóm và hội thoại thành công', { groupId, memberIds });
    return newGroup;
  } catch (error) {
    try {
      await dynamoDB.delete({ TableName: 'Groups', Key: { groupId } }).promise();
      const deleteMemberPromises = memberIds.map(memberId =>
        dynamoDB.delete({ TableName: 'GroupMembers', Key: { groupId, userId: memberId } }).promise()
      );
      const deleteConversationPromises = memberIds.map(memberId =>
        dynamoDB.delete({ TableName: 'Conversations', Key: { userId: memberId, targetUserId: groupId } }).promise()
      );
      await Promise.all([...deleteMemberPromises, ...deleteConversationPromises]);
      logger.info('Đã rollback việc tạo nhóm', { groupId });
    } catch (rollbackError) {
      logger.error('Lỗi khi rollback tạo nhóm', { groupId, error: rollbackError.message });
    }
    throw error instanceof AppError ? error : new AppError(`Lỗi khi tạo nhóm: ${error.message}`, 500);
  }
};

const updateGroupInfo = async (groupId, userId, { name, avatar }) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }
  if (!name && !avatar) {
    throw new AppError('Phải cung cấp ít nhất tên hoặc ảnh đại diện để cập nhật!', 400);
  }
  if (name && (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 50)) {
    throw new AppError('Tên nhóm phải từ 1 đến 50 ký tự!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  if (!group.settings.allowChangeGroupInfo && !['admin', 'co-admin'].includes(group.roles[userId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới được phép thay đổi thông tin nhóm!', 403);
  }

  const userProfile = await getOwnProfile(userId);
  if (!userProfile) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  const userName = userProfile.name;

  try {
    let updateExpression = 'SET ';
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    if (name) {
      updateExpression += '#name = :name';
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = name.trim();
    }
    if (avatar) {
      updateExpression += (name ? ', ' : '') + 'avatar = :avatar';
      expressionAttributeValues[':avatar'] = avatar;
    }

    await dynamoDB.update({
      TableName: 'Groups',
      Key: { groupId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }).promise();

    let messageContent = '';
    if (name && avatar) {
      messageContent = `${userName} đã thay đổi tên nhóm thành "${name}" và cập nhật ảnh đại diện.`;
    } else if (name) {
      messageContent = `${userName} đã thay đổi tên nhóm thành "${name}".`;
    } else {
      messageContent = `${userName} đã cập nhật ảnh đại diện nhóm.`;
    }

    await sendMessageCore({
      groupId,
      senderId: null,
      type: 'text',
      content: messageContent,
      metadata: { system: true, userId, name, avatar },
      isAnonymous: false,
      isSecret: false,
      ownerId: groupId,
      status: MESSAGE_STATUSES.SENT,
    }, 'GroupMessages', process.env.BUCKET_NAME_Chat_Send);

    io().to(group.members).emit('groupEvent', {
      event: 'groupInfoUpdated',
      groupId,
      name: name || group.name,
      avatar: avatar || group.avatar,
      updatedBy: userName,
    });

    logger.info('Cập nhật thông tin nhóm thành công', { groupId, userId, name, avatar });
    return {
      message: 'Cập nhật thông tin nhóm thành công!',
      groupId,
      name: name || group.name,
      avatar: avatar || group.avatar,
    };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi cập nhật thông tin nhóm: ${error.message}`, 500);
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
  if (!groupId || !isValidUUID(groupId) || !inviterId || !isValidUUID(inviterId) || !newUserId || !isValidUUID(newUserId)) {
    throw new AppError('groupId, inviterId hoặc newUserId không hợp lệ!', 400);
  }
  if (inviterId === newUserId) {
    throw new AppError('Bạn không thể tự thêm chính mình vào nhóm!', 400);
  }

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(inviterId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  if (!group.settings.allowAddMembers && !['admin', 'co-admin'].includes(group.roles[inviterId])) {
    throw new AppError('Chỉ trưởng nhóm hoặc phó nhóm mới được phép thêm thành viên!', 403);
  }

  if (group.members.length >= 100) {
    throw new AppError('Nhóm đã đầy, không thể thêm thành viên!', 400);
  }
  if (group.members.includes(newUserId)) {
    throw new AppError('Người dùng đã là thành viên của nhóm!', 400);
  }

  const inviterProfile = await getOwnProfile(inviterId);
  const newUserProfile = await getOwnProfile(newUserId);
  if (!inviterProfile || !newUserProfile) {
    throw new AppError('Người mời hoặc người được mời không tồn tại!', 404);
  }
  const inviterName = inviterProfile.name;
  const newUserName = newUserProfile.name;

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

  await addMemberCore(groupId, newUserId, group, inviterName);
  return { message: `${newUserName} đã được thêm vào nhóm thành công!`, groupId };
};

const approveJoinRequest = async (groupId, adminUserId, userId, approve) => {
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
    }

    await dynamoDB.update({
      TableName: 'GroupJoinRequests',
      Key: { groupId, userId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': approve ? 'approved' : 'rejected',
      },
    }).promise();

    io().to(userId).emit('groupEvent', {
      event: 'joinRequestProcessed',
      groupId,
      approved: approve,
      groupName: group.name,
    });

    logger.info(`Yêu cầu tham gia nhóm đã được ${approve ? 'phê duyệt' : 'từ chối'}`, { groupId, userId, adminUserId });
    return {
      message: `Yêu cầu tham gia nhóm của ${userName} đã được ${approve ? 'phê duyệt' : 'từ chối'}!`,
      groupId,
      userId,
      approved: approve,
    };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(`Lỗi khi xử lý yêu cầu tham gia nhóm: ${error.message}`, 500);
  }
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
    message: `Đã đá thành viên ${targetUserName} thành công!`,
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
    // Lấy thông tin nhóm để biết danh sách thành viên
    const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
    if (!groupResult.Item) {
      logger.warn('Nhóm không tồn tại khi cập nhật lastMessage', { groupId });
      return;
    }

    const group = groupResult.Item;
    const members = group.members;

    // Nếu không có message được cung cấp, lấy tin nhắn cuối cùng hợp lệ từ GroupMessages
    let lastMessage = message;
    if (!lastMessage) {
      const messagesResult = await dynamoDB.query({
        TableName: 'GroupMessages',
        IndexName: 'GroupMessagesIndex',
        KeyConditionExpression: 'groupId = :groupId',
        ExpressionAttributeValues: { ':groupId': groupId },
        ScanIndexForward: false, // Lấy tin nhắn mới nhất
        // Limit: 10, // Lấy tối đa 10 tin nhắn để tìm tin nhắn hợp lệ
      }).promise();

      // Tìm tin nhắn hợp lệ (không bị xóa hoặc thu hồi)
      lastMessage = (messagesResult.Items || []).find(
        msg => msg.status !== MESSAGE_STATUSES.DELETE && msg.status !== MESSAGE_STATUSES.RECALLED
      ) || null;
    }

    // Chuẩn bị dữ liệu lastMessage
    const lastMessageData = lastMessage
      ? {
          messageId: lastMessage.messageId,
          content: lastMessage.content || (lastMessage.type === 'image' ? '[Hình ảnh]' : `[${lastMessage.type}]`),
          createdAt: lastMessage.timestamp, // Đồng bộ với getConversationSummary
          senderId: lastMessage.senderId,
          type: lastMessage.type,
          isRecalled: lastMessage.status === MESSAGE_STATUSES.RECALLED, // Thêm trường isRecalled
        }
      : null;

    // Cập nhật Conversations cho từng thành viên
    const updatePromises = members.map(async (memberId) => {
      try {
        await dynamoDB.update({
          TableName: 'Conversations',
          Key: { userId: memberId, targetUserId: groupId },
          UpdateExpression: 'SET lastMessage = :lastMessage, updatedAt = :updatedAt',
          ExpressionAttributeValues: {
            ':lastMessage': lastMessageData,
            ':updatedAt': new Date().toISOString(),
          },
        }).promise();
      } catch (error) {
        logger.error('Lỗi khi cập nhật lastMessage cho thành viên', { groupId, memberId, error: error.message });
      }
    });

    await Promise.all(updatePromises);
    logger.info('Cập nhật lastMessage thành công cho nhóm', { groupId, lastMessage: lastMessageData });
  } catch (error) {
    logger.error('Lỗi khi cập nhật lastMessage cho nhóm', { groupId, error: error.message });
  }
};

// Hàm cho group-1
const forwardGroupMessageToUser = async (senderId, messageId, sourceGroupId, targetReceiverId) => {
  return await forwardMessageUnified(senderId, messageId, true, false, sourceGroupId, targetReceiverId);
};

// Hàm cho group-group
const forwardGroupMessage = async (senderId, messageId, sourceGroupId, targetGroupId) => {
  return await forwardMessageUnified(senderId, messageId, true, true, sourceGroupId, targetGroupId);
};

const recallGroupMessage = async (groupId, senderId, messageId, recallType = 'everyone') => {
  const result = await manageGroupMessage(groupId, senderId, messageId, 'recall', recallType);

  // Kiểm tra xem tin nhắn bị thu hồi có phải là lastMessage không
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }
  
  const members = groupResult.Item.members;
  let shouldUpdateLastMessage = false;

  // Kiểm tra lastMessage của từng thành viên
  for (const memberId of members) {
    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: memberId, targetUserId: groupId },
    }).promise();
    
    if (conversation.Item?.lastMessage?.messageId === messageId) {
      shouldUpdateLastMessage = true;
      break;
    }
  }

  if (shouldUpdateLastMessage) {
    await updateLastMessageForGroup(groupId);
  }

  return result;
};

const deleteGroupMessage = async (groupId, senderId, messageId, deleteType = 'everyone') => {
  const result = await manageGroupMessage(groupId, senderId, messageId, 'delete', deleteType);

  // Kiểm tra xem tin nhắn bị xóa có phải là lastMessage không
  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }
  
  const members = groupResult.Item.members;
  let shouldUpdateLastMessage = false;

  for (const memberId of members) {
    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: memberId, targetUserId: groupId },
    }).promise();
    
    if (conversation.Item?.lastMessage?.messageId === messageId) {
      shouldUpdateLastMessage = true;
      break;
    }
  }

  if (shouldUpdateLastMessage) {
    await updateLastMessageForGroup(groupId);
  }

  return result;
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

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }

  const group = groupResult.Item;
  if (!group.members?.includes(userId)) {
    throw new AppError('Bạn không phải là thành viên của nhóm này!', 403);
  }

  let membersToShow = [];
  if (group.settings.showAllMembers) {
    const memberRecords = await dynamoDB.query({
      TableName: 'GroupMembers',
      KeyConditionExpression: 'groupId = :groupId',
      ExpressionAttributeValues: { ':groupId': groupId },
    }).promise();

    membersToShow = await Promise.all(
      memberRecords.Items.map(async member => {
        const profile = await getOwnProfile(member.userId);
        return {
          userId: member.userId,
          name: profile?.name || 'Không xác định',
          role: member.role,
          joinedAt: member.createdAt,
        };
      })
    );
  } else {
    const memberRecords = await dynamoDB.query({
      TableName: 'GroupMembers',
      KeyConditionExpression: 'groupId = :groupId',
      ExpressionAttributeValues: { ':groupId': groupId },
    }).promise();

    const filteredMembers = memberRecords.Items.filter(
      member =>
        member.userId === userId ||
        ['admin', 'co-admin'].includes(member.role)
    );

    membersToShow = await Promise.all(
      filteredMembers.map(async member => {
        const profile = await getOwnProfile(member.userId);
        return {
          userId: member.userId,
          name: profile?.name || 'Không xác định',
          role: member.role,
          joinedAt: member.createdAt,
        };
      })
    );
  }

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

  const { allowChangeGroupInfo, showAllMembers, allowAddMembers, requireApproval } = settings;
  if (
    typeof allowChangeGroupInfo !== 'boolean' ||
    typeof showAllMembers !== 'boolean' ||
    typeof allowAddMembers !== 'boolean' ||
    typeof requireApproval !== 'boolean'
  ) {
    throw new AppError('Các cài đặt phải là boolean!', 400);
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
    throw new AppError('Chỉ trưởng nhóm mới có quyền thay đổi cài đặt này!', 403);
  }

  try {
    await dynamoDB.update({
      TableName: 'Groups',
      Key: { groupId },
      UpdateExpression: 'SET #settings.#allowChangeGroupInfo = :allowChangeGroupInfo, ' +
                       '#settings.#showAllMembers = :showAllMembers, ' +
                       '#settings.#allowAddMembers = :allowAddMembers, ' +
                       '#settings.#requireApproval = :requireApproval',
      ExpressionAttributeNames: {
        '#settings': 'settings',
        '#allowChangeGroupInfo': 'allowChangeGroupInfo',
        '#showAllMembers': 'showAllMembers',
        '#allowAddMembers': 'allowAddMembers',
        '#requireApproval': 'requireApproval',
      },
      ExpressionAttributeValues: {
        ':allowChangeGroupInfo': allowChangeGroupInfo,
        ':showAllMembers': showAllMembers,
        ':allowAddMembers': allowAddMembers,
        ':requireApproval': requireApproval,
      },
    }).promise();

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

      io().to(group.members).emit('groupEvent', {
        event: 'communitySettingsUpdated',
        groupId,
        settings: { allowChangeGroupInfo, showAllMembers, allowAddMembers, requireApproval },
        message: messageContent,
      });
    }

    logger.info('Cập nhật cài đặt quản lý cộng đồng thành công', { groupId, settings });
    return {
      message: 'Cập nhật cài đặt quản lý cộng đồng thành công!',
      groupId,
      settings: { allowChangeGroupInfo, showAllMembers, allowAddMembers, requireApproval },
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
    return groupResult.Item;
  });

  const groups = await Promise.all(groupPromises);
  return groups.filter(group => group);
};

const getGroupMessages = async (groupId, userId, limit = 50, lastEvaluatedKey = null) => {
  if (!groupId || !isValidUUID(groupId) || !userId || !isValidUUID(userId)) {
    throw new AppError('groupId hoặc userId không hợp lệ!', 400);
  }
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

  const groupResult = await dynamoDB.get({ TableName: 'Groups', Key: { groupId } }).promise();
  if (!groupResult.Item) {
    throw new AppError('Nhóm không tồn tại!', 404);
  }
  if (!groupResult.Item.members?.includes(userId)) {
    throw new AppError('Bạn không phải thành viên nhóm!', 403);
  }

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
  return {
    messages: messages.Items || [],
    lastEvaluatedKey: messages.LastEvaluatedKey || null,
  };
};

const deleteGroupMessages = async (groupId) => {
  let lastEvaluatedKey = null;
  do {
    const messages = await dynamoDB.query({
      TableName: 'GroupMessages',
      IndexName: 'GroupMessagesIndex',
      KeyConditionExpression: 'groupId = :groupId',
      ExpressionAttributeValues: { ':groupId': groupId },
      ExclusiveStartKey: lastEvaluatedKey,
    }).promise();

    for (const message of messages.Items || []) {
      await dynamoDB.delete({ TableName: 'GroupMessages', Key: { groupId, timestamp: message.timestamp } }).promise();
      if (message.mediaUrl) {
        const key = message.mediaUrl.split('/').slice(3).join('/');
        await s3.deleteObject({ Bucket: bucketName, Key: key }).promise().catch(err => {
          logger.error('Lỗi khi xóa object S3:', { key, error: err.message });
        });
      }
    }
    lastEvaluatedKey = messages.LastEvaluatedKey;
  } while (lastEvaluatedKey);
};

module.exports = {
  createGroup,
  updateGroupInfo,
  joinGroup,
  addMemberToGroup,
  approveJoinRequest,
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