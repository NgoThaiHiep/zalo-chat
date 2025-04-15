require('dotenv').config();
const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket');
const { isUserOnline} = require('./auth.service');
const ConversationService  = require('./conversation.service');
const FriendService = require('./friend.service');
const logger = require('../config/logger'); // Thêm Winston logger
const { validateSchema } = require('../untils/validateSchema');
const { messageSchema, reminderSchema } = require('../schemas/messageSchemas');
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
  if (!senderId || !receiverId || !messageData || !messageData.type) {
    throw new Error('senderId, receiverId hoặc messageData không hợp lệ!');
  }

  logger.info(`Creating message`, { senderId, receiverId });

  // Kiểm tra quyền gửi tin nhắn
  await canSendMessageToUser(senderId, receiverId);

  // Lấy cài đặt auto-delete
  const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
    ConversationService.getAutoDeleteSetting(senderId, receiverId),
    ConversationService.getAutoDeleteSetting(receiverId, senderId),
  ]);

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
    ? new Date(now + DAYS_TO_SECONDS[senderAutoDelete] * 1000).toISOString()
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
    ? new Date(now + DAYS_TO_SECONDS[receiverAutoDelete] * 1000).toISOString()
    : null;

  // Tạo messageId và base message
  const messageId = uuidv4();
  const baseMessage = {
    messageId,
    senderId,
    receiverId,
    ...messageData,
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

    // Lưu tin nhắn vào DynamoDB và S3
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

    // Cập nhật trạng thái dựa trên trạng thái online
    const receiverOnline = isUserOnline(receiverId);
    const initialStatus = receiverOnline ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.SENT;

    await Promise.all([
      updateMessageStatus(messageId, senderId, initialStatus),
      updateMessageStatus(messageId, receiverId, initialStatus),
    ]);

    // Xử lý transcription nếu là tin nhắn thoại
    if (messageData.type === 'voice' && messageData.metadata?.transcribe) {
      await transcribeQueue().add(
        { messageId, senderId, receiverId, tableName: 'Messages', bucketName: process.env.BUCKET_NAME_Chat_Send },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
      );
      logger.info(`Added transcribe job`, { messageId });
    }

    // Phát sự kiện socket
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

  // Lấy tin nhắn
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
  if (message.isRecalled) {
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

// Hàm thu hồi tin nhắn với mọi người
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
    const now = new Date().toISOString();
  
    // Lấy danh sách messageId bị xóa bởi user1
    const { Items: deletedMessages = [] } = await dynamoDB.scan({
      TableName: 'UserDeletedMessages',
      FilterExpression: 'userId = :user1',
      ExpressionAttributeValues: { ':user1': user1 },
    }).promise();
    const deletedMessageIds = new Set(deletedMessages.map(item => item.messageId));

    // Truy vấn tin nhắn theo hai chiều
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
    const filteredMessages = allMessages.filter(msg => 
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
      KeyConditionExpression: 'receiverId = :senderId AND messageId = :messageId',
      ExpressionAttributeValues: { ':senderId': senderId, ':messageId': messageId },
      Limit: 1,
    }).promise();
    originalMessage = tempMessage.Items?.[0];
  }

  if (!originalMessage) throw new AppError('Original message not found', 404);
  if (originalMessage.senderId !== senderId && originalMessage.receiverId !== senderId) {
    throw new AppError('Unauthorized to forward this message', 403);
  }
  if (originalMessage.isRecalled) {
    throw new AppError('Cannot forward recalled message', 400);
  }

  // Lấy cài đặt auto-delete
  const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
    ConversationService.getAutoDeleteSetting(senderId, targetReceiverId),
    ConversationService.getAutoDeleteSetting(targetReceiverId, senderId),
  ]);

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
    ? new Date(now + DAYS_TO_SECONDS[senderAutoDelete] * 1000).toISOString()
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
    ? new Date(now + DAYS_TO_SECONDS[receiverAutoDelete] * 1000).toISOString()
    : null;

  const newMessageId = uuidv4();
  let newMediaUrl = originalMessage.mediaUrl;
  let newS3Key = null;

  // Xử lý media nếu có
  if (newMediaUrl && newMediaUrl.startsWith('s3://')) {
    const bucketName = process.env.BUCKET_NAME_Chat_Send;
    const originalKey = newMediaUrl.split('/').slice(3).join('/');
    const mimeType = originalMessage.mimeType;
    const mimeTypeMap = {
      'image/jpeg': { folder: 'images', ext: 'jpg' },
      'image/png': { folder: 'images', ext: 'png' },
      // ... (giữ nguyên mimeTypeMap đầy đủ nếu có)
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
  console.log('Pinning message:', { messageId, userId });

  let message;

  // 1. Thử get theo ownerId
  try {
    const result = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
    }).promise();
    message = result.Item;
  } catch (err) {
    console.error('Lỗi get message theo ownerId:', err);
    throw err;
  }

  // 2. Nếu không có, thử query bằng index
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
          KeyConditionExpression: `${keyAttr} = :userId`,
          FilterExpression: 'messageId = :messageId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':messageId': messageId,
          },
          Limit: 1,
        }).promise();

        if (result.Items && result.Items.length > 0) {
          message = result.Items[0];
          break;
        }
      } catch (err) {
        console.error(`Lỗi truy vấn ${IndexName}:`, err);
        throw err;
      }
    }
  }

  if (!message) throw new Error('Tin nhắn không tồn tại!');
  if (message.senderId !== userId && message.receiverId !== userId) {
    throw new Error('Bạn không có quyền ghim tin nhắn này!');
  }

  if (message.isPinned) {
    throw new Error('Tin nhắn đã được ghim!');
  }

  if (message.isRecalled) {
    throw new Error('Tin nhắn đã bị thu hồi, không thể ghim!');
  }

  // 3. Kiểm tra số lượng tin nhắn ghim trong hội thoại
  const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;

  const pinnedCheckParamsSender = {
    TableName: 'Messages',
    IndexName: 'SenderReceiverIndex',
    KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
    FilterExpression: 'isPinned = :true',
    ExpressionAttributeValues: {
      ':user1': userId,
      ':user2': otherUserId,
      ':true': true,
    },
  };

  const pinnedCheckParamsReceiver = {
    TableName: 'Messages',
    IndexName: 'ReceiverSenderIndex',
    KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
    FilterExpression: 'isPinned = :true',
    ExpressionAttributeValues: {
      ':user1': userId,
      ':user2': otherUserId,
      ':true': true,
    },
  };

  try {
    const [senderResult, receiverResult] = await Promise.all([
      dynamoDB.query(pinnedCheckParamsSender).promise(),
      dynamoDB.query(pinnedCheckParamsReceiver).promise(),
    ]);

    const totalPinned = (senderResult.Items || []).length + (receiverResult.Items || []).length;

    console.log('Số tin nhắn ghim hiện tại:', totalPinned);

    if (totalPinned >= 6) {
      throw new Error('Hội thoại chỉ có thể ghim tối đa 3 tin nhắn!');
    }
  } catch (err) {
    console.error('Lỗi khi kiểm tra số lượng tin ghim:', err);
    throw err;
  }

  // 4. Cập nhật isPinned và pinnedBy cho cả hai bản ghi
  const updatePinned = (targetUserId) => {
    return dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: targetUserId },
      UpdateExpression: 'SET isPinned = :p, pinnedBy = :userId',
      ExpressionAttributeValues: { ':p': true, ':userId': userId },
      ConditionExpression: 'attribute_exists(messageId)',
    }).promise().catch(err => {
      console.error(`Lỗi update isPinned cho ${targetUserId}:`, err);
      // Không ném lỗi nếu bản ghi không tồn tại
    });
  };

  await Promise.all([
    updatePinned(userId),
    updatePinned(otherUserId),
  ]);

  // 5. Emit sự kiện
  io().to(userId).emit('messagePinned', { messageId });
  io().to(otherUserId).emit('messagePinned', { messageId });

  return { success: true, message: `Tin nhắn đã được ghim! Bởi ${userId}` };
};

