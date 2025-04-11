const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket');
const {redisClient, redisSubscriber} = require('../config/redis');
const bcrypt = require('bcrypt');
const {  isUserOnline, getUserActivityStatus } = require('./auth.service');
require('dotenv').config()

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
  const validOptions = ['10s','1d', '3d', '7d', 'never'];
  if (!validOptions.includes(autoDeleteAfter)) {
    throw new Error('Giá trị autoDeleteAfter không hợp lệ! Chọn "1d", "3d", "7d", hoặc "never".');
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

const createMessage = async (senderId, receiverId, messageData) => {
  if (!senderId || !receiverId || !messageData || !messageData.type) {
    throw new Error('senderId, receiverId hoặc messageData không hợp lệ!');
  }

  await canSendMessageToUser(senderId, receiverId);
  
  // Lấy cài đặt tự động xóa từ bảng Conversations
  const autoDeleteAfter = await getAutoDeleteSetting(senderId, receiverId);
  const daysToSeconds = { '10s' : 10 ,'1d': 24 * 60 * 60, '3d': 3 * 24 * 60 * 60, '7d': 7 * 24 * 60 * 60 };
  let expiresAt = null;
  
  if (autoDeleteAfter !== 'never' && !daysToSeconds[autoDeleteAfter]) {
    console.warn(`Cài đặt autoDeleteAfter không hợp lệ: ${autoDeleteAfter}`);
  }

   // Nếu autoDeleteAfter không phải 'never', tính expiresAt
  if (autoDeleteAfter !== 'never' && daysToSeconds[autoDeleteAfter]) {
    expiresAt = new Date(Date.now() + daysToSeconds[autoDeleteAfter] * 1000).toISOString();
  }
  const newMessage = {
    messageId: uuidv4(),
    senderId,
    receiverId,
    ...messageData,
    replyToMessageId: messageData.replyToMessageId || null,
    status: 'sending',
    timestamp: new Date().toISOString(),
    expiresAt,
  };

  console.log('Creating message with data:', newMessage);
  io().to(senderId).emit('messageStatus', { messageId: newMessage.messageId, status: 'sending' });

  try {
    const savedMessage = await sendMessageCore(newMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send);
    const receiverOnline = isUserOnline(receiverId);
    const initialStatus = receiverOnline ? 'delivered' : 'sent';

    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId: savedMessage.messageId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': initialStatus },
    }).promise();
    savedMessage.status = initialStatus;
// Thêm đoạn debug để kiểm tra TTL
console.log('AutoDeleteAfter:', autoDeleteAfter);
console.log('ExpiresAt:', expiresAt);
    if (expiresAt && daysToSeconds[autoDeleteAfter]) {
      const ttl = daysToSeconds[autoDeleteAfter];
      console.log('Setting Redis TTL for message:', savedMessage.messageId, 'TTL:', ttl);
      await redisClient.set(
        `temp_message:${savedMessage.messageId}:${senderId}:${receiverId}`,
       'expired',
          'EX',
          ttl
      );
      const redisTtl = await redisClient.ttl(`temp_message:${savedMessage.messageId}`);
      console.log('Redis TTL set to:', redisTtl);
    }
    else {
      console.log('No TTL set: autoDeleteAfter is', autoDeleteAfter);
    }
    if (savedMessage.type === 'voice' && savedMessage.metadata?.transcribe) {
      await transcribeQueue().add(
        {
          messageId: savedMessage.messageId,
          senderId,
          receiverId,
          tableName: 'Messages',
          bucketName: process.env.BUCKET_NAME_Chat_Send,
        },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
      );
    }

    if (receiverOnline) {
      io().to(receiverId).emit('receiveMessage', savedMessage);
    }
    io().to(senderId).emit('messageStatus', { messageId: savedMessage.messageId, status: initialStatus });
    return savedMessage;
    } catch (error) {
    console.error('Error in createMessage:', error);
    await dynamoDB.update({
      
      TableName: 'Messages',
      Key: { messageId: newMessage.messageId },
      UpdateExpression: 'SET #status = :failed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed' },
    }).promise();
    io().to(senderId).emit('messageStatus', { messageId: newMessage.messageId, status: 'failed' });
    throw new Error('Gửi tin nhắn thất bại!');
  }
};



