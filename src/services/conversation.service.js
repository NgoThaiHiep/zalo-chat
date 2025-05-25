const { dynamoDB } = require('../config/aws.config');
const { io } = require('../socket');
const { redisClient } = require('../config/redis');
const bcrypt = require('bcrypt');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');
const { AppError } = require('../utils/errorHandler');
const {MESSAGE_STATUSES} = require('../config/constants');
const FriendService = require('../services/friend.service');
const { getUserGroups } = require('../services/group.service');
const groupMessage = require('../services/group.service')
 // Hàm hỗ trợ kiểm tra hội thoại tồn tại
const checkConversationExists = async (userId, targetUserId) => {
  const result = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId },
  }).promise();

  if (!result.Item) {
    throw new AppError('Không tìm thấy hội thoại giữa hai người dùng!', 404);
  }
  return result.Item;
};

// Hàm ẩn hội thoại
const hideConversation = async (userId, hiddenUserId, password) => {
  logger.info('Ẩn hội thoại:', { userId, hiddenUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === hiddenUserId) {
    throw new AppError('Không thể ẩn hội thoại với chính mình!', 400);
  }
  if (!password || password.length < 6) {
    throw new AppError('Mật khẩu phải có ít nhất 6 ký tự!', 400);
  }

  // 2. Kiểm tra trạng thái bạn bè nếu người nhận bật restrictStrangerMessages
  const userResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: hiddenUserId },
  }).promise();
  if (!userResult.Item) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  if (userResult.Item.restrictStrangerMessages) {
    const friendResult = await dynamoDB.get({
      TableName: 'Friends',
      Key: { userId: hiddenUserId, friendId: userId },
    }).promise();
    if (!friendResult.Item) {
      throw new AppError('Không thể ẩn hội thoại với người lạ khi restrictStrangerMessages được bật!', 403);
    }
  }

  // 3. Kiểm tra hội thoại tồn tại
  await checkConversationExists(userId, hiddenUserId);

  // 4. Kiểm tra trạng thái ẩn
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: hiddenUserId },
  }).promise();

  if (conversation.Item?.settings?.isHidden) {
    throw new AppError('Hội thoại đã được ẩn. Vui lòng bỏ ẩn trước!', 400);
  }

  // 5. Băm mật khẩu
  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 10);
  } catch (err) {
    logger.error('Lỗi băm mật khẩu:', err);
    throw new AppError('Không thể xử lý mật khẩu!', 500);
  }

  // 6. Cập nhật Conversations
  const timestamp = new Date().toISOString();
  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId: hiddenUserId },
      UpdateExpression: 'SET settings.isHidden = :true, settings.passwordHash = :hash, updatedAt = :time',
      ExpressionAttributeValues: {
        ':true': true,
        ':hash': hashedPassword,
        ':time': timestamp,
      },
      ConditionExpression: 'attribute_exists(userId)',
    }).promise();
  } catch (err) {
    logger.error('Lỗi cập nhật trạng thái ẩn:', err);
    throw new AppError('Không thể ẩn hội thoại!', 500);
  }

  // 7. Lưu vào Redis
  try {
    await redisClient.set(
      `hidden:${userId}:${hiddenUserId}`,
      JSON.stringify({ hiddenUserId, hashedPassword }),
      'EX',
      24 * 60 * 60
    );
  } catch (err) {
    logger.error('Lỗi lưu vào Redis:', err);
  }
  return { success: true, message: 'Đã ẩn cuộc trò chuyện!' };
};

