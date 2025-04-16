require('dotenv').config();
const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket');
const { isUserOnline } = require('./auth.service');
const ConversationService = require('./conversation.service');
const FriendService = require('./friend.service');
const logger = require('../config/logger');
const { AppError } = require('../untils/errorHandler');

const DAYS_TO_SECONDS = {
  '10s': 10,
  '60s': 60,
  '1d': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
};

const MESSAGE_STATUSES = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  SEEN: 'seen',
  FAILED: 'failed',
  RECALLED: 'recalled',
};

// Hàm hỗ trợ: Tạo bản ghi tin nhắn
const buildMessageRecord = (baseMessage, ownerId, expiresAt) => ({
  ...baseMessage,
  ownerId,
  expiresAt,
});

// Hàm hỗ trợ: Cập nhật trạng thái tin nhắn
const updateMessageStatus = async (messageId, ownerId, status, tableName = 'Messages') => {
  try {
    await dynamoDB.update({
      TableName: tableName,
      Key: { messageId, ownerId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }).promise();
    logger.info(`Updated message status`, { messageId, ownerId, status });
  } catch (error) {
    logger.error(`Failed to update message status`, { messageId, ownerId, status, error: error.message });
    throw new AppError(`Failed to update message status: ${error.message}`, 500);
  }
};

// Hàm hỗ trợ: Xóa file S3
const deleteS3Object = async (bucket, key) => {
  if (!key) return;
  try {
    await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
    logger.info(`Deleted S3 object`, { bucket, key });
  } catch (error) {
    logger.error(`Failed to delete S3 object`, { bucket, key, error: error.message });
  }
};

// Hàm tạo tin nhắn
const createMessage = async (senderId, receiverId, messageData) => {
  // Kiểm tra các tham số cơ bản
  if (!senderId || !receiverId || !messageData) {
    throw new AppError('senderId, receiverId hoặc messageData không hợp lệ!', 400);
  }

  logger.info(`Creating message`, { senderId, receiverId });

  // Kiểm tra quyền gửi tin nhắn
  await canSendMessageToUser(senderId, receiverId);

  // Kiểm tra hoặc tạo hội thoại
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId: senderId, targetUserId: receiverId },
  }).promise();
  if (!conversation.Item) {
    await ConversationService.createConversation(senderId, receiverId);
  }

  // Lấy cài đặt auto-delete
  const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
    ConversationService.getAutoDeleteSetting(senderId, receiverId),
    ConversationService.getAutoDeleteSetting(receiverId, senderId),
  ]);

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
    ? Math.floor(now / 1000) + DAYS_TO_SECONDS[senderAutoDelete]
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
    ? Math.floor(now / 1000) + DAYS_TO_SECONDS[receiverAutoDelete]
    : null;

  // Tạo messageId và base message
  const messageId = uuidv4();
  const baseMessage = {
    messageId,
    senderId,
    receiverId,
    type: messageData.type || null,
    content: messageData.content || null,
    mediaUrl: messageData.mediaUrl || null,
    file: messageData.file || null,
    fileName: messageData.fileName || null,
    mimeType: messageData.mimeType || null,
    metadata: messageData.metadata || {},
    replyToMessageId: messageData.replyToMessageId || null,
    status: MESSAGE_STATUSES.PENDING,
    timestamp: new Date().toISOString(),
  };

  const senderMessage = buildMessageRecord(baseMessage, senderId, senderExpiresAt);
  const receiverMessage = buildMessageRecord(baseMessage, receiverId, receiverExpiresAt);

  io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.PENDING });

  let senderResult = null;
  let receiverResult = null;
  let senderS3Key = null;
  let receiverS3Key = null;

  try {
    // Cập nhật trạng thái sang sending
    io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.SENDING });
    senderMessage.status = MESSAGE_STATUSES.SENDING;
    receiverMessage.status = MESSAGE_STATUSES.SENDING;

    // Lưu tin nhắn
    [senderResult, receiverResult] = await Promise.all([
      sendMessageCore(senderMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send).then(result => {
        senderS3Key = result.mediaUrl?.startsWith(`s3://${process.env.BUCKET_NAME_Chat_Send}/`)
          ? result.mediaUrl.split('/').slice(3).join('/')
          : null;
        return result;
      }),
      sendMessageCore(receiverMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send).then(result => {
        receiverS3Key = result.mediaUrl?.startsWith(`s3://${process.env.BUCKET_NAME_Chat_Send}/`)
          ? result.mediaUrl.split('/').slice(3).join('/')
          : null;
        return result;
      }),
    ]);

    if (!senderResult || !receiverResult) {
      throw new AppError('Failed to save message to DynamoDB', 500);
    }

    // Cập nhật Conversations
    await Promise.all([
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: senderId, targetUserId: receiverId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': { messageId, content: messageData.content || '', createdAt: baseMessage.timestamp },
          ':time': baseMessage.timestamp,
        },
      }).promise(),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: receiverId, targetUserId: senderId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': { messageId, content: messageData.content || '', createdAt: baseMessage.timestamp },
          ':time': baseMessage.timestamp,
        },
      }).promise(),
    ]);

    // Cập nhật trạng thái
    const receiverOnline = isUserOnline(receiverId);
    const initialStatus = receiverOnline ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.SENT;

    await Promise.all([
      updateMessageStatus(messageId, senderId, initialStatus),
      updateMessageStatus(messageId, receiverId, initialStatus),
    ]);

    // Xử lý transcription cho tin nhắn thoại
    if (messageData.type === 'voice' && messageData.metadata?.transcribe) {
      await transcribeQueue().add(
        { messageId, senderId, receiverId, tableName: 'Messages', bucketName: process.env.BUCKET_NAME_Chat_Send },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
      );
      logger.info(`Added transcribe job`, { messageId });
    }

    // Phát sự kiện
    if (receiverOnline) {
      io().to(receiverId).emit('receiveMessage', { ...receiverMessage, status: initialStatus });
    }
    io().to(senderId).emit('messageStatus', { messageId, status: initialStatus });

    return { ...baseMessage, status: initialStatus };
  } catch (error) {
    logger.error(`Error creating message`, { messageId, error: error.message });

    // Cleanup
    await Promise.allSettled([
      deleteS3Object(process.env.BUCKET_NAME_Chat_Send, senderS3Key),
      deleteS3Object(process.env.BUCKET_NAME_Chat_Send, receiverS3Key),
      senderResult && updateMessageStatus(messageId, senderId, MESSAGE_STATUSES.FAILED),
      receiverResult && updateMessageStatus(messageId, receiverId, MESSAGE_STATUSES.FAILED),
    ]);

    io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.FAILED });
    throw new AppError(`Failed to send message: ${error.message}`, 500);
  }
};
// Hàm thử lại tin nhắn
const retryMessage = async (senderId, messageId) => {
  logger.info(`Retrying message`, { messageId, senderId });

  const { Item: message } = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise();

  if (!message) throw new AppError('Message not found', 404);
  if (message.senderId !== senderId) throw new AppError('Unauthorized to retry this message', 403);
  if (message.status !== MESSAGE_STATUSES.FAILED) throw new AppError('Message is not in failed state', 400);

  await updateMessageStatus(messageId, senderId, MESSAGE_STATUSES.SENDING);
  io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.SENDING });

  try {
    const savedMessage = await sendMessageCore(message, 'Messages', process.env.BUCKET_NAME_Chat_Send);
    const receiverOnline = isUserOnline(savedMessage.receiverId);
    const newStatus = receiverOnline ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.SENT;

    await Promise.all([
      updateMessageStatus(messageId, senderId, newStatus),
      updateMessageStatus(messageId, savedMessage.receiverId, newStatus),
    ]);

    if (receiverOnline) {
      io().to(savedMessage.receiverId).emit('receiveMessage', { ...savedMessage, status: newStatus });
    }
    io().to(senderId).emit('messageStatus', { messageId, status: newStatus });

    return { ...savedMessage, status: newStatus };
  } catch (error) {
    logger.error(`Error retrying message`, { messageId, error: error.message });
    await updateMessageStatus(messageId, senderId, MESSAGE_STATUSES.FAILED);
    io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.FAILED });
    throw new AppError(`Failed to retry message: ${error.message}`, 500);
  }
};

