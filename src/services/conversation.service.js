const { dynamoDB } = require('../config/aws.config');
const { io } = require('../socket');
const { redisClient } = require('../config/redis');
const bcrypt = require('bcrypt');

// Hàm hỗ trợ kiểm tra hội thoại tồn tại
const checkConversationExists = async (userId, targetUserId) => {
  const result = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId },
  }).promise();

  if (!result.Item) {
    throw new Error('Không tìm thấy hội thoại giữa hai người dùng!');
  }
  return result.Item;
};


// Hàm ẩn hội thoại
const hideConversation = async (userId, hiddenUserId, password) => {
  console.log('Ẩn hội thoại:', { userId, hiddenUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === hiddenUserId) {
    throw new Error('Không thể ẩn hội thoại với chính mình!');
  }
  if (!password || password.length < 6) {
    throw new Error('Mật khẩu phải có ít nhất 6 ký tự!');
  }

  // 2. Kiểm tra hội thoại tồn tại
  await checkConversationExists(userId, hiddenUserId);

  // 3. Kiểm tra trạng thái ẩn
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: hiddenUserId },
  }).promise();

  if (conversation.Item?.settings?.isHidden) {
    throw new Error('Hội thoại đã được ẩn. Vui lòng bỏ ẩn trước!');
  }

  // 4. Băm mật khẩu
  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 10);
  } catch (err) {
    console.error('Lỗi băm mật khẩu:', err);
    throw new Error('Không thể xử lý mật khẩu!');
  }

  // 5. Cập nhật Conversations
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
    console.error('Lỗi cập nhật trạng thái ẩn:', err);
    throw err;
  }

  // 6. Lưu vào Redis (tùy chọn)
  try {
    await redisClient.set(
      `hidden:${userId}:${hiddenUserId}`,
      JSON.stringify({ hiddenUserId, hashedPassword }),
      'EX',
      24 * 60 * 60 // Cache 24h
    );
  } catch (err) {
    console.error('Lỗi lưu vào Redis:', err);
    // Không rollback vì DynamoDB đã cập nhật
  }

  // 7. Phát sự kiện
  io().to(userId).emit('conversationHidden', { hiddenUserId });

  return { success: true, message: 'Đã ẩn cuộc trò chuyện!' };
};

// Hàm bỏ ẩn hội thoại
const unhideConversation = async (userId, hiddenUserId, password) => {
  console.log('Bỏ ẩn hội thoại:', { userId, hiddenUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === hiddenUserId) {
    throw new Error('Không thể bỏ ẩn hội thoại với chính mình!');
  }

  // 2. Kiểm tra hội thoại và trạng thái ẩn
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: hiddenUserId },
  }).promise();

  if (!conversation.Item) {
    throw new Error('Không tìm thấy hội thoại!');
  }
  if (!conversation.Item.settings?.isHidden) {
    throw new Error('Cuộc trò chuyện không được ẩn!');
  }

  // 3. Kiểm tra mật khẩu
  try {
    const isMatch = await bcrypt.compare(password, conversation.Item.settings.passwordHash);
    if (!isMatch) {
      throw new Error('Mật khẩu không đúng!');
    }
  } catch (err) {
    console.error('Lỗi so sánh mật khẩu:', err);
    throw err;
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
    console.error('Lỗi xóa trạng thái ẩn:', err);
    throw err;
  }

  // 5. Xóa khỏi Redis
  try {
    await redisClient.del(`hidden:${userId}:${hiddenUserId}`);
  } catch (err) {
    console.error('Lỗi xóa Redis:', err);
    // Không nghiêm trọng, tiếp tục
  }

  // 6. Phát sự kiện
  io().to(userId).emit('conversationUnhidden', { hiddenUserId });

  return { success: true, message: 'Đã mở ẩn cuộc trò chuyện!' };
};

// Hàm lấy hội thoại ẩn
const getHiddenConversations = async (userId) => {
  console.log('Lấy danh sách hội thoại ẩn:', { userId });

  try {
    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'settings.isHidden = :true',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':true': true,
      },
    }).promise();

    const hiddenConversations = (result.Items || []).map(item => ({
      hiddenUserId: item.targetUserId,
      timestamp: item.updatedAt,
    }));

    // Đồng bộ Redis
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
    console.error('Lỗi lấy hội thoại ẩn:', err);
    throw err;
  }
};