const unpinMessage = async (userId, messageId) => {
  console.log('Unpinning message:', { userId, messageId });

  try {
    // 1. Truy vấn tất cả các bản ghi có messageId
    const scanParams = {
      TableName: 'Messages',
      FilterExpression: 'messageId = :mid AND isPinned = :true',
      ExpressionAttributeValues: {
        ':mid': messageId,
        ':true': true,
      },
    };

    const scanResult = await dynamoDB.scan(scanParams).promise();
    const matchedItems = scanResult.Items || [];

    if (matchedItems.length === 0) {
      return { success: false, message: 'Không tìm thấy bản ghi nào đang được ghim.' };
    }

    const updatePromises = matchedItems.map(item => {
      const updateParams = {
        TableName: 'Messages',
        Key: { messageId: item.messageId, ownerId: item.ownerId },
        UpdateExpression: 'SET isPinned = :false REMOVE pinnedBy',
        ExpressionAttributeValues: { ':false': false },
        ConditionExpression: 'attribute_exists(messageId)',
      };
      return dynamoDB.update(updateParams).promise();
    });

    // 2. Thực hiện cập nhật
    await Promise.all(updatePromises);

    // 3. Emit socket cho cả hai người
    const firstItem = matchedItems[0];
    const otherUserId = (firstItem.senderId === userId)
      ? firstItem.receiverId
      : firstItem.senderId;

    io().to(userId).emit('messageUnpinned', { messageId });
    io().to(otherUserId).emit('messageUnpinned', { messageId });

    return { success: true, message: `${userId} Đã bỏ ghim tin nhắn (cho tất cả bản ghi liên quan).` };
  } catch (err) {
    console.error('Lỗi khi bỏ ghim tin nhắn:', err);
    return { success: false, error: err.message || 'Không thể bỏ ghim tin nhắn' };
  }
};