// Hàm bỏ ẩn hội thoại
const unhideConversation = async (userId, hiddenUserId, password) => {
  logger.info('Bỏ ẩn hội thoại:', { userId, hiddenUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === hiddenUserId) {
    throw new AppError('Không thể bỏ ẩn hội thoại với chính mình!', 400);
  }

  // 2. Kiểm tra hội thoại và trạng thái ẩn
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: hiddenUserId },
  }).promise();

  if (!conversation.Item) {
    throw new AppError('Không tìm thấy hội thoại!', 404);
  }
  if (!conversation.Item.settings?.isHidden) {
    throw new AppError('Cuộc trò chuyện không được ẩn!', 400);
  }

  // 3. Kiểm tra mật khẩu
  try {
    const isMatch = await bcrypt.compare(password, conversation.Item.settings.passwordHash);
    if (!isMatch) {
      throw new AppError('Mật khẩu không đúng!', 401);
    }
  } catch (err) {
    logger.error('Lỗi so sánh mật khẩu:', err);
    throw new AppError('Không thể xác minh mật khẩu!', 500);
  }

  // 4. Cập nhật Conversations
  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId: hiddenUserId },
      UpdateExpression: 'REMOVE settings.isHidden, settings.passwordHash SET updatedAt = :time',
      ExpressionAttributeValues: {
        ':time': new Date().toISOString(),
      },
    }).promise();
  } catch (err) {
    logger.error('Lỗi xóa trạng thái ẩn:', err);
    throw new AppError('Không thể bỏ ẩn hội thoại!', 500);
  }

  // 5. Xóa khỏi Redis
  try {
    await redisClient.del(`hidden:${userId}:${hiddenUserId}`);
  } catch (err) {
    logger.error('Lỗi xóa Redis:', err);
  }

  // 6. Phát sự kiện


  return { success: true, message: 'Đã mở ẩn cuộc trò chuyện!' };
};

// Hàm lấy hội thoại ẩn
const getHiddenConversations = async (userId) => {
  logger.info('Lấy danh sách hội thoại ẩn:', { userId });

  const cacheKey = `hidden_conversations:${userId}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return { success: true, hiddenConversations: JSON.parse(cached) };
    }

    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'settings.isHidden = :true',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':true': true,
      },
    }).promise();

    const hiddenConversations = [];
    for (const item of result.Items || []) {
      const targetUserId = item.targetUserId;
      const isFriend = await dynamoDB.get({
        TableName: 'Friends',
        Key: { userId, friendId: targetUserId },
      }).promise().then(res => !!res.Item);

      if (!isFriend) {
        const messages = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :userId AND senderId = :targetUserId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':targetUserId': targetUserId,
          },
          Limit: 1,
        }).promise();
        const hasNonRestricted = messages.Items?.some(msg => msg.status !== 'restricted');
        if (!hasNonRestricted) continue;
      }

      hiddenConversations.push({
        hiddenUserId: targetUserId,
        timestamp: item.updatedAt,
      });
    }

    await redisClient.set(cacheKey, JSON.stringify(hiddenConversations), 'EX', 24 * 60 * 60);

    for (const item of result.Items) {
      const redisKey = `hidden:${userId}:${item.targetUserId}`;
      const redisData = await redisClient.get(redisKey);
      if (!redisData) {
        await redisClient.set(
          redisKey,
          JSON.stringify({ hiddenUserId: item.targetUserId, hashedPassword: item.settings.passwordHash }),
          'EX',
          24 * 60 * 60
        );
      }
    }

    return { success: true, hiddenConversations };
  } catch (err) {
    logger.error('Lỗi lấy hội thoại ẩn:', err);
    throw new AppError('Không thể lấy danh sách hội thoại ẩn!', 500);
  }
};

// Hàm kiểm tra trạng thái mute
const checkMuteStatus = async (userId, mutedUserId) => {
  logger.info('Kiểm tra trạng thái mute:', { userId, mutedUserId });

  try {
    const cacheKey = `mute:${userId}:${mutedUserId}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const { muteUntil } = JSON.parse(cached);
      const now = new Date();
      if (muteUntil === 'permanent' || new Date(muteUntil) > now) {
        return { isMuted: true, muteUntil };
      }
      await redisClient.del(cacheKey);
      return { isMuted: false };
    }

    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId: mutedUserId },
    }).promise();

    if (!conversation.Item) {
      return { isMuted: false };
    }

    const { muteUntil } = conversation.Item.settings || {};
    if (!muteUntil) {
      return { isMuted: false };
    }

    const now = new Date();
    const muteUntilDate = muteUntil === 'permanent' ? new Date(9999, 0, 1) : new Date(muteUntil);
    if (muteUntilDate <= now) {
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: mutedUserId },
        UpdateExpression: 'REMOVE settings.muteUntil SET updatedAt = :time',
        ExpressionAttributeValues: {
          ':time': new Date().toISOString(),
        },
      }).promise();
      return { isMuted: false };
    }

    await redisClient.set(cacheKey, JSON.stringify({ mutedUserId, muteUntil }), 'EX', 8 * 60 * 60);
    return { isMuted: true, muteUntil };
  } catch (err) {
    logger.error('Lỗi kiểm tra mute:', err);
    throw new AppError('Không thể kiểm tra trạng thái mute!', 500);
  }
};