const muteConversation = async (userId, mutedUserId, duration) => {
  const muteUntil = duration === 'forever' ? null : new Date(Date.now() + duration * 60 * 60 * 1000);
  await dynamoDB.put({
    TableName: 'MutedConversations',
    Item: { userId, mutedUserId, muteUntil, timestamp: new Date().toISOString() },
  }).promise();
  return { success: true, message: 'Đã chặn thông báo!' };
};

const retryMessage = async (senderId, messageId) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền gửi lại tin nhắn này!');
  if (message.Item.status !== 'failed') throw new Error('Tin nhắn không ở trạng thái thất bại!');

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId },
    UpdateExpression: 'SET #status = :sending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':sending': 'sending' },
  }).promise();
  io().to(senderId).emit('messageStatus', { messageId, status: 'sending' });

  try {
    const savedMessage = await sendMessageCore(message.Item, 'Messages', process.env.BUCKET_NAME_Chat_Send);
    const receiverOnline = isUserOnline(savedMessage.receiverId);
    const newStatus = receiverOnline ? 'delivered' : 'sent';

    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': newStatus },
    }).promise();
    savedMessage.status = newStatus;

    if (receiverOnline) {
      io().to(savedMessage.receiverId).emit('receiveMessage', savedMessage);
    }
    io().to(senderId).emit('messageStatus', { messageId, status: newStatus });
    return savedMessage;
  } catch (error) {
     console.error('Error in createMessage:', error);
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId },
      UpdateExpression: 'SET #status = :failed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed' },
    }).promise();
    io().to(senderId).emit('messageStatus', { messageId, status: 'failed' });
    throw new Error('Gửi lại tin nhắn thất bại!');
  }
};

const markMessageAsSeen = async (userId, messageId) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item || message.Item.receiverId !== userId) {
    throw new Error('Không có quyền đánh dấu tin nhắn này!');
  }
  if (message.Item.status === 'seen') {
    return { message: 'Tin nhắn đã được xem trước đó' };
  }

  const receiver = await dynamoDB.get({ TableName: 'Users', Key: { userId } }).promise();
  if (!receiver.Item) throw new Error('Người dùng không tồn tại!');
  const showReadReceipts = receiver.Item.showReadReceipts !== false;

  let newStatus = message.Item.status === 'sent' ? 'delivered' : message.Item.status;
  if (showReadReceipts) {
    newStatus = 'seen';
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId },
      UpdateExpression: 'SET #status = :seen',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':seen': 'seen' },
    }).promise();
  } else if (message.Item.status === 'sent') {
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId },
      UpdateExpression: 'SET #status = :delivered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':delivered': 'delivered' },
    }).promise();
  }

  io().to(message.Item.senderId).emit('messageStatus', { messageId, status: newStatus });
  io().to(userId).emit('messageStatus', { messageId, status: newStatus });
  return { message: `Tin nhắn ở trạng thái ${newStatus}` };
};

const getMessagesBetweenUsers = async (user1, user2) => {
  const params1 = {
    TableName: 'Messages',
    IndexName: 'SenderReceiverIndex',
    KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
    ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
  };

  const params2 = {
    TableName: 'Messages',
    IndexName: 'SenderReceiverIndex',
    KeyConditionExpression: 'senderId = :user2 AND receiverId = :user1',
    ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
  };

  const [result1, result2] = await Promise.all([
    dynamoDB.query(params1).promise(),
    dynamoDB.query(params2).promise(),
  ]);

  const allMessages = [...result1.Items, ...result2.Items].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
  return { success: true, messages: allMessages };
};

const updateMessageStatusOnConnect = async (userId) => {
  const params = {
    TableName: 'Messages',
    IndexName: 'ReceiverSenderIndex',
    KeyConditionExpression: 'receiverId = :userId',
    FilterExpression: '#status = :sent',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':userId': userId, ':sent': 'sent' },
  };

  const result = await dynamoDB.query(params).promise();
  const messages = result.Items || [];

  for (const message of messages) {
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId: message.messageId },
      UpdateExpression: 'SET #status = :delivered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':delivered': 'delivered' },
    }).promise();
    io().to(message.senderId).emit('messageStatus', { messageId: message.messageId, status: 'delivered' });
    io().to(userId).emit('receiveMessage', { ...message, status: 'delivered' });
  }
};

