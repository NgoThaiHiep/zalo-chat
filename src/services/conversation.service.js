const { dynamoDB, s3 } = require('../config/aws.config');
const { io, transcribeQueue } = require('../socket');
const { redisClient } = require('../config/redis');
const bcrypt = require('bcrypt');

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
    try {
      const result = await dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: {
          ':user1': userId,
          ':user2': hiddenUserId,
        },
        Limit: 1,
      }).promise();
  
      if (!result.Items || result.Items.length === 0) {
        const reverseResult = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
          ExpressionAttributeValues: {
            ':user1': userId,
            ':user2': hiddenUserId,
          },
          Limit: 1,
        }).promise();
  
        if (!reverseResult.Items || reverseResult.Items.length === 0) {
          throw new Error('Không tìm thấy hội thoại giữa hai người dùng!');
        }
      }
    } catch (err) {
      console.error('Lỗi kiểm tra hội thoại:', err);
      throw err;
    }
  
    // 3. Kiểm tra trạng thái ẩn hiện tại
    try {
      const existingHidden = await dynamoDB.get({
        TableName: 'HiddenConversations',
        Key: { userId, hiddenUserId },
      }).promise();
  
      if (existingHidden.Item) {
        throw new Error('Hội thoại đã được ẩn. Vui lòng bỏ ẩn trước!');
      }
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái ẩn:', err);
      throw err;
    }
  
    // 4. Băm mật khẩu
    let hashedPassword;
    try {
      hashedPassword = await bcrypt.hash(password, 10);
    } catch (err) {
      console.error('Lỗi băm mật khẩu:', err);
      throw new Error('Không thể xử lý mật khẩu!');
    }
  
    // 5. Lưu vào DynamoDB
    const timestamp = new Date().toISOString();
    try {
      await dynamoDB.put({
        TableName: 'HiddenConversations',
        Item: {
          userId,
          hiddenUserId,
          hashedPassword,
          timestamp,
        },
      }).promise();
    } catch (err) {
      console.error('Lỗi lưu trạng thái ẩn vào DynamoDB:', err);
      throw err;
    }
  
    // 6. Lưu vào Redis
    try {
      const hiddenData = JSON.stringify({ hiddenUserId, hashedPassword });
      await redisClient.set(`hidden:${userId}:${hiddenUserId}`, hiddenData);
    } catch (err) {
      console.error('Lỗi lưu trạng thái ẩn vào Redis:', err);
      // Rollback DynamoDB nếu Redis thất bại
      await dynamoDB.delete({
        TableName: 'HiddenConversations',
        Key: { userId, hiddenUserId },
      }).promise();
      throw err;
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
  
    // 2. Lấy dữ liệu từ DynamoDB
    let hiddenItem;
    try {
      const result = await dynamoDB.get({
        TableName: 'HiddenConversations',
        Key: { userId, hiddenUserId },
      }).promise();
      hiddenItem = result.Item;
    } catch (err) {
      console.error('Lỗi lấy trạng thái ẩn từ DynamoDB:', err);
      throw err;
    }
  
    if (!hiddenItem) {
      throw new Error('Cuộc trò chuyện không được ẩn!');
    }
  
    // 3. Kiểm tra mật khẩu
    try {
      const isMatch = await bcrypt.compare(password, hiddenItem.hashedPassword);
      if (!isMatch) {
        throw new Error('Mật khẩu không đúng!');
      }
    } catch (err) {
      console.error('Lỗi so sánh mật khẩu:', err);
      throw err;
    }
  
    // 4. Xóa khỏi DynamoDB
    try {
      await dynamoDB.delete({
        TableName: 'HiddenConversations',
        Key: { userId, hiddenUserId },
      }).promise();
    } catch (err) {
      console.error('Lỗi xóa trạng thái ẩn từ DynamoDB:', err);
      throw err;
    }
  
    // 5. Xóa khỏi Redis
    try {
      await redisClient.del(`hidden:${userId}:${hiddenUserId}`);
    } catch (err) {
      console.error('Lỗi xóa trạng thái ẩn từ Redis:', err);
      // Không rollback DynamoDB vì đã xóa thành công
      console.warn('Redis không đồng bộ, nhưng DynamoDB đã xóa');
    }
  
    // 6. Phát sự kiện
    io().to(userId).emit('conversationUnhidden', { hiddenUserId });
  
    return { success: true, message: 'Đã mở ẩn cuộc trò chuyện!' };
};