// Hàm đánh dấu tin nhắn đã xem
const markMessageAsSeen = async (userId, messageId) => {
  logger.info(`Marking message as seen`, { messageId, userId });

  const { Item: message } = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message || message.receiverId !== userId) {
    throw new AppError('Unauthorized to mark this message as seen', 403);
  }
  if (message.status === MESSAGE_STATUSES.SEEN) {
    return { message: 'Message already marked as seen' };
  }
  if (message.status === MESSAGE_STATUSES.RECALLED) {
    throw new AppError('Cannot mark recalled message as seen', 400);
  }

  const { Item: receiver } = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId },
  }).promise();

  if (!receiver) throw new AppError('User not found', 404);

  const showReadReceipts = receiver.showReadReceipts !== false;
  let newStatus = message.status === MESSAGE_STATUSES.SENT ? MESSAGE_STATUSES.DELIVERED : message.status;

  if (showReadReceipts) {
    newStatus = MESSAGE_STATUSES.SEEN;
    await Promise.all([
      updateMessageStatus(messageId, userId, MESSAGE_STATUSES.SEEN),
      updateMessageStatus(messageId, message.senderId, MESSAGE_STATUSES.SEEN),
    ]);
  } else if (message.status === MESSAGE_STATUSES.SENT) {
    newStatus = MESSAGE_STATUSES.DELIVERED;
    await Promise.all([
      updateMessageStatus(messageId, userId, MESSAGE_STATUSES.DELIVERED),
      updateMessageStatus(messageId, message.senderId, MESSAGE_STATUSES.DELIVERED),
    ]);
  }

  io().to(message.senderId).emit('messageStatus', { messageId, status: newStatus });
  io().to(userId).emit('messageStatus', { messageId, status: newStatus });

  return { message: `Message status updated to ${newStatus}` };
};

// Hàm thu hồi tin nhắn
const recallMessage = async (senderId, messageId) => {
  logger.info(`Recalling message`, { messageId, senderId });

  const { Item: message } = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise();

  if (!message) throw new AppError('Message not found', 404);
  if (message.senderId !== senderId) throw new AppError('Unauthorized to recall this message', 403);
  if (message.status === MESSAGE_STATUSES.RECALLED) throw new AppError('Message already recalled', 400);

  const timeDiffHours = (new Date() - new Date(message.timestamp)) / (1000 * 60 * 60);
  if (timeDiffHours > 24) throw new AppError('Cannot recall message after 24 hours', 400);

  try {
    await Promise.all([
      updateMessageStatus(messageId, senderId, MESSAGE_STATUSES.RECALLED),
      updateMessageStatus(messageId, message.receiverId, MESSAGE_STATUSES.RECALLED),
    ]);

    if (message.mediaUrl) {
      const key = message.mediaUrl.split('/').slice(3).join('/');
      await deleteS3Object(process.env.BUCKET_NAME_Chat_Send, key);
    }

    io().to(message.receiverId).emit('messageRecalled', { messageId });
    io().to(senderId).emit('messageRecalled', { messageId });

    return { success: true, message: 'Message recalled successfully' };
  } catch (error) {
    logger.error(`Error recalling message`, { messageId, error: error.message });
    throw new AppError(`Failed to recall message: ${error.message}`, 500);
  }
};