const getPinnedMessages = async (userId, otherUserId) => {
  try {
    console.log('Lấy tin nhắn ghim của:', { userId, otherUserId });

    const baseQueryParams = {
      TableName: 'Messages',
      FilterExpression: 'isPinned = :p AND isRecalled = :false AND ownerId = :userId',
      ExpressionAttributeValues: {
        ':p': true,
        ':false': false,
        ':user1': userId,
        ':user2': otherUserId,
        ':userId': userId,
      },
      Limit: 100,
      ScanIndexForward: false,
    };

    const paramsSenderReceiver = {
      ...baseQueryParams,
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
    };

    const paramsReceiverSender = {
      ...baseQueryParams,
      IndexName: 'ReceiverSenderIndex',
      KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
    };

    const [result1, result2] = await Promise.all([
      dynamoDB.query(paramsSenderReceiver).promise().catch(err => {
        console.error('Lỗi truy vấn SR:', err);
        return { Items: [] };
      }),
      dynamoDB.query(paramsReceiverSender).promise().catch(err => {
        console.error('Lỗi truy vấn RS:', err);
        return { Items: [] };
      }),
    ]);

    const all = [...(result1.Items || []), ...(result2.Items || [])];

    // Lọc và sắp xếp theo timestamp giảm dần, lấy 3 bản ghi gần nhất
    const pinnedMessages = all
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 3);

    return { success: true, messages: pinnedMessages };
  } catch (err) {
    console.error('Lỗi khi lấy tin nhắn ghim:', err);
    return { success: false, error: err.message || 'Không thể lấy tin nhắn ghim' };
  }
};