const getConversationUsers = async (currentUserId) => {
  const hiddenConversations = await getHiddenConversations(currentUserId);
  const hiddenUserIds = new Set(hiddenConversations.map(conv => conv.hiddenUserId));
  const params1 = {
    TableName: 'Messages',
    IndexName: 'SenderReceiverIndex',
    KeyConditionExpression: 'senderId = :userId',
    ExpressionAttributeValues: { ':userId': currentUserId },
  };
  const params2 = {
    TableName: 'Messages',
    IndexName: 'ReceiverSenderIndex',
    KeyConditionExpression: 'receiverId = :userId',
    ExpressionAttributeValues: { ':userId': currentUserId },
  };

  const [result1, result2] = await Promise.all([
    dynamoDB.query(params1).promise(),
    dynamoDB.query(params2).promise(),
  ]);

  const userIds = new Set([
    ...result1.Items.map(msg => msg.receiverId),
    ...result2.Items.map(msg => msg.senderId),
  ]);

  const usersWithNicknames = await Promise.all(
    [...userIds].map(async (userId) => {
      const user = await dynamoDB.get({ TableName: 'Users', Key: { userId } }).promise();
      const nickname = await getConversationNickname(currentUserId, userId);
      const activityStatus = await getUserActivityStatus(userId, currentUserId);
      return user.Item ? {
        id: userId,
        name: nickname || user.Item.name,
        phoneNumber: user.Item.phoneNumber,
        activityStatus,
      } : null;
    })
  );
  return { success: true, users: usersWithNicknames.filter(user => !hiddenUserIds.has(user.id)) };
};

const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  await canSendMessageToUser(senderId, targetReceiverId);

  const originalMessage = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId },
  }).promise();

  if (!originalMessage.Item) throw new Error('Tin nhắn gốc không tồn tại!');
  if (originalMessage.Item.senderId !== senderId && originalMessage.Item.receiverId !== senderId) {
    throw new Error('Bạn không có quyền chuyển tiếp tin nhắn này!');
  }

  // Lấy cài đặt tự động xóa từ cuộc hội thoại giữa senderId và targetReceiverId
  const autoDeleteAfter = await getAutoDeleteSetting(senderId, targetReceiverId);
  const daysToSeconds = { '10s': 10, '1d': 24 * 60 * 60, '3d': 3 * 24 * 60 * 60, '7d': 7 * 24 * 60 * 60 };
  let expiresAt = null;

  if (autoDeleteAfter !== 'never' && !daysToSeconds[autoDeleteAfter]) {
    console.warn(`Cài đặt autoDeleteAfter không hợp lệ: ${autoDeleteAfter}`);
  }

  if (autoDeleteAfter !== 'never' && daysToSeconds[autoDeleteAfter]) {
    expiresAt = new Date(Date.now() + daysToSeconds[autoDeleteAfter] * 1000).toISOString();
  }

  const newMessage = {
    messageId: uuidv4(),
    senderId,
    receiverId: targetReceiverId,
    type: originalMessage.Item.type,
    content: originalMessage.Item.content,
    mediaUrl: originalMessage.Item.mediaUrl,
    fileName: originalMessage.Item.fileName,
    mimeType: originalMessage.Item.mimeType,
    metadata: { ...originalMessage.Item.metadata, forwardedFrom: messageId },
    isAnonymous: false,
    isSecret: false,
    quality: originalMessage.Item.quality,
    timestamp: new Date().toISOString(),
    expiresAt, // Thêm expiresAt
  };

  console.log('Forwarding message with data:', newMessage);

  const savedMessage = await sendMessageCore(newMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send);

  // Đặt TTL trong Redis nếu có expiresAt
  if (expiresAt && daysToSeconds[autoDeleteAfter]) {
    const ttl = daysToSeconds[autoDeleteAfter];
    console.log('Setting Redis TTL for forwarded message:', savedMessage.messageId, 'TTL:', ttl);
    await redisClient.set(
      `temp_message:${savedMessage.messageId}:${senderId}:${targetReceiverId}`,
      'expired',
      'EX',
      ttl
    );
    const redisTtl = await redisClient.ttl(`temp_message:${savedMessage.messageId}:${senderId}:${targetReceiverId}`);
    console.log('Redis TTL set to:', redisTtl);
  } else {
    console.log('No TTL set for forwarded message: autoDeleteAfter is', autoDeleteAfter);
  }

  io().to(targetReceiverId).emit('receiveMessage', savedMessage);
  io().to(senderId).emit('receiveMessage', savedMessage);
  return savedMessage;
};