// Hàm lấy tin nhắn giữa hai người dùng
const getMessagesBetweenUsers = async (user1, user2) => {
  logger.info(`Fetching messages between users`, { user1, user2 });

  try {
    const now = Math.floor(Date.now() / 1000);

    // Lấy danh sách messageId bị xóa
    const { Items: deletedMessages = [] } = await dynamoDB.query({
      TableName: 'UserDeletedMessages',
      KeyConditionExpression: 'userId = :user1',
      ExpressionAttributeValues: { ':user1': user1 },
    }).promise();
    const deletedMessageIds = new Set(deletedMessages.map(item => item.messageId));

    // Truy vấn tin nhắn
    const [senderResult, receiverResult] = await Promise.all([
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
        Limit: 100,
        ScanIndexForward: false,
      }).promise(),
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'ReceiverSenderIndex',
        KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
        ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
        Limit: 100,
        ScanIndexForward: false,
      }).promise(),
    ]);

    const allMessages = [...(senderResult.Items || []), ...(receiverResult.Items || [])];

    // Lọc tin nhắn
    const filteredMessages = allMessages.filter(
      msg =>
        !deletedMessageIds.has(msg.messageId) &&
        (!msg.expiresAt || msg.expiresAt > now) &&
        msg.ownerId === user1
    );

    // Loại bỏ trùng lặp và sắp xếp
    const uniqueMessages = Array.from(
      new Map(filteredMessages.map(msg => [`${msg.messageId}:${msg.ownerId}`, msg])).values()
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return { success: true, messages: uniqueMessages };
  } catch (error) {
    logger.error(`Error fetching messages`, { user1, user2, error: error.message });
    throw new AppError(`Failed to fetch messages: ${error.message}`, 500);
  }
};

// Hàm chuyển tiếp tin nhắn
const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  logger.info(`Forwarding message`, { senderId, messageId, targetReceiverId });

  await canSendMessageToUser(senderId, targetReceiverId, true);

  // Lấy tin nhắn gốc
  let originalMessage = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise().then(res => res.Item);

  if (!originalMessage) {
    const tempMessage = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'ReceiverSenderIndex',
      KeyConditionExpression: 'receiverId = :senderId AND senderId = :senderId',
      FilterExpression: 'messageId = :messageId',
      ExpressionAttributeValues: {
        ':senderId': senderId,
        ':messageId': messageId,
      },
      Limit: 1,
    }).promise();
    originalMessage = tempMessage.Items?.[0];
  }

  if (!originalMessage) throw new AppError('Không tìm thấy tin nhắn', 404);
  if (originalMessage.status === MESSAGE_STATUSES.RECALLED) {
    throw new AppError('Không thể chuyển tiếp tin nhắn đã thu hồi!', 400);
  }
  if (originalMessage.senderId !== senderId && originalMessage.receiverId !== senderId) {
    throw new AppError('Unauthorized to forward this message', 403);
  }

  // Kiểm tra hoặc tạo hội thoại
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId: senderId, targetUserId: targetReceiverId },
  }).promise();
  if (!conversation.Item) {
    await ConversationService.createConversation(senderId, targetReceiverId);
  }

  // Lấy cài đặt auto-delete
  const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
    ConversationService.getAutoDeleteSetting(senderId, targetReceiverId),
    ConversationService.getAutoDeleteSetting(targetReceiverId, senderId),
  ]);

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
    ? Math.floor(now / 1000) + DAYS_TO_SECONDS[senderAutoDelete]
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
    ? Math.floor(now / 1000) + DAYS_TO_SECONDS[receiverAutoDelete]
    : null;

  const newMessageId = uuidv4();
  let newMediaUrl = originalMessage.mediaUrl;
  let newS3Key = null;

  // Xử lý media
  if (newMediaUrl && newMediaUrl.startsWith('s3://')) {
    const bucketName = process.env.BUCKET_NAME_Chat_Send;
    const originalKey = newMediaUrl.split('/').slice(3).join('/');
    const mimeType = originalMessage.mimeType;

    const mimeTypeMap = {
      'image/jpeg': { type: 'image', folder: 'images', ext: 'jpg', maxSize: 10 * 1024 * 1024 },
      'image/png': { type: ['image', 'sticker'], folder: 'images', ext: 'png', maxSize: 10 * 1024 * 1024 },
      'image/heic': { type: 'image', folder: 'images', ext: 'heic', maxSize: 10 * 1024 * 1024 },
      'image/gif': { type: ['gif', 'sticker'], folder: 'gifs', ext: 'gif', maxSize: 10 * 1024 * 1024 },
      'video/mp4': { type: 'video', folder: 'videos', ext: 'mp4', maxSize: 1024 * 1024 * 1024 },
      'audio/mpeg': { type: 'voice', folder: 'voice', ext: 'mp3', maxSize: 50 * 1024 * 1024 },
      'audio/wav': { type: 'voice', folder: 'voice', ext: 'wav', maxSize: 50 * 1024 * 1024 },
      'audio/mp4': { type: 'voice', folder: 'voice', ext: 'm4a', maxSize: 50 * 1024 * 1024 },
      'application/pdf': { type: 'file', folder: 'files', ext: 'pdf', maxSize: 1024 * 1024 * 1024 },
      'application/zip': { type: 'file', folder: 'files', ext: 'zip', maxSize: 1024 * 1024 * 1024 },
      'application/x-rar-compressed': { type: 'file', folder: 'files', ext: 'rar', maxSize: 1024 * 1024 * 1024 },
      'application/vnd.rar': { type: 'file', folder: 'files', ext: 'rar', maxSize: 1024 * 1024 * 1024 },
      'text/plain': { type: 'file', folder: 'files', ext: 'txt', maxSize: 1024 * 1024 * 1024 },
      'image/webp': { type: ['image', 'sticker', 'gif'], folder: 'images', ext: 'webp', maxSize: 10 * 1024 * 1024 },
    };

    const mimeInfo = mimeTypeMap[mimeType];
    if (!mimeInfo) throw new AppError(`Unsupported MIME type: ${mimeType}`, 400);

    newS3Key = `${mimeInfo.folder}/${newMessageId}.${mimeInfo.ext}`;
    try {
      await s3.copyObject({
        Bucket: bucketName,
        CopySource: `${bucketName}/${originalKey}`,
        Key: newS3Key,
        ContentType: mimeType,
      }).promise();
      newMediaUrl = `s3://${bucketName}/${newS3Key}`;
    } catch (error) {
      logger.error(`Error copying S3 file`, { error: error.message });
      throw new AppError(`Failed to copy S3 file: ${error.message}`, 500);
    }
  }

  const baseMessage = {
    messageId: newMessageId,
    senderId,
    receiverId: targetReceiverId,
    type: originalMessage.type,
    content: originalMessage.content,
    mediaUrl: newMediaUrl,
    fileName: originalMessage.fileName,
    mimeType: originalMessage.mimeType,
    metadata: { ...originalMessage.metadata, forwardedFrom: messageId },
    isAnonymous: false,
    isSecret: false,
    quality: originalMessage.quality,
    timestamp: new Date().toISOString(),
    status: MESSAGE_STATUSES.SENDING,
  };

  const senderMessage = buildMessageRecord(baseMessage, senderId, senderExpiresAt);
  const receiverMessage = buildMessageRecord(baseMessage, targetReceiverId, receiverExpiresAt);

  try {
    await Promise.all([
      sendMessageCore(senderMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send),
      sendMessageCore(receiverMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send),
    ]);

    // Cập nhật Conversations
    await Promise.all([
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: senderId, targetUserId: targetReceiverId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': { messageId: newMessageId, content: baseMessage.content || '', createdAt: baseMessage.timestamp },
          ':time': baseMessage.timestamp,
        },
      }).promise(),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: targetReceiverId, targetUserId: senderId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': { messageId: newMessageId, content: baseMessage.content || '', createdAt: baseMessage.timestamp },
          ':time': baseMessage.timestamp,
        },
      }).promise(),
    ]);

    const receiverOnline = isUserOnline(targetReceiverId);
    const initialStatus = receiverOnline ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.SENT;

    await Promise.all([
      updateMessageStatus(newMessageId, senderId, initialStatus),
      updateMessageStatus(newMessageId, targetReceiverId, initialStatus),
    ]);

    io().to(targetReceiverId).emit('receiveMessage', { ...receiverMessage, status: initialStatus });
    io().to(senderId).emit('receiveMessage', { ...senderMessage, status: initialStatus });

    return { ...baseMessage, status: initialStatus };
  } catch (error) {
    await deleteS3Object(process.env.BUCKET_NAME_Chat_Send, newS3Key);
    logger.error(`Error forwarding message`, { messageId, error: error.message });
    throw new AppError(`Failed to forward message: ${error.message}`, 500);
  }
};