// Hàm lấy hội thoại mute
const getMutedConversations = async (userId) => {
  logger.info('Lấy danh sách hội thoại mute:', { userId });

  const cacheKey = `muted_conversations:${userId}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return { success: true, mutedConversations: JSON.parse(cached) };
    }

    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'attribute_exists(settings.muteUntil)',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();

    const now = new Date();
    const validMutes = [];
    const expiredMutes = [];

    for (const item of result.Items || []) {
      const muteUntil = item.settings.muteUntil;
      if (!muteUntil) continue;

      const isFriend = await dynamoDB.get({
        TableName: 'Friends',
        Key: { userId, friendId: item.targetUserId },
      }).promise().then(res => !!res.Item);

      if (!isFriend) {
        const messages = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :userId AND senderId = :targetUserId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':targetUserId': item.targetUserId,
          },
          Limit: 1,
        }).promise();
        const hasNonRestricted = messages.Items?.some(msg => msg.status !== 'restricted');
        if (!hasNonRestricted) continue;
      }

      if (muteUntil === 'permanent' || new Date(muteUntil) > now) {
        validMutes.push({
          mutedUserId: item.targetUserId,
          muteUntil,
        });
      } else {
        expiredMutes.push({ userId, targetUserId: item.targetUserId });
      }
    }

    for (const expired of expiredMutes) {
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: expired,
        UpdateExpression: 'REMOVE settings.muteUntil SET updatedAt = :time',
        ExpressionAttributeValues: {
          ':time': new Date().toISOString(),
        },
      }).promise();
      await redisClient.del(`mute:${userId}:${expired.targetUserId}`);
    }

    await redisClient.set(cacheKey, JSON.stringify(validMutes), 'EX', 24 * 60 * 60);
    return { success: true, mutedConversations: validMutes };
  } catch (err) {
    logger.error('Lỗi lấy hội thoại mute:', err);
    throw new AppError('Không thể lấy danh sách hội thoại mute!', 500);
  }
};

// Hàm mute hội thoại
const muteConversation = async (userId, mutedUserId, duration) => {
  logger.info('Cập nhật trạng thái mute:', { userId, mutedUserId, duration });

  if (userId === mutedUserId) {
    throw new AppError('Không thể mute chính mình!', 400);
  }
  const validDurations = ['off', '1h', '3h', '8h', 'on'];
  if (!validDurations.includes(duration)) {
    throw new AppError('Tùy chọn mute không hợp lệ! Chọn: off, 1h, 3h, 8h, on', 400);
  }

  await checkConversationExists(userId, mutedUserId);

  const userResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: mutedUserId },
  }).promise();
  if (!userResult.Item) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  if (userResult.Item.restrictStrangerMessages) {
    const friendResult = await dynamoDB.get({
      TableName: 'Friends',
      Key: { userId: mutedUserId, friendId: userId },
    }).promise();
    if (!friendResult.Item) {
      throw new AppError('Không thể mute hội thoại với người lạ khi restrictStrangerMessages được bật!', 403);
    }
  }

  if (duration === 'off') {
    try {
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: mutedUserId },
        UpdateExpression: 'REMOVE settings.muteUntil SET updatedAt = :time',
        ExpressionAttributeValues: {
          ':time': new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(settings.muteUntil)',
      }).promise();
      await redisClient.del(`mute:${userId}:${mutedUserId}`);
    
      return { success: true, message: 'Đã bật thông báo!' };
    } catch (err) {
      if (err.code === 'ConditionalCheckFailedException') {
        return { success: true, message: 'Hội thoại chưa được mute!' };
      }
      logger.error('Lỗi bỏ mute:', err);
      throw new AppError('Không thể bỏ mute hội thoại!', 500);
    }
  }

  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: mutedUserId },
  }).promise();

  if (conversation.Item?.settings?.muteUntil && duration !== 'on') {
    throw new AppError('Hội thoại đã được mute. Vui lòng bỏ mute trước!', 400);
  }

  let muteUntil;
  if (duration === 'on') {
    muteUntil = 'permanent';
  } else if (duration === '1h') {
    muteUntil = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
  } else if (duration === '3h') {
    muteUntil = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  } else if (duration === '8h') {
    muteUntil = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  }

  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId: mutedUserId },
      UpdateExpression: 'SET settings.muteUntil = :muteUntil, updatedAt = :time',
      ExpressionAttributeValues: {
        ':muteUntil': muteUntil,
        ':time': new Date().toISOString(),
      },
    }).promise();
  } catch (err) {
    logger.error('Lỗi cập nhật mute:', err);
    throw new AppError('Không thể mute hội thoại!', 500);
  }

  try {
    await redisClient.set(
      `mute:${userId}:${mutedUserId}`,
      JSON.stringify({ mutedUserId, muteUntil }),
      'EX',
      duration === 'on' ? 30 * 24 * 60 * 60 : 8 * 60 * 60
    );
  } catch (err) {
    logger.error('Lỗi lưu vào Redis:', err);
  }

 

  return { success: true, message: 'Đã chặn thông báo!', muteUntil };
};

// Hàm ghim hội thoại
const pinConversation = async (userId, pinnedUserId) => {
  logger.info('Ghim hội thoại:', { userId, pinnedUserId });

  if (userId === pinnedUserId) {
    throw new AppError('Không thể ghim hội thoại với chính mình!', 400);
  }

  await checkConversationExists(userId, pinnedUserId);

  const userResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: pinnedUserId },
  }).promise();
  if (!userResult.Item) {
    throw new AppError('Người dùng không tồn tại!', 404);
  }
  if (userResult.Item.restrictStrangerMessages) {
    const friendResult = await dynamoDB.get({
      TableName: 'Friends',
      Key: { userId: pinnedUserId, friendId: userId },
    }).promise();
    if (!friendResult.Item) {
      throw new AppError('Không thể ghim hội thoại với người lạ khi restrictStrangerMessages được bật!', 403);
    }
  }

  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: pinnedUserId },
  }).promise();

  if (conversation.Item?.settings?.isPinned) {
    throw new AppError('Hội thoại đã được ghim!', 400);
  }

  try {
    const pinnedResult = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'settings.isPinned = :true',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':true': true,
      },
    }).promise();

    if (pinnedResult.Items?.length >= 5) {
      throw new AppError('Bạn chỉ có thể ghim tối đa 5 hội thoại!', 400);
    }
  } catch (err) {
    logger.error('Lỗi kiểm tra số lượng ghim:', err);
    throw new AppError('Không thể kiểm tra số lượng hội thoại ghim!', 500);
  }

  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId: pinnedUserId },
      UpdateExpression: 'SET settings.isPinned = :true, updatedAt = :time',
      ExpressionAttributeValues: {
        ':true': true,
        ':time': new Date().toISOString(),
      },
    }).promise();
  } catch (err) {
    logger.error('Lỗi ghim hội thoại:', err);
    throw new AppError('Không thể ghim hội thoại!', 500);
  }



  return { success: true, message: 'Đã ghim hội thoại!' };
};

// Hàm bỏ ghim hội thoại
const unpinConversation = async (userId, pinnedUserId) => {
  logger.info('Bỏ ghim hội thoại:', { userId, pinnedUserId });

  if (userId === pinnedUserId) {
    throw new AppError('Không thể bỏ ghim hội thoại với chính mình!', 400);
  }

  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: pinnedUserId },
  }).promise();

  if (!conversation.Item?.settings?.isPinned) {
    throw new AppError('Hội thoại chưa được ghim!', 400);
  }

  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId: pinnedUserId },
      UpdateExpression: 'REMOVE settings.isPinned SET updatedAt = :time',
      ExpressionAttributeValues: {
        ':time': new Date().toISOString(),
      },
    }).promise();
  } catch (err) {
    logger.error('Lỗi bỏ ghim:', err);
    throw new AppError('Không thể bỏ ghim hội thoại!', 500);
  }



  return { success: true, message: 'Đã bỏ ghim hội thoại!' };
};

// Hàm lấy hội thoại ghim
const getPinnedConversations = async (userId) => {
  logger.info('Lấy danh sách hội thoại ghim:', { userId });

  const cacheKey = `pinned_conversations:${userId}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return { success: true, pinnedConversations: JSON.parse(cached) };
    }

    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'settings.isPinned = :true',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':true': true,
      },
    }).promise();

    const pinnedConversations = [];
    for (const item of result.Items || []) {
      const targetUserId = item.targetUserId;
      const isFriend = await dynamoDB.get({
        TableName: 'Friends',
        Key: { userId, friendId: targetUserId },
      }).promise().then(res => !!res.Item);

      if (!isFriend) {
        const messages = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :userId AND senderId = :targetUserId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':targetUserId': targetUserId,
          },
          Limit: 1,
        }).promise();
        const hasNonRestricted = messages.Items?.some(msg => msg.status !== 'restricted');
        if (!hasNonRestricted) continue;
      }

      pinnedConversations.push({
        pinnedUserId: targetUserId,
        timestamp: item.updatedAt,
      });
    }

    await redisClient.set(cacheKey, JSON.stringify(pinnedConversations), 'EX', 24 * 60 * 60);
    return { success: true, pinnedConversations };
  } catch (err) {
    logger.error('Lỗi lấy hội thoại ghim:', err);
    throw new AppError('Không thể lấy danh sách hội thoại ghim!', 500);
  }
};