// Hàm đặt nhắc nhở
const setReminder = async (userId, messageId, reminder, scope = 'both', reminderContent, repeat = 'none', daysOfWeek) => {
  console.log('Setting reminder for message:', { messageId, userId, reminder, scope, reminderContent, repeat, daysOfWeek });

  // Kiểm tra thời gian nhắc nhở hợp lệ
  const now = new Date().toISOString();
  if (reminder && reminder <= now) {
    throw new Error('Thời gian nhắc nhở phải ở tương lai!');
  }

  // Kiểm tra scope hợp lệ
  if (!['onlyMe', 'both'].includes(scope)) {
    throw new Error('Phạm vi nhắc nhở phải là "onlyMe" hoặc "both"!');
  }

  // Kiểm tra repeat hợp lệ
  const validRepeatTypes = ['none', 'daily', 'weekly', 'multipleDaysWeekly', 'monthly', 'yearly'];
  if (!validRepeatTypes.includes(repeat)) {
    throw new Error('Loại lặp lại không hợp lệ! Chấp nhận: none, daily, weekly, multipleDaysWeekly, monthly, yearly');
  }

  // Kiểm tra daysOfWeek nếu repeat là multipleDaysWeekly
  if (repeat === 'multipleDaysWeekly') {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      throw new Error('daysOfWeek phải là một mảng không rỗng khi lặp lại nhiều ngày trong tuần!');
    }
    if (!daysOfWeek.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
      throw new Error('daysOfWeek phải chứa các số nguyên từ 1 đến 7!');
    }
  } else if (daysOfWeek) {
    throw new Error('daysOfWeek chỉ được cung cấp khi repeat là multipleDaysWeekly!');
  }

  // Lấy tin nhắn
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise().catch(err => {
    console.error('Error getting message in setReminder:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.isRecalled) {
    throw new Error('Tin nhắn đã bị thu hồi, không thể đặt nhắc nhở!');
  }

  // Xác định senderId và receiverId
  const senderId = message.Item.senderId;
  const receiverId = message.Item.receiverId;

  // Kiểm tra quyền
  if (userId !== senderId && userId !== receiverId) {
    throw new Error('Bạn không có quyền đặt nhắc nhở cho tin nhắn này!');
  }

  // Xác định otherUserId
  const otherUserId = userId === senderId ? receiverId : senderId;

  // Xác định nội dung nhắc nhở
  const finalReminderContent = reminderContent || 
                              (message.Item.type === 'text' && message.Item.content ? 
                               message.Item.content : 
                               `Nhắc nhở cho tin nhắn ${messageId}`);

  // Chuẩn bị update expression
  let updateExpression = 'SET reminder = :r, reminderScope = :s, reminderContent = :rc, repeatType = :rt';
  let expressionAttributeValues = {
    ':r': reminder,
    ':s': scope,
    ':rc': finalReminderContent,
    ':rt': repeat,
  };

  // Xử lý daysOfWeek nếu có
  if (repeat === 'multipleDaysWeekly' && daysOfWeek) {
    updateExpression += ', daysOfWeek = :dow';
    expressionAttributeValues[':dow'] = daysOfWeek;
  } else {
    updateExpression += ' REMOVE daysOfWeek'; // Xóa daysOfWeek nếu không áp dụng
  }

  // Cập nhật nhắc nhở chỉ cho userId
  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
  }).promise().catch(err => {
    console.error(`Error updating reminder for ${userId}:`, err);
    throw err;
  });

  // Phát sự kiện Socket.IO
  const reminderData = { 
    messageId, 
    reminder, 
    scope, 
    reminderContent: finalReminderContent, 
    repeatType: repeat, 
    daysOfWeek: repeat === 'multipleDaysWeekly' ? daysOfWeek : undefined, 
    setBy: userId 
  };
  io().to(userId).emit('reminderSet', reminderData);
  if (scope === 'both') {
    io().to(otherUserId).emit('reminderSet', reminderData);
  }

  return { success: true, message: 'Đã đặt nhắc nhở!' };
};

const unsetReminder = async (userId, messageId) => {
  console.log('Unsetting reminder for message:', { messageId, userId });

  // Lấy tin nhắn
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise().catch(err => {
    console.error('Error getting message in unsetReminder:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (!message.Item.reminder) {
    throw new Error('Tin nhắn này chưa có nhắc nhở để xóa!');
  }

  // Xác định senderId và receiverId
  const senderId = message.Item.senderId;
  const receiverId = message.Item.receiverId;

  // Kiểm tra quyền
  if (userId !== senderId && userId !== receiverId) {
    throw new Error('Bạn không có quyền xóa nhắc nhở cho tin nhắn này!');
  }

  // Xác định otherUserId
  const otherUserId = userId === senderId ? receiverId : senderId;
  const scope = message.Item.reminderScope || 'both';

  // Xóa nhắc nhở
  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: 'REMOVE reminder, reminderScope, reminderContent, repeatType, daysOfWeek',
  }).promise().catch(err => {
    console.error(`Error unsetting reminder for ${userId}:`, err);
    throw err;
  });

  // Phát sự kiện Socket.IO
  io().to(userId).emit('reminderUnset', { messageId, unsetBy: userId });
  if (scope === 'both') {
    io().to(otherUserId).emit('reminderUnset', { messageId, unsetBy: userId });
  }

  return { success: true, message: 'Đã xóa nhắc nhở!' };
};