// Hàm ghim tin nhắn
const pinMessage = async (userId, messageId) => {
  logger.info('Pinning message:', { messageId, userId });

  let message;
  try {
    const result = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
    }).promise();
    message = result.Item;
  } catch (err) {
    logger.error('Lỗi get message theo ownerId:', err);
    throw new AppError('Lỗi truy vấn tin nhắn', 500);
  }

  if (!message) {
    const searchIndexes = [
      { IndexName: 'ReceiverSenderIndex', keyAttr: 'receiverId' },
      { IndexName: 'SenderReceiverIndex', keyAttr: 'senderId' },
    ];

    for (const { IndexName, keyAttr } of searchIndexes) {
      try {
        const result = await dynamoDB.query({
          TableName: 'Messages',
          IndexName,
          KeyConditionExpression: `${keyAttr} = :userId AND messageId = :messageId`,
          ExpressionAttributeValues: {
            ':userId': userId,
            ':messageId': messageId,
          },
          Limit: 1,
        }).promise();

        if (result.Items?.length > 0) {
          message = result.Items[0];
          break;
        }
      } catch (err) {
        logger.error(`Lỗi truy vấn ${IndexName}:`, err);
      }
    }
  }

  if (!message) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (message.senderId !== userId && message.receiverId !== userId) {
    throw new AppError('Bạn không có quyền ghim tin nhắn này!', 403);
  }
  if (message.isPinned) {
    throw new AppError('Tin nhắn đã được ghim!', 400);
  }
  if (message.status === MESSAGE_STATUSES.RECALLED) {
    throw new AppError('Tin nhắn đã bị thu hồi, không thể ghim!', 400);
  }

  const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;

  // Kiểm tra số lượng tin nhắn ghim
  const conversation = await dynamoDB.get({
    TableName: 'Conversations',
    Key: { userId, targetUserId: otherUserId },
  }).promise();

  const pinnedMessageIds = conversation.Item?.settings?.pinnedMessages || [];
  if (pinnedMessageIds.length >= 3) {
    throw new AppError('Hội thoại chỉ có thể ghim tối đa 3 tin nhắn!', 400);
  }

  // Cập nhật Messages và Conversations
  try {
    await Promise.all([
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId, ownerId: userId },
        UpdateExpression: 'SET isPinned = :p, pinnedBy = :userId',
        ExpressionAttributeValues: { ':p': true, ':userId': userId },
      }).promise(),
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId, ownerId: otherUserId },
        UpdateExpression: 'SET isPinned = :p, pinnedBy = :userId',
        ExpressionAttributeValues: { ':p': true, ':userId': userId },
      }).promise().catch(() => {}),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: otherUserId },
        UpdateExpression: 'SET settings.pinnedMessages = list_append(if_not_exists(settings.pinnedMessages, :empty), :msg)',
        ExpressionAttributeValues: {
          ':msg': [messageId],
          ':empty': [],
        },
      }).promise(),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: otherUserId, targetUserId: userId },
        UpdateExpression: 'SET settings.pinnedMessages = list_append(if_not_exists(settings.pinnedMessages, :empty), :msg)',
        ExpressionAttributeValues: {
          ':msg': [messageId],
          ':empty': [],
        },
      }).promise(),
    ]);

    io().to(userId).emit('messagePinned', { messageId });
    io().to(otherUserId).emit('messagePinned', { messageId });

    return { success: true, message: `Tin nhắn đã được ghim bởi ${userId}` };
  } catch (err) {
    logger.error('Lỗi khi ghim tin nhắn:', err);
    throw new AppError('Không thể ghim tin nhắn', 500);
  }
};