// Hàm tạo hội thoại
const createConversation = async (userId, targetUserId) => {
  logger.info('Bắt đầu tạo hội thoại', { userId, targetUserId });

  // Kiểm tra đầu vào
  if (!userId || !targetUserId) {
    logger.error('Thiếu userId hoặc targetUserId', { userId, targetUserId });
    throw new AppError('userId hoặc targetUserId không hợp lệ', 400);
  }

  const now = new Date().toISOString();
  const conversationId = uuidv4();

  // Kiểm tra targetUserId có phải là groupId
  const isGroup = await dynamoDB.get({
    TableName: 'Groups',
    Key: { groupId: targetUserId },
  }).promise().then(res => !!res.Item);

  let userRestrict = false;
  if (!isGroup) {
    const userSettings = await dynamoDB.get({
      TableName: 'Users',
      Key: { userId },
    }).promise();
    if (!userSettings.Item) {
      logger.error('Người dùng không tồn tại', { userId });
      throw new AppError('Người dùng không tồn tại', 404);
    }
    userRestrict = userSettings.Item.restrictStrangerMessages || false;
  }

  const createConversationRecord = (user, target, restrict) => ({
    userId: user,
    targetUserId: target,
    conversationId,
    createdAt: now,
    updatedAt: now,
    lastMessage: null,
    settings: {
      autoDelete: 'never',
      pinnedMessages: [],
      mute: false,
      block: false,
      restrictStrangers: restrict,
      isGroup: !!isGroup,
    },
  });

  try {
    const conversation = createConversationRecord(userId, targetUserId, userRestrict);
    await dynamoDB.put({
      TableName: 'Conversations',
      Item: conversation,
      ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(targetUserId)',
    }).promise();
    logger.info('Tạo hội thoại thành công', { conversationId, userId, targetUserId });
    return { success: true, conversationId };
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      logger.warn('Hội thoại đã tồn tại', { userId, targetUserId });
      return { success: true, conversationId: null };
    }
    logger.error('Lỗi khi tạo hội thoại', { userId, targetUserId, error: error.message });
    throw new AppError(`Không thể tạo hội thoại: ${error.message}`, 500);
  }
};