const getRemindersBetweenUsers = async (userId, otherUserId) => {
  console.log('Getting reminders between users:', { userId, otherUserId });

  const now = new Date().toISOString();

  // Lấy nhắc nhở của userId
  const userReminders = await dynamoDB.query({
    TableName: 'Messages',
    IndexName: 'OwnerReminderIndex',
    KeyConditionExpression: 'ownerId = :userId AND reminder >= :now',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':now': now,
    },
  }).promise().catch(err => {
    console.error('Error querying reminders for userId:', err);
    throw err;
  });

  // Lấy nhắc nhở của otherUserId với scope = both
  const otherUserReminders = await dynamoDB.query({
    TableName: 'Messages',
    IndexName: 'OwnerReminderIndex',
    KeyConditionExpression: 'ownerId = :otherUserId AND reminder >= :now',
    ExpressionAttributeValues: {
      ':otherUserId': otherUserId,
      ':now': now,
    },
  }).promise().catch(err => {
    console.error('Error querying reminders for otherUserId:', err);
    throw err;
  });

  // Lọc và gộp kết quả
  const reminders = [];

  // Thêm nhắc nhở của userId
  if (userReminders.Items) {
    reminders.push(...userReminders.Items.filter(msg => 
      (msg.senderId === userId && msg.receiverId === otherUserId) ||
      (msg.senderId === otherUserId && msg.receiverId === userId)
    ).map(msg => ({
      messageId: msg.messageId,
      reminder: msg.reminder,
      scope: msg.reminderScope,
      reminderContent: msg.reminderContent,
      repeatType: msg.repeatType,
      daysOfWeek: msg.daysOfWeek,
      setBy: msg.ownerId,
    })));
  }

  // Thêm nhắc nhở của otherUserId với scope = both
  if (otherUserReminders.Items) {
    reminders.push(...otherUserReminders.Items.filter(msg => 
      msg.reminderScope === 'both' &&
      ((msg.senderId === userId && msg.receiverId === otherUserId) ||
       (msg.senderId === otherUserId && msg.receiverId === userId))
    ).map(msg => ({
      messageId: msg.messageId,
      reminder: msg.reminder,
      scope: msg.reminderScope,
      reminderContent: msg.reminderContent,
      repeatType: msg.repeatType,
      daysOfWeek: msg.daysOfWeek,
      setBy: msg.ownerId,
    })));
  }

  return { success: true, reminders };
};

const checkAndNotifyReminders = async () => {
  const now = new Date();
  const messages = await dynamoDB.scan({
    TableName: 'Messages',
    FilterExpression: 'reminder <= :now',
    ExpressionAttributeValues: { ':now': now.toISOString() },
  }).promise().catch(err => {
    console.error('Error scanning reminders:', err);
    throw err;
  });

  for (const msg of messages.Items) {
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
          const currentDay = now.getDay() || 7; // 1-7
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

    // Gửi thông báo
    io().to(msg.ownerId).emit('reminderTriggered', { 
      messageId: msg.messageId, 
      reminderContent: msg.reminderContent 
    });
    if (msg.reminderScope === 'both') {
      const otherUserId = msg.senderId === msg.ownerId ? msg.receiverId : msg.senderId;
      io().to(otherUserId).emit('reminderTriggered', { 
        messageId: msg.messageId, 
        reminderContent: msg.reminderContent 
      });
    }

    // Cập nhật hoặc xóa nhắc nhở
    if (newReminder) {
      await dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: msg.messageId, ownerId: msg.ownerId },
        UpdateExpression: 'SET reminder = :r',
        ExpressionAttributeValues: { ':r': newReminder },
      }).promise().catch(err => {
        console.error('Error updating reminder:', err);
        throw err;
      });
    } else {
      await dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: msg.messageId, ownerId: msg.ownerId },
        UpdateExpression: 'REMOVE reminder, reminderScope, reminderContent, repeatType, daysOfWeek',
      }).promise().catch(err => {
        console.error('Error removing reminder:', err);
        throw err;
      });
    }

    // Ghi log
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
    }).promise().catch(err => {
      console.error('Error logging reminder:', err);
      throw err;
    });
  }
};

const getReminderHistory = async (userId, otherUserId) => {
  console.log('Getting reminder history between users:', { userId, otherUserId });

  // Lấy lịch sử nhắc nhở
  const logs = await dynamoDB.scan({
    TableName: 'ReminderLogs',
    FilterExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId,
    },
  }).promise().catch(err => {
    console.error('Error scanning reminder logs:', err);
    throw err;
  });

  // Lọc lịch sử liên quan đến otherUserId
  const history = [];
  if (logs.Items) {
    for (const log of logs.Items) {
      const message = await dynamoDB.get({
        TableName: 'Messages',
        Key: { messageId: log.messageId, ownerId: userId },
      }).promise().catch(err => {
        console.error('Error getting message for log:', err);
        return null;
      });

      if (message.Item &&
          ((message.Item.senderId === userId && message.Item.receiverId === otherUserId) ||
           (message.Item.senderId === otherUserId && message.Item.receiverId === userId))) {
        history.push({
          logId: log.logId,
          messageId: log.messageId,
          reminder: log.reminder,
          reminderContent: log.reminderContent,
          timestamp: log.timestamp,
        });
      }
    }
  }

  return { success: true, history };
};