const recallMessage = async (senderId, messageId) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền thu hồi tin nhắn này!');

  const timeDiffHours = (new Date() - new Date(message.Item.timestamp)) / (1000 * 60 * 60);
  if (timeDiffHours > 24) throw new Error('Không thể thu hồi tin nhắn sau 24 giờ!');

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId },
    UpdateExpression: 'set isRecalled = :r',
    ExpressionAttributeValues: { ':r': true },
  }).promise();

  io().to(message.Item.receiverId).emit('messageRecalled', { messageId });
  io().to(senderId).emit('messageRecalled', { messageId });
  return { success: true, message: 'Tin nhắn đã được thu hồi!' };
};

const pinMessage = async (senderId, messageId) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId && message.Item.receiverId !== senderId) {
    throw new Error('Bạn không có quyền ghim tin nhắn này!');
  }

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId },
    UpdateExpression: 'set isPinned = :p',
    ExpressionAttributeValues: { ':p': true },
  }).promise();

  io().to(message.Item.receiverId).emit('messagePinned', { messageId });
  io().to(senderId).emit('messagePinned', { messageId });
  return { success: true, message: 'Tin nhắn đã được ghim!' };
};

const setReminder = async (senderId, messageId, reminder) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền đặt nhắc nhở cho tin nhắn này!');

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId },
    UpdateExpression: 'set reminder = :r',
    ExpressionAttributeValues: { ':r': reminder },
  }).promise();

  return { success: true, message: 'Đã đặt nhắc nhở!' };
};

const deleteMessage = async (senderId, messageId, deleteType) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền xóa tin nhắn này!');

  if (deleteType === 'everyone') {
    await dynamoDB.delete({ TableName: 'Messages', Key: { messageId } }).promise();
    if (message.Item.mediaUrl) {
      const key = message.Item.mediaUrl.split('/').slice(3).join('/');
      await s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: key }).promise();
    }
    io().to(message.Item.receiverId).emit('messageDeleted', { messageId });
    io().to(senderId).emit('messageDeleted', { messageId });
    return { success: true, message: 'Tin nhắn đã được xóa hoàn toàn!' };
  } else {
    await dynamoDB.put({
      TableName: 'UserDeletedMessages',
      Item: { userId: senderId, messageId, timestamp: new Date().toISOString() },
    }).promise();
    io().to(senderId).emit('messageDeleted', { messageId });
    return { success: true, message: 'Tin nhắn đã được xóa chỉ với bạn!' };
  }
};

const restoreMessage = async (senderId, messageId) => {
  const message = await dynamoDB.get({ TableName: 'Messages', Key: { messageId } }).promise();
  if (!message.Item) throw new Error('Tin nhắn không tồn tại hoặc đã bị xóa hoàn toàn!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền khôi phục tin nhắn này!');

  await dynamoDB.delete({
    TableName: 'UserDeletedMessages',
    Key: { userId: senderId, messageId },
  }).promise();

  io().to(senderId).emit('messageRestored', { messageId });
  return { success: true, message: 'Tin nhắn đã được khôi phục!' };
};

const hideConversation = async (userId, hiddenUserId, password) => {
  const hashedPassword = await bcrypt.hash(password, 10);
  const hiddenData = JSON.stringify({ hiddenUserId, password: hashedPassword });
  await redisClient.set(`hidden:${userId}:${hiddenUserId}`, hiddenData);
  return { success: true, message: 'Đã ẩn cuộc trò chuyện!' };
};