// Hàm kiểm tra trạng thái mute
const checkMuteStatus = async (userId, mutedUserId) => {
  console.log('Kiểm tra trạng thái mute:', { userId, mutedUserId });

  try {
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
    const muteUntilDate = new Date(muteUntil);
    if (muteUntilDate <= now) {
      // Xóa trạng thái mute
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

    return { isMuted: true, muteUntil };
  } catch (err) {
    console.error('Lỗi kiểm tra mute:', err);
    throw err;
  }
};

// Hàm lấy hội thoại mute
const getMutedConversations = async (userId) => {
  console.log('Lấy danh sách hội thoại mute:', { userId });

  try {
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
      if (!item.settings.muteUntil || new Date(item.settings.muteUntil) > now) {
        validMutes.push({
          mutedUserId: item.targetUserId,
          muteUntil: item.settings.muteUntil,
        });
      } else {
        expiredMutes.push({ userId, targetUserId: item.targetUserId });
      }
    }

    // Xóa các trạng thái mute hết hạn
    for (const expired of expiredMutes) {
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: expired,
        UpdateExpression: 'REMOVE settings.muteUntil SET updatedAt = :time',
        ExpressionAttributeValues: {
          ':time': new Date().toISOString(),
        },
      }).promise();
    }

    return { success: true, mutedConversations: validMutes };
  } catch (err) {
    console.error('Lỗi lấy hội thoại mute:', err);
    throw err;
  }
};

// Hàm mute hội thoại
const muteConversation = async (userId, mutedUserId, duration) => {
  console.log('Cập nhật trạng thái mute:', { userId, mutedUserId, duration });

  // 1. Kiểm tra hợp lệ
  if (userId === mutedUserId) {
    throw new Error('Không thể mute chính mình!');
  }
  const validDurations = ['off', '1h', '3h', '8h', 'on'];
  if (!validDurations.includes(duration)) {
    throw new Error('Tùy chọn mute không hợp lệ! Chọn: off, 1h, 3h, 8h, on');
  }

  // 2. Kiểm tra hội thoại tồn tại
  await checkConversationExists(userId, mutedUserId);

  // 3. Xử lý unmute
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
      io().to(userId).emit('conversationUnmuted', { mutedUserId });
      return { success: true, message: 'Đã bật thông báo!' };
    } catch (err) {
      if (err.code === 'ConditionalCheckFailedException') {
        return { success: true, message: 'Hội thoại chưa được mute!' };
      }
      console.error('Lỗi bỏ mute:', err);
      throw err;
    }
  }

  // 4. Kiểm tra trạng thái mute hiện tại
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: mutedUserId },
  }).promise();

  if (conversation.Item?.settings?.muteUntil && duration !== 'on') {
    throw new Error('Hội thoại đã được mute. Vui lòng bỏ mute trước!');
  }

  // 5. Tính muteUntil
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

  // 6. Cập nhật Conversations
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
    console.error('Lỗi cập nhật mute:', err);
    throw err;
  }

  // 7. Phát sự kiện
  io().to(userId).emit('conversationMuted', { mutedUserId, muteUntil });

  return { success: true, message: 'Đã chặn thông báo!', muteUntil };
};

// Hàm ghim hội thoại
const pinConversation = async (userId, pinnedUserId) => {
  console.log('Ghim hội thoại:', { userId, pinnedUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === pinnedUserId) {
    throw new Error('Không thể ghim hội thoại với chính mình!');
  }

  // 2. Kiểm tra hội thoại tồn tại
  await checkConversationExists(userId, pinnedUserId);

  // 3. Kiểm tra trạng thái ghim
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: pinnedUserId },
  }).promise();

  if (conversation.Item?.settings?.isPinned) {
    throw new Error('Hội thoại đã được ghim!');
  }

  // 4. Kiểm tra giới hạn ghim
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
      throw new Error('Bạn chỉ có thể ghim tối đa 5 hội thoại!');
    }
  } catch (err) {
    console.error('Lỗi kiểm tra số lượng ghim:', err);
    throw err;
  }

  // 5. Cập nhật Conversations
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
    console.error('Lỗi ghim hội thoại:', err);
    throw err;
  }

  // 6. Phát sự kiện
  io().to(userId).emit('conversationPinned', { pinnedUserId });

  return { success: true, message: 'Đã ghim hội thoại!' };
};

// Hàm bỏ ghim hội thoại
const unpinConversation = async (userId, pinnedUserId) => {
  console.log('Bỏ ghim hội thoại:', { userId, pinnedUserId });

  // 1. Kiểm tra hợp lệ
  if (userId === pinnedUserId) {
    throw new Error('Không thể bỏ ghim hội thoại với chính mình!');
  }

  // 2. Kiểm tra trạng thái ghim
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: pinnedUserId },
  }).promise();

  if (!conversation.Item?.settings?.isPinned) {
    throw new Error('Hội thoại chưa được ghim!');
  }

  // 3. Cập nhật Conversations
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
    console.error('Lỗi bỏ ghim:', err);
    throw err;
  }

  // 4. Phát sự kiện
  io().to(userId).emit('conversationUnpinned', { pinnedUserId });

  return { success: true, message: 'Đã bỏ ghim hội thoại!' };
};