const editReminder = async (userId, messageId, reminder, scope, reminderContent, repeat, daysOfWeek) => {
  console.log('Editing reminder for message:', { messageId, userId, reminder, scope, reminderContent, repeat, daysOfWeek });

  // Kiểm tra thời gian nhắc nhở hợp lệ
  const now = new Date().toISOString();
  if (reminder && reminder <= now) {
    throw new Error('Thời gian nhắc nhở phải ở tương lai!');
  }

  // Kiểm tra scope nếu được cung cấp
  if (scope && !['onlyMe', 'both'].includes(scope)) {
    throw new Error('Phạm vi nhắc nhở phải là "onlyMe" hoặc "both"!');
  }

  // Kiểm tra repeat nếu được cung cấp
  const validRepeatTypes = ['none', 'daily', 'weekly', 'multipleDaysWeekly', 'monthly', 'yearly'];
  if (repeat && !validRepeatTypes.includes(repeat)) {
    throw new Error('Loại lặp lại không hợp lệ! Chấp nhận: none, daily, weekly, multipleDaysWeekly, monthly, yearly');
  }

  // Kiểm tra daysOfWeek nếu repeat là multipleDaysWeekly
  if (repeat === 'multipleDaysWeekly') {
    if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
      throw new Error('daysOfWeek phải là một mảng không rỗng khi lặp lại nhiều ngày trong tuần!');
    }
    if (!daysOfWeek.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
      throw new Error('daysOfWeek phải chứa các số nguyên từ 1 đến 7!');
    }
  } else if (daysOfWeek && repeat !== 'multipleDaysWeekly') {
    throw new Error('daysOfWeek chỉ được cung cấp khi repeat là multipleDaysWeekly!');
  }

  // Lấy tin nhắn
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise().catch(err => {
    console.error('Error getting message in editReminder:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.isRecalled) {
    throw new Error('Tin nhắn đã bị thu hồi, không thể chỉnh sửa nhắc nhở!');
  }
  if (!message.Item.reminder) {
    throw new Error('Tin nhắn này chưa có nhắc nhở để chỉnh sửa!');
  }

  // Xác định senderId và receiverId
  const senderId = message.Item.senderId;
  const receiverId = message.Item.receiverId;

  // Kiểm tra quyền
  if (userId !== senderId && userId !== receiverId) {
    throw new Error('Bạn không có quyền chỉnh sửa nhắc nhở cho tin nhắn này!');
  }

  // Xác định otherUserId
  const otherUserId = userId === senderId ? receiverId : senderId;

  // Xác định nội dung nhắc nhở
  const finalReminderContent = reminderContent !== undefined ? 
                              (reminderContent || 
                               (message.Item.type === 'text' && message.Item.content ? 
                                message.Item.content : 
                                `Nhắc nhở cho tin nhắn ${messageId}`)) : 
                              message.Item.reminderContent;

  // Chuẩn bị update expression
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

  // Cập nhật nhắc nhở
  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
  }).promise().catch(err => {
    console.error(`Error updating reminder for ${userId}:`, err);
    throw err;
  });

  // Lấy scope hiện tại nếu không cung cấp scope mới
  const finalScope = scope || message.Item.reminderScope || 'both';
  const finalRepeat = repeat || message.Item.repeatType || 'none';
  const finalDaysOfWeek = repeat === 'multipleDaysWeekly' ? daysOfWeek : 
                          (repeat && repeat !== 'multipleDaysWeekly' ? undefined : message.Item.daysOfWeek);

  // Phát sự kiện Socket.IO
  const reminderData = { 
    messageId, 
    reminder, 
    scope: finalScope, 
    reminderContent: finalReminderContent, 
    repeatType: finalRepeat, 
    daysOfWeek: finalDaysOfWeek, 
    setBy: userId 
  };
  io().to(userId).emit('reminderEdited', reminderData);
  if (finalScope === 'both') {
    io().to(otherUserId).emit('reminderEdited', reminderData);
  }

  return { success: true, message: 'Đã chỉnh sửa nhắc nhở!' };
};

