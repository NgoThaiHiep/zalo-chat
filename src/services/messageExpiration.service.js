const { dynamoDB } = require('../config/aws.config');
const { io } = require('../socket');
const { redisClient, redisSubscriber } = require('../config/redis');

// Đăng ký subscription ngay lập tức khi module được import
console.log('[SUB] Initializing redisSubscriber...');
redisSubscriber.subscribe('__keyevent@0__:expired', (err) => {
  if (err) {
    console.error('[SUB] Failed to subscribe to __keyevent@0__:expired:', err);
  } else {
    console.log('[SUB] Successfully subscribed to __keyevent@0__:expired');
  }
});

redisSubscriber.on('connect', () => {
  console.log('[SUB] redisSubscriber connected');
  // Kiểm tra lại subscription
  redisSubscriber.subscribe('__keyevent@0__:expired', (err) => {
    if (err) console.error('[SUB] Re-subscribe error:', err);
    else console.log('[SUB] Re-subscribed to __keyevent@0__:expired on connect');
  });
});

redisSubscriber.on('subscribe', (channel, count) => {
  console.log('[SUB] Subscribed to:', channel, 'with', count, 'subscriptions');
});

redisSubscriber.on('message', async (channel, key) => {
    if (channel === '__keyevent@0__:expired' && key.startsWith('temp_message:')) {
      const [, messageId, senderId, receiverId] = key.split(':');
      if (!messageId || !senderId || !receiverId) {
        console.warn('[WARN] Key format không hợp lệ:', key);
        return;
      }
      console.log('[EVENT] Deleting message:', messageId);
      try {
      await dynamoDB.delete({
        TableName: 'Messages',
        Key: { messageId },
      }).promise();
  
      io().to(senderId).emit('messageDeleted', { messageId, reason: 'expired' });
      io().to(receiverId).emit('messageDeleted', { messageId, reason: 'expired' });
  
      console.log('[SUCCESS] Message deleted via Redis expiration');
    } catch (error) {
        console.error('[ERROR] Lỗi khi xóa message:', error);
      }
    }
  });

redisSubscriber.on('error', (err) => {
  console.error('[SUB] redisSubscriber error:', err);
});

const deleteExpiredMessage = async (messageId) => {
  console.log('[DEBUG] Starting deleteExpiredMessage for:', messageId);
  try {
    const messageData = await redisClient.get(`temp_message:${messageId}`);
    console.log('[DEBUG] Redis data:', messageData);
    if (!messageData) {
      console.log('[WARN] Key not found in Redis');
      return;
    }
    const parsedData = JSON.parse(messageData);
    console.log('[DEBUG] Parsed data:', parsedData);

    const deleteResult = await dynamoDB.delete({
      TableName: 'Messages',
      Key: { messageId },
    }).promise();
    console.log('[DEBUG] DynamoDB delete result:', deleteResult);

    io().to(parsedData.senderId).emit('messageDeleted', { messageId, reason: 'expired' });
    io().to(parsedData.receiverId).emit('messageDeleted', { messageId, reason: 'expired' });

    await redisClient.del(`temp_message:${messageId}`);
    console.log('[SUCCESS] Message deleted');
  } catch (err) {
    console.error('[ERROR] deleteExpiredMessage failed:', err);
  }
};

module.exports = { deleteExpiredMessage };