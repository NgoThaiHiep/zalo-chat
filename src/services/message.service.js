const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket'); // Import transcribeQueue từ socket.js

const createMessage = async (senderId, receiverId, messageData) => {
  if (!senderId || !receiverId || !messageData || !messageData.type) {
    throw new Error('senderId, receiverId hoặc messageData không hợp lệ!');
  }

  const newMessage = {
    messageId: uuidv4(),
    senderId,
    receiverId,
    ...messageData,
    timestamp: new Date().toISOString(),
  };

  console.log('Creating message with data:', newMessage); // Debug

  const savedMessage = await sendMessageCore(newMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send);

  // Thêm job vào queue nếu là tin nhắn thoại có transcribe
  if (savedMessage.type === 'voice' && savedMessage.metadata?.transcribe) {
    await transcribeQueue.add({
      messageId: savedMessage.messageId,
      senderId,
      receiverId,
      tableName: 'Messages',
    }, {
      attempts: 5,
      backoff: 5000,
    });
  }

  io().to(receiverId).emit('receiveMessage', savedMessage);
  io().to(senderId).emit('receiveMessage', savedMessage);
  return savedMessage;
};

// Các hàm khác giữ nguyên
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

const getConversationUsers = async (currentUserId) => {
  const params = {
    TableName: 'Messages',
    FilterExpression: 'senderId = :userId OR receiverId = :userId',
    ExpressionAttributeValues: { ':userId': currentUserId },
  };

  const result = await dynamoDB.scan(params).promise();
  const userIds = new Set();
  result.Items.forEach((msg) => {
    if (msg.senderId && msg.senderId !== currentUserId) userIds.add(msg.senderId);
    if (msg.receiverId && msg.receiverId !== currentUserId) userIds.add(msg.receiverId);
  });

  const users = await Promise.all(
    [...userIds].map(async (userId) => {
      const user = await dynamoDB.get({ TableName: 'Users', Key: { userId } }).promise();
      return user.Item ? { id: userId, name: user.Item.name, phoneNumber: user.Item.phoneNumber } : null;
    })
  );

  return { success: true, users: users.filter(Boolean) };
};

const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  const originalMessage = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId },
  }).promise();

  if (!originalMessage.Item) throw new Error('Tin nhắn gốc không tồn tại!');
  if (originalMessage.Item.senderId !== senderId) throw new Error('Bạn không có quyền chuyển tiếp tin nhắn này!');

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
  };

  const savedMessage = await sendMessageCore(newMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send);
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
};