// Hàm lấy hội thoại ghim
const getPinnedConversations = async (userId) => {
  console.log('Lấy danh sách hội thoại ghim:', { userId });

  try {
    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'settings.isPinned = :true',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':true': true,
      },
    }).promise();

    const pinnedConversations = (result.Items || []).map(item => ({
      pinnedUserId: item.targetUserId,
      timestamp: item.updatedAt,
    }));

    return { success: true, pinnedConversations };
  } catch (err) {
    console.error('Lỗi lấy hội thoại ghim:', err);
    return {
      success: false,
      pinnedConversations: [],
      error: err.message || 'Lỗi khi lấy danh sách hội thoại ghim',
    };
  }
};

const  createConversation = async (userId, targetUserId) => {
    if (!userId || !targetUserId) {
      logger.error('Invalid userId or targetUserId', { userId, targetUserId });
      throw new AppError('userId hoặc targetUserId không hợp lệ!', 400);
    }
    if (userId === targetUserId) {
      logger.error('Cannot create conversation with self', { userId });
      throw new AppError('Không thể tạo hội thoại với chính mình!', 400);
    }

    logger.info('Creating conversation', { userId, targetUserId });

    const now = new Date().toISOString();
    const conversationId = uuidv4(); // ID chung cho cả hai bản ghi hội thoại

    // Tạo bản ghi hội thoại cho userId
    const userConversation = {
      userId,
      targetUserId,
      conversationId,
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      settings: {
        autoDelete: 'never', // Mặc định không tự động xóa
        pinnedMessages: [], // Danh sách tin nhắn ghim
        mute: false, // Tắt thông báo
        block: false, // Chặn người dùng
      },
    };

    // Tạo bản ghi hội thoại cho targetUserId
    const targetConversation = {
      userId: targetUserId,
      targetUserId: userId,
      conversationId,
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      settings: {
        autoDelete: 'never',
        pinnedMessages: [],
        mute: false,
        block: false,
      },
    };

    try {
      // Lưu cả hai bản ghi hội thoại vào DynamoDB
      await Promise.all([
        dynamoDB.put({
          TableName: 'Conversations',
          Item: userConversation,
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(targetUserId)',
        }).promise(),
        dynamoDB.put({
          TableName: 'Conversations',
          Item: targetConversation,
          ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(targetUserId)',
        }).promise(),
      ]);

      logger.info('Conversation created successfully', { conversationId, userId, targetUserId });
      return { success: true, conversationId };
    } catch (error) {
      if (error.code === 'ConditionalCheckFailedException') {
        logger.warn('Conversation already exists', { userId, targetUserId });
        return { success: true, conversationId: null }; // Hội thoại đã tồn tại, không phải lỗi
      }
      logger.error('Failed to create conversation', { userId, targetUserId, error: error.message });
      throw new AppError(`Không thể tạo hội thoại: ${error.message}`, 500);
    }
}

// Hàm lấy cài đặt tự động xóa
const getAutoDeleteSetting = async (userId, targetUserId) => {
  console.log('Lấy cài đặt tự động xóa:', { userId, targetUserId });

  try {
    const result = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId },
    }).promise();

    return result.Item?.settings?.autoDeleteAfter || 'never';
  } catch (err) {
    console.error('Lỗi lấy cài đặt tự động xóa:', err);
    throw err;
  }
};

// Hàm đặt cài đặt tự động xóa
const setAutoDeleteSetting = async (userId, targetUserId, autoDeleteAfter) => {
  console.log('Đặt cài đặt tự động xóa:', { userId, targetUserId, autoDeleteAfter });

  // 1. Kiểm tra hợp lệ
  const validOptions = ['10s', '60s', '1d', '3d', '7d', 'never'];
  if (!validOptions.includes(autoDeleteAfter)) {
    throw new Error('Giá trị autoDeleteAfter không hợp lệ! Chọn: 10s, 60s, 1d, 3d, 7d, never');
  }

  // 2. Kiểm tra hội thoại tồn tại
  await checkConversationExists(userId, targetUserId);

  // 3. Cập nhật Conversations
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
    console.error('Lỗi đặt cài đặt tự động xóa:', err);
    throw err;
  }

  // 4. Phát sự kiện
  io().to(userId).emit('autoDeleteSettingUpdated', { targetUserId, autoDeleteAfter });

  return { success: true, message: `Cài đặt tự động xóa đã được đặt thành ${autoDeleteAfter}` };
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
};