// Hàm lấy cài đặt tự động xóa
const getAutoDeleteSetting = async (userId, targetUserId) => {
  logger.info('Lấy cài đặt tự động xóa:', { userId, targetUserId });

  try {
    const result = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId },
    }).promise();

    return result.Item?.settings?.autoDeleteAfter || 'never';
  } catch (err) {
    logger.error('Lỗi lấy cài đặt tự động xóa:', err);
    throw new AppError('Không thể lấy cài đặt tự động xóa!', 500);
  }
};

const getDisplayInfo = async (userId, targetUserId) => {
  if (userId === targetUserId) {
    const userResult = await dynamoDB.get({
      TableName: 'Users',
      Key: { userId },
    }).promise();

    return {
      displayName: 'FileCloud',
      phoneNumber: userResult.Item?.phoneNumber || null,
      avatar: userResult.Item?.avatar || null,
    };
  }

  try {
    const userNameResult = await FriendService.getUserName(userId, targetUserId);
    return {
      displayName: userNameResult.name,
      phoneNumber: userNameResult.phoneNumber,
      avatar: userNameResult.avatar || null,
    };
  } catch (error) {
    logger.error(`Lỗi lấy thông tin cho ${targetUserId}:`, error);
    return {
      displayName: targetUserId,
      phoneNumber: null,
      avatar: null,
    };
  }
};