// Hàm bỏ ghim tin nhắn
const unpinMessage = async (userId, messageId) => {
  logger.info('Unpinning message:', { userId, messageId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (!message.Item.isPinned) throw new AppError('Tin nhắn chưa được ghim!', 400);

  const otherUserId = message.Item.senderId === userId ? message.Item.receiverId : message.Item.senderId;

  try {
    await Promise.all([
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId, ownerId: userId },
        UpdateExpression: 'SET isPinned = :false REMOVE pinnedBy',
        ExpressionAttributeValues: { ':false': false },
      }).promise(),
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId, ownerId: otherUserId },
        UpdateExpression: 'SET isPinned = :false REMOVE pinnedBy',
        ExpressionAttributeValues: { ':false': false },
      }).promise().catch(() => {}),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: otherUserId },
        UpdateExpression: 'SET settings.pinnedMessages = :msgs',
        ExpressionAttributeValues: {
          ':msgs': (await dynamoDB.get({
            TableName: 'Conversations',
            Key: { userId, targetUserId: otherUserId },
          }).promise()).Item?.settings?.pinnedMessages?.filter(id => id !== messageId) || [],
        },
      }).promise(),
      dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId: otherUserId, targetUserId: userId },
        UpdateExpression: 'SET settings.pinnedMessages = :msgs',
        ExpressionAttributeValues: {
          ':msgs': (await dynamoDB.get({
            TableName: 'Conversations',
            Key: { userId: otherUserId, targetUserId: userId },
          }).promise()).Item?.settings?.pinnedMessages?.filter(id => id !== messageId) || [],
        },
      }).promise(),
    ]);

    io().to(userId).emit('messageUnpinned', { messageId });
    io().to(otherUserId).emit('messageUnpinned', { messageId });

    return { success: true, message: `Đã bỏ ghim tin nhắn bởi ${userId}` };
  } catch (err) {
    logger.error('Lỗi khi bỏ ghim tin nhắn:', err);
    throw new AppError('Không thể bỏ ghim tin nhắn', 500);
  }
};

// Hàm lấy tin nhắn ghim
const getPinnedMessages = async (userId, otherUserId) => {
  logger.info('Lấy tin nhắn ghim của:', { userId, otherUserId });

  try {
    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId: otherUserId },
    }).promise();

    const pinnedMessageIds = conversation.Item?.settings?.pinnedMessages || [];
    if (!pinnedMessageIds.length) {
      return { success: true, messages: [] };
    }

    const messages = await Promise.all(
      pinnedMessageIds.map(async messageId => {
        const message = await dynamoDB.get({
          TableName: 'Messages',
          Key: { messageId, ownerId: userId },
        }).promise();
        return message.Item;
      })
    );

    const validMessages = messages
      .filter(msg => msg && msg.isPinned && msg.status !== MESSAGE_STATUSES.RECALLED)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return { success: true, messages: validMessages };
  } catch (err) {
    logger.error('Lỗi khi lấy tin nhắn ghim:', err);
    throw new AppError('Không thể lấy tin nhắn ghim', 500);
  }
};

// Hàm đặt nhắc nhở
const setReminder = async (userId, messageId, reminder, scope = 'both', reminderContent, repeat = 'none', daysOfWeek) => {
  logger.info('Setting reminder for message:', { messageId, userId, reminder, scope, reminderContent, repeat, daysOfWeek });

  if (reminder && new Date(reminder) <= new Date()) {
    throw new AppError('Thời gian nhắc nhở phải ở tương lai!', 400);
  }
  if (!['onlyMe', 'both'].includes(scope)) {
    throw new AppError('Phạm vi nhắc nhở phải là "onlyMe" hoặc "both"!', 400);
  }
  const validRepeatTypes = ['none', 'daily', 'weekly', 'multipleDaysWeekly', 'monthly', 'yearly'];
  if (!validRepeatTypes.includes(repeat)) {
    throw new AppError('Loại lặp lại không hợp lệ!', 400);
  }
  if (repeat === 'multipleDaysWeekly') {
    if (!Array.isArray(daysOfWeek) || !daysOfWeek.length) {
      throw new AppError('daysOfWeek phải là mảng không rỗng!', 400);
    }
    if (!daysOfWeek.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
      throw new AppError('daysOfWeek phải chứa số từ 1 đến 7!', 400);
    }
  } else if (daysOfWeek) {
    throw new AppError('daysOfWeek chỉ dùng cho multipleDaysWeekly!', 400);
  }

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (message.Item.status === MESSAGE_STATUSES.RECALLED) {
    throw new AppError('Tin nhắn đã bị thu hồi!', 400);
  }
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new AppError('Bạn không có quyền đặt nhắc nhở!', 403);
  }

  const otherUserId = message.Item.senderId === userId ? message.Item.receiverId : message.Item.senderId;
  const finalReminderContent =
    reminderContent ||
    (message.Item.type === 'text' && message.Item.content ? message.Item.content : `Nhắc nhở cho tin nhắn ${messageId}`);

  let updateExpression = 'SET reminder = :r, reminderScope = :s, reminderContent = :rc, repeatType = :rt';
  let expressionAttributeValues = {
    ':r': reminder,
    ':s': scope,
    ':rc': finalReminderContent,
    ':rt': repeat,
  };

  if (repeat === 'multipleDaysWeekly' && daysOfWeek) {
    updateExpression += ', daysOfWeek = :dow';
    expressionAttributeValues[':dow'] = daysOfWeek;
  } else {
    updateExpression += ' REMOVE daysOfWeek';
  }

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
  }).promise();

  const reminderData = {
    messageId,
    reminder,
    scope,
    reminderContent: finalReminderContent,
    repeatType: repeat,
    daysOfWeek: repeat === 'multipleDaysWeekly' ? daysOfWeek : undefined,
    setBy: userId,
  };
  io().to(userId).emit('reminderSet', reminderData);
  if (scope === 'both') {
    io().to(otherUserId).emit('reminderSet', reminderData);
  }

  return { success: true, message: 'Đã đặt nhắc nhở!' };
};