const unhideConversation = async (userId, hiddenUserId, password) => {
  const hiddenData = await redisClient.get(`hidden:${userId}:${hiddenUserId}`);
  if (!hiddenData) throw new Error('Cuộc trò chuyện không được ẩn!');
  const { password: hashedPassword } = JSON.parse(hiddenData);
  const isMatch = await bcrypt.compare(password, hashedPassword);
  if (!isMatch) throw new Error('Mật khẩu không đúng!');
  await redisClient.del(`hidden:${userId}:${hiddenUserId}`);
  return { success: true, message: 'Đã mở ẩn cuộc trò chuyện!' };
};

const getHiddenConversations = async (userId) => {
  const keys = await redisClient.keys(`hidden:${userId}:*`);
  const hiddenConversations = await Promise.all(
    keys.map(async (key) => {
      const data = await redisClient.get(key);
      const { hiddenUserId } = JSON.parse(data);
      return { userId, hiddenUserId };
    })
  );
  return hiddenConversations;
};

const setConversationNickname = async (userId, targetUserId, nickname) => {
  await redisClient.set(`nickname:${userId}:${targetUserId}`, nickname);
  return { success: true, message: 'Đã đặt tên gợi nhớ!' };
};

const getConversationNickname = async (userId, targetUserId) => {
  return await redisClient.get(`nickname:${userId}:${targetUserId}`);
};

const isBlocked = async (blockerId, blockedId) => {
  const result = await dynamoDB.get({
    TableName: 'BlockedUsers',
    Key: { userId: blockerId, blockedUserId: blockedId },
  }).promise();
  return !!result.Item;
};
const checkBlockStatus = async (senderId, receiverId) => {
  if (await isBlocked(receiverId, senderId)) {
    throw new Error('Bạn đã bị người này chặn');
  }
  if (await isBlocked(senderId, receiverId)) {
    throw new Error('Bạn đã chặn người này');
  }
};
// Kiểm tra quyền gửi tin nhắn
const canSendMessageToUser = async (senderId, receiverId, isForward = false) => {
  console.log('Checking canSendMessageToUser:', { senderId, receiverId, isForward });

  // 1. Gửi cho chính mình luôn được phép
  if (senderId === receiverId) return true;

  // 2. Kiểm tra block
  await checkBlockStatus(senderId, receiverId);

  // 3. Kiểm tra người nhận có tồn tại
  const receiverResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: receiverId },
  }).promise();

  const receiver = receiverResult.Item;
  if (!receiver) throw new Error('Người nhận không tồn tại!');

  const restrictStrangerMessages = receiver.restrictStrangerMessages;

  // 4. Nếu KHÔNG giới hạn người lạ → chỉ cần kiểm tra nếu là forward
  if (!restrictStrangerMessages) {
    if (!isForward) return true;

    // Kiểm tra lịch sử gửi tin nhắn (forward yêu cầu từng nói chuyện)
    const messageHistory = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :sender AND receiverId = :receiver',
      ExpressionAttributeValues: {
        ':sender': senderId,
        ':receiver': receiverId,
      },
      Limit: 1,
    }).promise();

    if (messageHistory.Items.length > 0) return true;

    throw new Error('Chưa từng nhắn tin với người này, không thể chuyển tiếp!');
  }

  // 5. Nếu người nhận giới hạn người lạ → chỉ bạn bè mới được phép
  const friendResult = await dynamoDB.get({
    TableName: 'Friends',
    Key: { userId: receiverId, friendId: senderId },
  }).promise();

  if (friendResult.Item) return true;

  throw new Error('Người này không nhận tin nhắn từ người lạ!');
};

module.exports = {
  createMessage,
  getMessagesBetweenUsers,
  getConversationUsers,
  forwardMessage,
  recallMessage,
  pinMessage,
  setReminder,
  deleteMessage,
  restoreMessage,
  retryMessage,
  markMessageAsSeen,
  updateMessageStatusOnConnect,
  muteConversation,
  hideConversation,
  unhideConversation,
  getHiddenConversations,
  setConversationNickname,
  getConversationNickname,
  canSendMessageToUser,
  checkBlockStatus,
  setAutoDeleteSetting,
  getAutoDeleteSetting,
  
};