const getConversation = async (userId, targetUserId) => {
  if (!userId || !targetUserId) {
    logger.error('Invalid userId or targetUserId', { userId, targetUserId });
    throw new AppError('userId hoặc targetUserId không hợp lệ!', 400);
  }

  logger.info('Fetching conversation', { userId, targetUserId });

  try {
    const conversationResult = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId },
    }).promise();

    if (!conversationResult.Item) {
      logger.warn('Conversation not found', { userId, targetUserId });
      throw new AppError('Hội thoại không tồn tại', 404);
    }

    const conversation = conversationResult.Item;

    // Lấy thông tin người dùng targetUserId (displayName, phoneNumber, v.v.)
    let displayName = targetUserId;
    let phoneNumber = null;
    if (userId !== targetUserId) {
      try {
        const userNameResult = await FriendService.getUserName(userId, targetUserId);
        displayName = userNameResult.name;
        phoneNumber = userNameResult.phoneNumber;
      } catch (error) {
        logger.error(`Error fetching user info for ${targetUserId}:`, { error: error.message });
        // Nếu không lấy được thông tin, giữ nguyên displayName là targetUserId
      }
    } else {
      const userResult = await dynamoDB.get({
        TableName: 'Users',
        Key: { userId },
      }).promise();
      displayName = 'FileCloud';
      phoneNumber = userResult.Item?.phoneNumber || null;
    }

    return {
      success: true,
      conversation: {
        conversationId: conversation.conversationId,
        userId: conversation.userId,
        targetUserId: conversation.targetUserId,
        displayName,
        phoneNumber,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastMessage: conversation.lastMessage,
        settings: conversation.settings,
      },
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Failed to fetch conversation', { userId, targetUserId, error: error.message });
    throw new AppError(`Không thể lấy hội thoại: ${error.message}`, 500);
  }
};