// Hàm xóa nhắc nhở
const unsetReminder = async (userId, messageId) => {
  logger.info('Unsetting reminder for message:', { messageId, userId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (!message.Item.reminder) {
    throw new AppError('Tin nhắn này chưa có nhắc nhở!', 400);
  }
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new AppError('Bạn không có quyền xóa nhắc nhở!', 403);
  }

  const otherUserId = message.Item.senderId === userId ? message.Item.receiverId : message.Item.senderId;
  const scope = message.Item.reminderScope || 'both';

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: 'REMOVE reminder, reminderScope, reminderContent, repeatType, daysOfWeek',
  }).promise();

  io().to(userId).emit('reminderUnset', { messageId, unsetBy: userId });
  if (scope === 'both') {
    io().to(otherUserId).emit('reminderUnset', { messageId, unsetBy: userId });
  }

  return { success: true, message: 'Đã xóa nhắc nhở!' };
};

// Hàm lấy nhắc nhở giữa hai người dùng
const getRemindersBetweenUsers = async (userId, otherUserId) => {
  logger.info('Getting reminders between users:', { userId, otherUserId });

  const now = new Date().toISOString();

  const userReminders = await dynamoDB.query({
    TableName: 'Messages',
    IndexName: 'OwnerReminderIndex',
    KeyConditionExpression: 'ownerId = :userId',
    FilterExpression: 'reminder >= :now AND (senderId = :otherUserId OR receiverId = :otherUserId)',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':otherUserId': otherUserId,
      ':now': now,
    },
  }).promise();

  const otherUserReminders = await dynamoDB.query({
    TableName: 'Messages',
    IndexName: 'OwnerReminderIndex',
    KeyConditionExpression: 'ownerId = :otherUserId',
    FilterExpression: 'reminder >= :now AND reminderScope = :both AND (senderId = :userId OR receiverId = :userId)',
    ExpressionAttributeValues: {
      ':otherUserId': otherUserId,
      ':userId': userId,
      ':both': 'both',
      ':now': now,
    },
  }).promise();

  const reminders = [
    ...(userReminders.Items || []).map(msg => ({
      messageId: msg.messageId,
      reminder: msg.reminder,
      scope: msg.reminderScope,
      reminderContent: msg.reminderContent,
      repeatType: msg.repeatType,
      daysOfWeek: msg.daysOfWeek,
      setBy: msg.ownerId,
    })),
    ...(otherUserReminders.Items || []).map(msg => ({
      messageId: msg.messageId,
      reminder: msg.reminder,
      scope: msg.reminderScope,
      reminderContent: msg.reminderContent,
      repeatType: msg.repeatType,
      daysOfWeek: msg.daysOfWeek,
      setBy: msg.ownerId,
    })),
  ];

  return { success: true, reminders };
};

// Hàm kiểm tra và thông báo nhắc nhở
const checkAndNotifyReminders = async () => {
  const now = new Date();
  const messages = await dynamoDB.query({
    TableName: 'Messages',
    IndexName: 'ReminderIndex',
    KeyConditionExpression: 'reminder <= :now',
    ExpressionAttributeValues: { ':now': now.toISOString() },
  }).promise();

  for (const msg of messages.Items || []) {
    const { repeatType, daysOfWeek, reminder } = msg;
    let newReminder = null;

    if (repeatType && repeatType !== 'none') {
      const reminderDate = new Date(reminder);
      switch (repeatType) {
        case 'daily':
          newReminder = new Date(reminderDate.setDate(reminderDate.getDate() + 1)).toISOString();
          break;
        case 'weekly':
          newReminder = new Date(reminderDate.setDate(reminderDate.getDate() + 7)).toISOString();
          break;
        case 'multipleDaysWeekly':
          const currentDay = now.getDay() || 7;
          const nextDay = daysOfWeek.find(day => day > currentDay) || daysOfWeek[0];
          const daysToAdd = nextDay > currentDay ? nextDay - currentDay : 7 - currentDay + nextDay;
          newReminder = new Date(reminderDate.setDate(reminderDate.getDate() + daysToAdd)).toISOString();
          break;
        case 'monthly':
          newReminder = new Date(reminderDate.setMonth(reminderDate.getMonth() + 1)).toISOString();
          break;
        case 'yearly':
          newReminder = new Date(reminderDate.setFullYear(reminderDate.getFullYear() + 1)).toISOString();
          break;
      }
    }

    io().to(msg.ownerId).emit('reminderTriggered', {
      messageId: msg.messageId,
      reminderContent: msg.reminderContent,
    });
    if (msg.reminderScope === 'both') {
      const otherUserId = msg.senderId === msg.ownerId ? msg.receiverId : msg.senderId;
      io().to(otherUserId).emit('reminderTriggered', {
        messageId: msg.messageId,
        reminderContent: msg.reminderContent,
      });
    }

    if (newReminder) {
      await dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: msg.messageId, ownerId: msg.ownerId },
        UpdateExpression: 'SET reminder = :r',
        ExpressionAttributeValues: { ':r': newReminder },
      }).promise();
    } else {
      await dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: msg.messageId, ownerId: msg.ownerId },
        UpdateExpression: 'REMOVE reminder, reminderScope, reminderContent, repeatType, daysOfWeek',
      }).promise();
    }

    await dynamoDB.put({
      TableName: 'ReminderLogs',
      Item: {
        logId: uuidv4(),
        messageId: msg.messageId,
        userId: msg.ownerId,
        reminder: msg.reminder,
        reminderContent: msg.reminderContent || `Nhắc nhở cho tin nhắn ${msg.messageId}`,
        timestamp: now.toISOString(),
      },
    }).promise();
  }
};

// Hàm lấy lịch sử nhắc nhở
const getReminderHistory = async (userId, otherUserId) => {
  logger.info('Getting reminder history between users:', { userId, otherUserId });

  const logs = await dynamoDB.scan({
    TableName: 'ReminderLogs',
    FilterExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
  }).promise();

  const history = [];
  for (const log of logs.Items || []) {
    const message = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId: log.messageId, ownerId: userId },
    }).promise();

    if (
      message.Item &&
      ((message.Item.senderId === userId && message.Item.receiverId === otherUserId) ||
        (message.Item.senderId === otherUserId && message.Item.receiverId === userId))
    ) {
      history.push({
        logId: log.logId,
        messageId: log.messageId,
        reminder: log.reminder,
        reminderContent: log.reminderContent,
        timestamp: log.timestamp,
      });
    }
  }

  return { success: true, history };
};