// Hàm xóa tin nhắn chỉ với bạn
const deleteMessage = async (userId, messageId) => {
  console.log('Deleting message:', { messageId, userId});

  // Lấy bản ghi tin nhắn
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise().catch(err => {
    console.error('Error getting message in deleteMessage:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
 
  // Kiểm tra xem userId là senderId hoặc receiverId
  if (message.Item.senderId !== userId && message.Item.receiverId !== userId) {
    throw new Error('Bạn không thuộc hội thoại này!');
  }
      await dynamoDB.put({
        TableName: 'UserDeletedMessages',
        Item: { userId, messageId, timestamp: new Date().toISOString() },
      }).promise().catch(err => {
        console.error('Error putting to UserDeletedMessages:', err);
        throw err;
      });
      io().to(userId).emit('messageDeleted', { messageId });
    return { success: true, message: 'Tin nhắn đã được xóa chỉ với bạn!' };
  
};

// Hàm khôi phục tin nhắn
const restoreMessage = async (senderId, messageId) => {
  console.log('Restoring message:', { messageId, senderId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise().catch(err => {
    console.error('Error getting message in restoreMessage:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại hoặc đã bị xóa hoàn toàn!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền khôi phục tin nhắn này!');

  await dynamoDB.delete({
    TableName: 'UserDeletedMessages',
    Key: { userId: senderId, messageId },
  }).promise().catch(err => {
    console.error('Error deleting from UserDeletedMessages:', err);
    throw err;
  });

  io().to(senderId).emit('messageRestored', { messageId });
  return { success: true, message: 'Tin nhắn đã được khôi phục!' };
};

// Hàm cập nhật trạng thái tin nhắn khi kết nối
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
    }).promise().catch(err => {
      console.error('Error updating status in updateMessageStatusOnConnect:', err);
    });
    io().to(message.senderId).emit('messageStatus', { messageId: message.messageId, status: 'delivered' });
    io().to(userId).emit('receiveMessage', { ...message, status: 'delivered' });
  }
};

// Hàm lấy danh sách người đã nhắn tin
const getConversationSummary = async (userId, options = {}) => {
  const { minimal = false } = options;

  try {
    // Bước 1: Lấy tất cả tin nhắn liên quan đến userId
    const conversations = await dynamoDB.scan({
      TableName: 'Messages',
      FilterExpression: 'senderId = :userId OR receiverId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();

    if (!conversations.Items || conversations.Items.length === 0) {
      return {
        success: true,
        data: {
          conversationCount: 0,
          conversations: [],
        },
      };
    }

    // Bước 2: Nhóm tin nhắn theo hội thoại (otherUserId)
    const conversationMap = new Map();
    conversations.Items.forEach((msg) => {
      const otherUserId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!conversationMap.has(otherUserId)) {
        conversationMap.set(otherUserId, []);
      }
      conversationMap.get(otherUserId).push(msg);
    });

    // Bước 3: Lấy danh sách hội thoại ẩn
    const hiddenConversationsResult = await ConversationService.getHiddenConversations(userId);
    const hiddenConversations = Array.isArray(hiddenConversationsResult.hiddenConversations)
      ? hiddenConversationsResult.hiddenConversations
      : [];

    // Bước 4: Xử lý danh sách hội thoại
    const conversationList = [];
    for (const [otherUserId, messages] of conversationMap) {
      // Kiểm tra hội thoại ẩn
      if (hiddenConversations.some((hc) => hc.hiddenUserId === otherUserId)) {
        continue;
      }

      // Lấy thông tin tên và số điện thoại
      let name, phoneNumber;
      if (otherUserId === userId) {
        name = 'FileCloud';
        // Lấy phoneNumber của chính userId
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
          console.error(`Lỗi lấy thông tin cho ${otherUserId}:`, error);
          name = otherUserId;
          phoneNumber = null;
        }
      }

      // Nếu minimal = true, trả về thông tin cơ bản
      if (minimal) {
        conversationList.push({
          userId: otherUserId,
          isSelf: otherUserId === userId,
          name,
          phoneNumber,
        });
        continue;
      }

      // Lấy tin nhắn cuối cùng
      const lastMessage = messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      // Lấy trạng thái mute
      const mutedConversationsResult = await ConversationService.getMutedConversations(userId);
      const mutedConversations = Array.isArray(mutedConversationsResult.mutedConversations)
        ? mutedConversationsResult.mutedConversations
        : [];
      const muteStatus = mutedConversations.find((mc) => mc.mutedUserId === otherUserId);
      const isMuted = muteStatus ? muteStatus.duration !== 'off' : false;

      // Lấy trạng thái ghim
      const pinnedConversationsResult = await ConversationService.getPinnedConversations(userId);
      const pinnedConversations = Array.isArray(pinnedConversationsResult.pinnedConversations)
        ? pinnedConversationsResult.pinnedConversations
        : [];
      const isPinned = pinnedConversations.some((pc) => pc.pinnedUserId === otherUserId);

      conversationList.push({
        otherUserId,
        displayName: name,
        isSelf: otherUserId === userId,
        lastMessage: {
          messageId: lastMessage.messageId,
          senderId: lastMessage.senderId,
          receiverId: lastMessage.receiverId,
          type: lastMessage.type,
          content: lastMessage.content || null,
          timestamp: lastMessage.timestamp,
        },
        isMuted,
        isPinned,
      });
    }

    // Sắp xếp hội thoại (chỉ khi không minimal)
    if (!minimal) {
      conversationList.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp);
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
    console.error('Lỗi trong getConversationSummary:', error);
    return {
      success: false,
      error: error.message || 'Lỗi khi lấy tóm tắt hội thoại',
    };
  }
};

// Hàm kiểm tra quyền gửi tin nhắn
const canSendMessageToUser = async (senderId, receiverId, isForward = false) => {
  console.log('Checking canSendMessageToUser:', { senderId, receiverId, isForward });

  if (senderId === receiverId) return true;

  await checkBlockStatus(senderId, receiverId);

  const receiverResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: receiverId },
  }).promise();

  const receiver = receiverResult.Item;
  if (!receiver) throw new Error('Người nhận không tồn tại!');

  const restrictStrangerMessages = receiver.restrictStrangerMessages;

  if (!restrictStrangerMessages) {
    if (!isForward) return true;

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

  const friendResult = await dynamoDB.get({
    TableName: 'Friends',
    Key: { userId: receiverId, friendId: senderId },
  }).promise();

  if (friendResult.Item) return true;

  throw new Error('Người này không nhận tin nhắn từ người lạ!');
};

const checkBlockStatus = async (senderId, receiverId) => {
  if (await isBlocked(receiverId, senderId)) {
    throw new Error('Bạn đã bị người này chặn');
  }
  if (await isBlocked(senderId, receiverId)) {
    throw new Error('Bạn đã chặn người này');
  }
};

// Hàm kiểm tra chặn
const isBlocked = async (blockerId, blockedId) => {
  const result = await dynamoDB.get({
    TableName: 'BlockedUsers',
    Key: { userId: blockerId, blockedUserId: blockedId },
  }).promise();
  return !!result.Item;
};

const searchMessagesBetweenUsers = async (userId, otherUserId, keyword) => {
  try {
    // Chuẩn hóa từ khóa: loại bỏ khoảng trắng thừa, chuyển về chữ thường
    const normalizedKeyword = keyword.toLowerCase().trim();

    // Truy vấn tin nhắn giữa hai người dùng
    const params = {
      TableName: 'Messages',
      FilterExpression:
        '(senderId = :userId AND receiverId = :otherUserId) OR (senderId = :otherUserId AND receiverId = :userId)',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':otherUserId': otherUserId,
      },
    };

    const result = await dynamoDB.scan(params).promise();
    if (!result.Items || result.Items.length === 0) {
      return { success: true, data: [] };
    }

    // Lọc tin nhắn theo từ khóa (chỉ áp dụng cho type = 'text')
    const matchedMessages = result.Items.filter((msg) => {
      if (msg.type !== 'text' || !msg.content) return false;
      return msg.content.toLowerCase().includes(normalizedKeyword);
    });

    // Sắp xếp theo timestamp (mới nhất trước)
    matchedMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      success: true,
      data: matchedMessages,
    };
  } catch (error) {
    console.error('Lỗi trong searchMessagesBetweenUsers:', error);
    return {
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm tin nhắn',
    };
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
  searchMessagesBetweenUsers
};