// Hàm đặt cài đặt tự động xóa
const setAutoDeleteSetting = async (userId, targetUserId, autoDeleteAfter) => {
  logger.info('Đặt cài đặt tự động xóa:', { userId, targetUserId, autoDeleteAfter });

  const validOptions = ['10s', '60s', '1d', '3d', '7d', 'never'];
  if (!validOptions.includes(autoDeleteAfter)) {
    throw new AppError('Giá trị autoDeleteAfter không hợp lệ! Chọn: 10s, 60s, 1d, 3d, 7d, never', 400);
  }

  await checkConversationExists(userId, targetUserId);

  try {
    await dynamoDB.update({
      TableName: 'Conversations',
      Key: { userId, targetUserId },
      UpdateExpression: 'SET settings.autoDeleteAfter = :value, updatedAt = :time',
      ExpressionAttributeValues: {
        ':value': autoDeleteAfter,
        ':time': new Date().toISOString(),
      },
    }).promise();
  } catch (err) {
    logger.error('Lỗi đặt cài đặt tự động xóa:', err);
    throw new AppError('Không thể đặt cài đặt tự động xóa!', 500);
  }

 

  return { success: true, message: `Cài đặt tự động xóa đã được đặt thành ${autoDeleteAfter}` };
};

const getConversationSummary = async (userId, options = {}) => {
  const { minimal = false } = options;

  try {
    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();

    const conversations = result.Items || [];
    if (!conversations.length && minimal) {
      const groups = await getUserGroups(userId);
      const groupSummaries = groups.map(group => ({
        groupId: group.groupId,
        name: group.name,
        avatar: group.avatar || null,
        memberCount: group.members.length,
        createdAt: group.createdAt,
        userRole: group.roles[userId],
      }));

      return {
        success: true,
        data: {
          conversationCount: 0,
          conversations: [],
          groups: groupSummaries,
        },
      };
    }

    const hiddenConversations = (await getHiddenConversations(userId)).hiddenConversations || [];
    const mutedConversations = (await getMutedConversations(userId)).mutedConversations || [];
    // Không cần gọi getPinnedConversations nữa, sẽ kiểm tra trực tiếp từ dữ liệu hội thoại

    const conversationList = [];
    const groupSummaries = [];

    const userIdsToFetch = new Set();
    const groupIdsToFetch = new Set();
    conversations.forEach(conv => {
      const targetUserId = conv.targetUserId;
      const isGroup = conv.settings?.isGroup || false;
      if (!hiddenConversations.some(hc => hc.hiddenUserId === targetUserId)) {
        if (isGroup) {
          groupIdsToFetch.add(targetUserId);
        } else {
          userIdsToFetch.add(targetUserId);
        }
      }
    });

    const usersData = await batchGetUsers(Array.from(userIdsToFetch));
    const userMap = new Map(usersData.map(user => [user.userId, user]));

    const groupsData = await batchGetGroups(Array.from(groupIdsToFetch));
    const groupMap = new Map(groupsData.map(group => [group.groupId, group]));

    for (const conv of conversations) {
      const targetUserId = conv.targetUserId;
      const isGroup = conv.settings?.isGroup || false;

      if (hiddenConversations.some(hc => hc.hiddenUserId === targetUserId)) {
        continue;
      }

      if (isGroup) {
        const group = groupMap.get(targetUserId);
        if (!group) {
          logger.warn('Nhóm không tồn tại trong Conversations', { userId, targetUserId });
          continue;
        }

        const lastMessage = minimal ? null : conv.lastMessage;

        if (minimal) {
          groupSummaries.push({
            groupId: group.groupId,
            name: group.name,
            avatar: group.avatar || null,
            memberCount: group.members.length,
            createdAt: group.createdAt,
            userRole: group.roles[userId],
          });
        } else {
          groupSummaries.push({
            groupId: group.groupId,
            name: group.name,
            avatar: group.avatar || null,
            memberCount: group.members.length,
            createdAt: group.createdAt,
            userRole: group.roles[userId],
            lastMessage: lastMessage
              ? {
                  messageId: lastMessage.messageId,
                  senderId: lastMessage.senderId,
                  type: lastMessage.type,
                  content: lastMessage.content,
                  timestamp: lastMessage.createdAt,
                  isRecalled: lastMessage.isRecalled || false,
                }
              : null,
          });
        }
      } else {
        let restrictStrangerMessages = false;
        let isFriend = true;
        if (userId !== targetUserId) {
          const targetUser = userMap.get(targetUserId);
          restrictStrangerMessages = targetUser?.settings?.restrictStrangerMessages || false;

          if (restrictStrangerMessages) {
            const friendResult = await dynamoDB.get({
              TableName: 'Friends',
              Key: { userId: targetUserId, friendId: userId },
            }).promise();
            isFriend = !!friendResult.Item;
          }
        }

        const lastMessage = minimal ? null : conv.lastMessage;

        if (
          userId === targetUserId ||
          isFriend ||
          !restrictStrangerMessages
        ) {
          let name, phoneNumber, avatar;
          const targetUser = userMap.get(targetUserId);
          if (targetUserId === userId) {
            name = 'FileCloud';
            phoneNumber = targetUser?.phoneNumber || null;
            avatar = targetUser?.avatar || null;
          } else {
            try {
              const userNameResult = await FriendService.getUserName(userId, targetUserId);
              name = userNameResult.name;
              phoneNumber = userNameResult.phoneNumber;
              avatar = userNameResult.avatar || targetUser?.avatar || null;
            } catch (error) {
              logger.error(`Lỗi lấy thông tin cho ${targetUserId}:`, error);
              name = targetUserId;
              phoneNumber = targetUser?.phoneNumber || null;
              avatar = targetUser?.avatar || null;
            }
          }

          const isMuted = mutedConversations.some(mc => mc.mutedUserId === targetUserId);
          const isPinned = conv.settings?.isPinned || false; // Kiểm tra trực tiếp từ dữ liệu hội thoại

          conversationList.push({
            otherUserId: targetUserId,
            displayName: name,
            phoneNumber,
            avatar,
            isSelf: targetUserId === userId,
            lastMessage: minimal
              ? null
              : lastMessage
              ? {
                  messageId: lastMessage.messageId,
                  senderId: lastMessage.senderId,
                  type: lastMessage.type,
                  content: lastMessage.content,
                  timestamp: lastMessage.createdAt,
                  isRecalled: lastMessage.isRecalled || false,
                }
              : null,
            isMuted,
            isPinned,
          });
        }
      }
    }

    if (!minimal) {
      conversationList.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        if (!a.lastMessage || !b.lastMessage) return 0;
        return new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp);
      });

      groupSummaries.sort((a, b) => {
        if (a.lastMessage && !b.lastMessage) return -1;
        if (!a.lastMessage && b.lastMessage) return 1;
        if (!a.lastMessage && !b.lastMessage) {
          return new Date(b.createdAt) - new Date(a.createdAt);
        }
        return new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp);
      });
    }

    return {
      success: true,
      data: {
        conversationCount: conversationList.length,
        conversations: conversationList,
        groups: groupSummaries,
      },
    };
  } catch (error) {
    logger.error('Error in getConversationSummary:', error);
    throw new AppError('Failed to fetch conversation summary', 500);
  }
};

// Hàm hỗ trợ batchGet cho Users
const batchGetUsers = async (userIds) => {
  if (!userIds.length) return [];
  const keys = userIds.map(userId => ({ userId }));
  const batchParams = {
    RequestItems: {
      Users: { Keys: keys },
    },
  };
  const result = await dynamoDB.batchGet(batchParams).promise();
  return result.Responses?.Users || [];
};

// Hàm hỗ trợ batchGet cho Groups
const batchGetGroups = async (groupIds) => {
  if (!groupIds.length) return [];
  const keys = groupIds.map(groupId => ({ groupId }));
  const batchParams = {
    RequestItems: {
      Groups: { Keys: keys },
    },
  };
  const result = await dynamoDB.batchGet(batchParams).promise();
  return result.Responses?.Groups || [];
};
module.exports = {
  hideConversation,
  unhideConversation,
  getHiddenConversations,
  muteConversation,
  checkMuteStatus,
  getMutedConversations,
  pinConversation,
  unpinConversation,
  getPinnedConversations,
  getAutoDeleteSetting,
  setAutoDeleteSetting,
  createConversation,
  checkConversationExists,
  getConversation,
  getConversationSummary,
};