// Hàm chỉnh sửa nhắc nhở
const editReminder = async (userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek) => {
  logger.info('Editing reminder for message:', { messageId, userId, reminder, scope, reminderContent, repeat, daysOfWeek });

  if (reminder && new Date(reminder) <= new Date()) {
    throw new AppError('Thời gian nhắc nhở phải ở tương lai!', 400);
  }
  if (scope && !['onlyMe', 'both'].includes(scope)) {
    throw new AppError('Phạm vi nhắc nhở phải là "onlyMe" hoặc "both"!', 400);
  }
  const validRepeatTypes = ['none', 'daily', 'weekly', 'multipleDaysWeekly', 'monthly', 'yearly'];
  if (repeat && !validRepeatTypes.includes(repeat)) {
    throw new AppError('Loại lặp lại không hợp lệ!', 400);
  }
  if (repeat === 'multipleDaysWeekly') {
    if (!Array.isArray(daysOfWeek) || !daysOfWeek.length) {
      throw new AppError('daysOfWeek phải là mảng không rỗng!', 400);
    }
    if (!daysOfWeek.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
      throw new AppError('daysOfWeek phải chứa số từ 1 đến 7!', 400);
    }
  } else if (daysOfWeek && repeat !== 'multipleDaysWeekly') {
    throw new AppError('daysOfWeek chỉ dùng cho multipleDaysWeekly!', 400);
  }

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (!message.Item.reminder) {
    throw new AppError('Tin nhắn chưa có nhắc nhở!', 400);
  }
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new AppError('Bạn không có quyền chỉnh sửa nhắc nhở!', 403);
  }

  const otherUserId = message.Item.senderId === userId ? message.Item.receiverId : message.Item.senderId;
  const finalReminderContent =
    reminderContent !== undefined
      ? reminderContent ||
        (message.Item.type === 'text' && message.Item.content ? message.Item.content : `Nhắc nhở cho tin nhắn ${messageId}`)
      : message.Item.reminderContent;

  let updateExpression = 'SET reminder = :r';
  const expressionAttributeValues = { ':r': reminder };

  if (scope) {
    updateExpression += ', reminderScope = :s';
    expressionAttributeValues[':s'] = scope;
  }
  if (reminderContent !== undefined) {
    updateExpression += ', reminderContent = :rc';
    expressionAttributeValues[':rc'] = finalReminderContent;
  }
  if (repeat) {
    updateExpression += ', repeatType = :rt';
    expressionAttributeValues[':rt'] = repeat;
  }
  if (repeat === 'multipleDaysWeekly' && daysOfWeek) {
    updateExpression += ', daysOfWeek = :dow';
    expressionAttributeValues[':dow'] = daysOfWeek;
  } else if (repeat && repeat !== 'multipleDaysWeekly') {
    updateExpression += ' REMOVE daysOfWeek';
  }

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
  }).promise();

  const finalScope = scope || message.Item.reminderScope || 'both';
  const finalRepeat = repeat || message.Item.repeatType || 'none';
  const finalDaysOfWeek =
    repeat === 'multipleDaysWeekly' ? daysOfWeek : repeat && repeat !== 'multipleDaysWeekly' ? undefined : message.Item.daysOfWeek;

  const reminderData = {
    messageId,
    reminder,
    scope: finalScope,
    reminderContent: finalReminderContent,
    repeatType: finalRepeat,
    daysOfWeek: finalDaysOfWeek,
    setBy: userId,
  };
  io().to(userId).emit('reminderEdited', reminderData);
  if (finalScope === 'both') {
    io().to(otherUserId).emit('reminderEdited', reminderData);
  }

  return { success: true, message: 'Đã chỉnh sửa nhắc nhở!' };
};

// Hàm xóa tin nhắn chỉ với bạn
const deleteMessage = async (userId, messageId) => {
  logger.info('Deleting message:', { messageId, userId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new AppError('Bạn không thuộc hội thoại này!', 403);
  }

  await dynamoDB.put({
    TableName: 'UserDeletedMessages',
    Item: { userId, messageId, timestamp: new Date().toISOString() },
  }).promise();

  io().to(userId).emit('messageDeleted', { messageId });
  return { success: true, message: 'Tin nhắn đã được xóa chỉ với bạn!' };
};

// Hàm khôi phục tin nhắn
const restoreMessage = async (userId, messageId) => {
  logger.info('Restoring message:', { messageId, userId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message.Item) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new AppError('Bạn không có quyền khôi phục tin nhắn này!', 403);
  }

  const deletedMessage = await dynamoDB.get({
    TableName: 'UserDeletedMessages',
    Key: { userId, messageId },
  }).promise();

  if (!deletedMessage.Item) {
    throw new AppError('Tin nhắn không được đánh dấu xóa!', 400);
  }

  await dynamoDB.delete({
    TableName: 'UserDeletedMessages',
    Key: { userId, messageId },
  }).promise();

  io().to(userId).emit('messageRestored', { messageId });
  return { success: true, message: 'Tin nhắn đã được khôi phục!' };
};

// Hàm cập nhật trạng thái khi kết nối
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
      Key: { messageId: message.messageId, ownerId: message.ownerId },
      UpdateExpression: 'SET #status = :delivered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':delivered': 'delivered' },
    }).promise();
    io().to(message.senderId).emit('messageStatus', { messageId: message.messageId, status: 'delivered' });
    io().to(userId).emit('receiveMessage', { ...message, status: 'delivered' });
  }
};