// Hàm lấy hội thoại ẩn
// const getHiddenConversations = async (userId, { limit = 50, offset = 0 } = {}) => {
const getHiddenConversations = async (userId) => {
    console.log('Lấy danh sách hội thoại ẩn:', { userId });
  
    try {
      const result = await dynamoDB.query({
        TableName: 'HiddenConversations',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise();
  
      const hiddenConversations = (result.Items || []).map(item => ({
        hiddenUserId: item.hiddenUserId,
        timestamp: item.timestamp,
      }));
  
      // Đồng bộ Redis
      for (const item of result.Items) {
        const redisKey = `hidden:${userId}:${item.hiddenUserId}`;
        const redisData = await redisClient.get(redisKey);
        if (!redisData) {
          await redisClient.set(redisKey, JSON.stringify({
            hiddenUserId: item.hiddenUserId,
            hashedPassword: item.hashedPassword,
          }));
        }
      }
  
      return { success: true, hiddenConversations };
    } catch (err) {
      console.error('Lỗi lấy danh sách hội thoại ẩn:', err);
      throw err;
    }
};

// Hàm mute hội thoại
const checkMuteStatus = async (userId, mutedUserId) => {
    console.log('Kiểm tra trạng thái mute:', { userId, mutedUserId });
  
    try {
      const result = await dynamoDB.get({
        TableName: 'MutedConversations',
        Key: { userId, mutedUserId },
      }).promise();
  
      if (!result.Item) {
        return { isMuted: false };
      }
  
      const { muteUntil } = result.Item;
      if (muteUntil === null) {
        return { isMuted: true, muteUntil: null };
      }
  
      const now = new Date();
      const muteUntilDate = new Date(muteUntil);
      if (muteUntilDate <= now) {
        // Xóa bản ghi hết hạn
        await dynamoDB.delete({
          TableName: 'MutedConversations',
          Key: { userId, mutedUserId },
        }).promise();
        return { isMuted: false };
      }
  
      return { isMuted: true, muteUntil };
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái mute:', err);
      throw err;
    }
};
  
const getMutedConversations = async (userId) => {
    console.log('Lấy danh sách hội thoại mute:', { userId });
  
    try {
      const result = await dynamoDB.query({
        TableName: 'MutedConversations',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise();
  
      const now = new Date();
      const validMutes = [];
      const expiredMutes = [];
  
      for (const item of result.Items || []) {
        if (item.muteUntil === null || new Date(item.muteUntil) > now) {
          validMutes.push(item);
        } else {
          expiredMutes.push({ userId, mutedUserId: item.mutedUserId });
        }
      }
  
      // Xóa các bản ghi hết hạn
      for (const expired of expiredMutes) {
        await dynamoDB.delete({
          TableName: 'MutedConversations',
          Key: expired,
        }).promise();
      }
  
      return { success: true, mutedConversations: validMutes };
    } catch (err) {
      console.error('Lỗi lấy danh sách mute:', err);
      throw err;
    }
};
  
const muteConversation = async (userId, mutedUserId, duration) => {
    console.log('Cập nhật trạng thái mute:', { userId, mutedUserId, duration });
  
    // 1. Kiểm tra hợp lệ
    if (userId === mutedUserId) {
      throw new Error('Không thể mute hoặc unmute chính mình!');
    }
    const validDurations = ['off', '1h', '3h', '8h', 'on'];
    if (!validDurations.includes(duration)) {
      throw new Error('Tùy chọn mute không hợp lệ! Chọn: off, 1h, 3h, 8h, on');
    }
  
    // 2. Kiểm tra hội thoại tồn tại
    try {
      const result = await dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: {
          ':user1': userId,
          ':user2': mutedUserId,
        },
        Limit: 1,
      }).promise();
  
      if (!result.Items || result.Items.length === 0) {
        const reverseResult = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
          ExpressionAttributeValues: {
            ':user1': userId,
            ':user2': mutedUserId,
          },
          Limit: 1,
        }).promise();
  
        if (!reverseResult.Items || reverseResult.Items.length === 0) {
          throw new Error('Không tìm thấy hội thoại giữa hai người dùng!');
        }
      }
    } catch (err) {
      console.error('Lỗi kiểm tra hội thoại:', err);
      throw err;
    }
  
    // 3. Xử lý unmute
    if (duration === 'off') {
      try {
        await dynamoDB.delete({
          TableName: 'MutedConversations',
          Key: { userId, mutedUserId },
          ConditionExpression: 'attribute_exists(userId)',
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
    try {
      const existingMute = await dynamoDB.get({
        TableName: 'MutedConversations',
        Key: { userId, mutedUserId },
      }).promise();
  
      if (existingMute.Item && existingMute.Item.muteUntil === null && duration !== 'on') {
        throw new Error('Hội thoại đã được mute vĩnh viễn. Vui lòng bỏ mute trước!');
      }
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái mute:', err);
      throw err;
    }
  
    // 5. Tính muteUntil
    let muteUntil;
    if (duration === 'on') {
      muteUntil = null;
    } else if (duration === '1h') {
      muteUntil = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
    } else if (duration === '3h') {
      muteUntil = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    } else if (duration === '8h') {
      muteUntil = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    }
  
    // 6. Lưu vào DynamoDB
    try {
      await dynamoDB.put({
        TableName: 'MutedConversations',
        Item: {
          userId,
          mutedUserId,
          muteUntil,
          timestamp: new Date().toISOString(),
        },
      }).promise();
    } catch (err) {
      console.error('Lỗi lưu trạng thái mute:', err);
      throw err;
    }
  
    // 7. Phát sự kiện
    io().to(userId).emit('conversationMuted', { mutedUserId, muteUntil });
  
    return { success: true, message: 'Đã chặn thông báo!', muteUntil };
};

const pinConversation = async (userId, pinnedUserId) => {
    console.log('Ghim hội thoại:', { userId, pinnedUserId });
  
    // 1. Kiểm tra hợp lệ
    if (userId === pinnedUserId) {
      throw new Error('Không thể ghim hội thoại với chính mình!');
    }
  
    // 2. Kiểm tra hội thoại tồn tại
    try {
      const result = await dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: {
          ':user1': userId,
          ':user2': pinnedUserId,
        },
        Limit: 1,
      }).promise();
  
      if (!result.Items || result.Items.length === 0) {
        const reverseResult = await dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
          ExpressionAttributeValues: {
            ':user1': userId,
            ':user2': pinnedUserId,
          },
          Limit: 1,
        }).promise();
  
        if (!reverseResult.Items || reverseResult.Items.length === 0) {
          throw new Error('Không tìm thấy hội thoại giữa hai người dùng!');
        }
      }
    } catch (err) {
      console.error('Lỗi kiểm tra hội thoại:', err);
      throw err;
    }
  
    // 3. Kiểm tra trạng thái ghim hiện tại
    try {
      const existingPin = await dynamoDB.get({
        TableName: 'PinnedConversations',
        Key: { userId, pinnedUserId },
      }).promise();
  
      if (existingPin.Item) {
        throw new Error('Hội thoại đã được ghim!');
      }
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái ghim:', err);
      throw err;
    }
  
    // 4. Kiểm tra giới hạn ghim
    try {
      const pinnedCount = await dynamoDB.query({
        TableName: 'PinnedConversations',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise();
  
      if (pinnedCount.Items && pinnedCount.Items.length >= 5) {
        throw new Error('Bạn chỉ có thể ghim tối đa 5 hội thoại!');
      }
    } catch (err) {
      console.error('Lỗi kiểm tra số lượng ghim:', err);
      throw err;
    }
  
    // 5. Lưu trạng thái ghim
    try {
      await dynamoDB.put({
        TableName: 'PinnedConversations',
        Item: {
          userId,
          pinnedUserId,
          timestamp: new Date().toISOString(),
        },
      }).promise();
    } catch (err) {
      console.error('Lỗi lưu trạng thái ghim:', err);
      throw err;
    }
  
    // 6. Phát sự kiện
    io().to(userId).emit('conversationPinned', { pinnedUserId });
  
    return { success: true, message: 'Đã ghim hội thoại!' };
};
  
const unpinConversation = async (userId, pinnedUserId) => {
    console.log('Bỏ ghim hội thoại:', { userId, pinnedUserId });
  
    // 1. Kiểm tra hợp lệ
    if (userId === pinnedUserId) {
      throw new Error('Không thể bỏ ghim hội thoại với chính mình!');
    }
  
    // 2. Kiểm tra trạng thái ghim
    try {
      const existingPin = await dynamoDB.get({
        TableName: 'PinnedConversations',
        Key: { userId, pinnedUserId },
      }).promise();
  
      if (!existingPin.Item) {
        throw new Error('Hội thoại chưa được ghim!');
      }
    } catch (err) {
      console.error('Lỗi kiểm tra trạng thái ghim:', err);
      throw err;
    }
  
    // 3. Xóa trạng thái ghim
    try {
      await dynamoDB.delete({
        TableName: 'PinnedConversations',
        Key: { userId, pinnedUserId },
      }).promise();
    } catch (err) {
      console.error('Lỗi xóa trạng thái ghim:', err);
      throw err;
    }
  
    // 4. Phát sự kiện
    io().to(userId).emit('conversationUnpinned', { pinnedUserId });
  
    return { success: true, message: 'Đã bỏ ghim hội thoại!' };
};

const getPinnedConversations = async (userId) => {
    try {
      const params = {
        TableName: 'Conversations',
        KeyConditionExpression: 'userId = :userId',
        FilterExpression: 'isPinned = :isPinned',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':isPinned': true,
        },
      };
  
      const result = await dynamoDB.query(params).promise();
      const pinnedConversations = (result.Items || []).map((item) => ({
        pinnedUserId: item.targetUserId,
      }));
  
      return {
        success: true,
        pinnedConversations,
      };
    } catch (error) {
      console.error('Lỗi trong getPinnedConversations:', error);
      return {
        success: false,
        pinnedConversations: [],
        error: error.message || 'Lỗi khi lấy danh sách hội thoại ghim',
      };
    }
};
// Hàm lấy cài đặt tự động xóa cho cuộc hội thoại
const getAutoDeleteSetting = async (userId, targetUserId) => {
    const result = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId },
    }).promise();
    return result.Item ? result.Item.autoDeleteAfter || 'never' : 'never';
};
  
  // Hàm đặt cài đặt tự động xóa cho cuộc hội thoại
const setAutoDeleteSetting = async (userId, targetUserId, autoDeleteAfter) => {
    const validOptions = ['10s', '60s', '1d', '3d', '7d', 'never'];
    if (!validOptions.includes(autoDeleteAfter)) {
      throw new Error('Giá trị autoDeleteAfter không hợp lệ! Chọn "10s", "60s", "1d", "3d", "7d", hoặc "never".');
    }
    await dynamoDB.put({
      TableName: 'Conversations',
      Item: {
        userId,
        targetUserId,
        autoDeleteAfter,
        updatedAt: new Date().toISOString(),
      },
    }).promise();
  
    return { message: `Cài đặt tự động xóa tin nhắn cho ${targetUserId} đã được đặt thành ${autoDeleteAfter}` };
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
    setAutoDeleteSetting,
    getAutoDeleteSetting,
    getPinnedConversations,
  };