// Hàm lấy tóm tắt hội thoại
const getConversationSummary = async (userId, options = {}) => {
  const { minimal = false } = options;

  try {
    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();

    const conversations = result.Items || [];
    if (!conversations.length) {
      return { success: true, data: { conversationCount: 0, conversations: [] } };
    }

    const hiddenConversations = (await ConversationService.getHiddenConversations(userId)).hiddenConversations || [];
    const mutedConversations = (await ConversationService.getMutedConversations(userId)).mutedConversations || [];
    const pinnedConversations = (await ConversationService.getPinnedConversations(userId)).pinnedConversations || [];

    const conversationList = [];
    for (const conv of conversations) {
      const otherUserId = conv.targetUserId;

      if (hiddenConversations.some(hc => hc.hiddenUserId === otherUserId)) {
        continue;
      }

      let name, phoneNumber;
      if (otherUserId === userId) {
        name = 'FileCloud';
        const userResult = await dynamoDB.get({
          TableName: 'Users',
          Key: { userId },
        }).promise();
        phoneNumber = userResult.Item?.phoneNumber || null;
      } else {
        try {
          const userNameResult = await FriendService.getUserName(userId, otherUserId);
          name = userNameResult.name;
          phoneNumber = userNameResult.phoneNumber;
        } catch (error) {
          logger.error(`Lỗi lấy thông tin cho ${otherUserId}:`, error);
          name = otherUserId;
          phoneNumber = null;
        }
      }

      if (minimal) {
        conversationList.push({
          userId: otherUserId,
          isSelf: otherUserId === userId,
          name,
          phoneNumber,
        });
        continue;
      }

      const isMuted = mutedConversations.some(mc => mc.mutedUserId === otherUserId);
      const isPinned = pinnedConversations.some(pc => pc.pinnedUserId === otherUserId);

      conversationList.push({
        otherUserId,
        displayName: name,
        isSelf: otherUserId === userId,
        lastMessage: conv.lastMessage || null,
        isMuted,
        isPinned,
      });
    }

    if (!minimal) {
      conversationList.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        if (!a.lastMessage || !b.lastMessage) return 0;
        return new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt);
      });
    }

    return {
      success: true,
      data: {
        conversationCount: conversationList.length,
        conversations: conversationList,
      },
    };
  } catch (error) {
    logger.error('Lỗi trong getConversationSummary:', error);
    throw new AppError('Lỗi khi lấy tóm tắt hội thoại', 500);
  }
};

// Hàm kiểm tra quyền gửi tin nhắn
const canSendMessageToUser = async (senderId, receiverId, isForward = false) => {
  logger.info('Checking canSendMessageToUser:', { senderId, receiverId, isForward });

  if (senderId === receiverId) return true;

  await checkBlockStatus(senderId, receiverId);

  const receiverResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: receiverId },
  }).promise();

  const receiver = receiverResult.Item;
  if (!receiver) throw new AppError('Người nhận không tồn tại!', 404);

  const restrictStrangerMessages = receiver.restrictStrangerMessages;

  if (!restrictStrangerMessages) {
    if (!isForward) return true;

    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: senderId, targetUserId: receiverId },
    }).promise();
    if (conversation.Item) return true;

    throw new AppError('Chưa từng nhắn tin với người này, không thể chuyển tiếp!', 403);
  }

  const friendResult = await dynamoDB.get({
    TableName: 'Friends',
    Key: { userId: receiverId, friendId: senderId },
  }).promise();

  if (friendResult.Item) return true;

  throw new AppError('Người này không nhận tin nhắn từ người lạ!', 403);
};

// Hàm kiểm tra chặn
const checkBlockStatus = async (senderId, receiverId) => {
  const [isSenderBlocked, isReceiverBlocked] = await Promise.all([
    dynamoDB.get({
      TableName: 'BlockedUsers',
      Key: { userId: receiverId, blockedUserId: senderId },
    }).promise(),
    dynamoDB.get({
      TableName: 'BlockedUsers',
      Key: { userId: senderId, blockedUserId: receiverId },
    }).promise(),
  ]);

  if (isSenderBlocked.Item) throw new AppError('Bạn đã bị người này chặn', 403);
  if (isReceiverBlocked.Item) throw new AppError('Bạn đã chặn người này', 403);
};

// Hàm tìm kiếm tin nhắn
const searchMessagesBetweenUsers = async (userId, otherUserId, keyword) => {
  logger.info('Searching messages:', { userId, otherUserId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  try {
    const normalizedKeyword = keyword.toLowerCase().trim();

    const [senderResult, receiverResult] = await Promise.all([
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :userId AND receiverId = :otherUserId',
        FilterExpression: 'contains(#content, :keyword) AND #type = :text',
        ExpressionAttributeNames: { '#content': 'content', '#type': 'type' },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':otherUserId': otherUserId,
          ':keyword': normalizedKeyword,
          ':text': 'text',
        },
      }).promise(),
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'ReceiverSenderIndex',
        KeyConditionExpression: 'receiverId = :userId AND senderId = :otherUserId',
        FilterExpression: 'contains(#content, :keyword) AND #type = :text',
        ExpressionAttributeNames: { '#content': 'content', '#type': 'type' },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':otherUserId': otherUserId,
          ':keyword': normalizedKeyword,
          ':text': 'text',
        },
      }).promise(),
    ]);

    const matchedMessages = [...(senderResult.Items || []), ...(receiverResult.Items || [])]
      .filter(msg => msg.ownerId === userId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return { success: true, data: matchedMessages };
  } catch (error) {
    logger.error('Lỗi trong searchMessagesBetweenUsers:', error);
    throw new AppError('Lỗi khi tìm kiếm tin nhắn', 500);
  }
};

module.exports = {
  createMessage,
  getMessagesBetweenUsers,
  getConversationSummary,
  forwardMessage,
  recallMessage,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  setReminder,
  unsetReminder,
  getRemindersBetweenUsers,
  checkAndNotifyReminders,
  getReminderHistory,
  editReminder,
  deleteMessage,
  restoreMessage,
  retryMessage,
  markMessageAsSeen,
  updateMessageStatusOnConnect,
  canSendMessageToUser,
  checkBlockStatus,
  searchMessagesBetweenUsers,
};