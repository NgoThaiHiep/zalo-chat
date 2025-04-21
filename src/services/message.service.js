require('dotenv').config();
const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket');
const { isUserOnline ,getActiveOwnerIds} = require('./auth.service');
const {getHiddenConversations,getMutedConversations,getPinnedConversations, createConversation,getAutoDeleteSetting}= require('./conversation.service');
const FriendService = require('./friend.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');
const { redisClient } = require('../config/redis');
const bcrypt = require('bcrypt');
const isValidUUID = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const {
  copyS3File,
  getInitialStatus,
  addTranscribeJob,
} = require('../utils/messageUtils');

const {
  MESSAGE_STATUSES,
  DAYS_TO_SECONDS,
} = require('../config/constants');


const createMessage = async (senderId, receiverId, messageData) => {
  if (!senderId || !receiverId || !messageData) {
    throw new AppError('senderId, receiverId hoặc messageData không hợp lệ!', 400);
  }

  logger.info(`Creating message`, { senderId, receiverId });

  const { canSend, isRestricted } = await canSendMessageToUser(senderId, receiverId);
  if (!canSend) throw new AppError('Không có quyền gửi tin nhắn!', 403);

  const conversation = await dynamoDB
    .get({
      TableName: 'Conversations',
      Key: { userId: senderId, targetUserId: receiverId },
    })
    .promise();
  if (!conversation.Item) {
    await createConversation(senderId, receiverId);
  }

  const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
    getAutoDeleteSetting(senderId, receiverId),
    getAutoDeleteSetting(receiverId, senderId),
  ]);

  const now = Date.now();
  const senderExpiresAt =
    senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
      ? Math.floor(now / 1000) + DAYS_TO_SECONDS[senderAutoDelete]
      : null;
  const receiverExpiresAt =
    receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
      ? Math.floor(now / 1000) + DAYS_TO_SECONDS[receiverAutoDelete]
      : null;

  const messageId = uuidv4();
  const baseMessage = {
    messageId,
    senderId,
    receiverId,
    type: messageData.type || null,
    content: messageData.content || null,
    mediaUrl: messageData.mediaUrl || null,
    fileName: messageData.fileName || null,
    mimeType: messageData.mimeType || null,
    metadata: messageData.metadata || {},
    replyToMessageId: messageData.replyToMessageId || null,
    status: MESSAGE_STATUSES.PENDING,
    timestamp: new Date().toISOString(),
  };

  const senderMessage = buildMessageRecord(baseMessage, senderId, senderExpiresAt);
  const receiverMessage =
    senderId === receiverId ? null : buildMessageRecord(baseMessage, receiverId, receiverExpiresAt);

  io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.PENDING });

  let senderResult = null;
  let receiverResult = null;

  try {
    logger.info('Sending messages to DynamoDB', { messageId, senderId, receiverId });

    [senderResult, receiverResult] = await Promise.all([
      sendMessageCore(
        { ...senderMessage, file: messageData.file, quality: messageData.quality },
        'Messages',
        process.env.BUCKET_NAME_Chat_Send
      ),
      receiverMessage
        ? sendMessageCore(
            { ...receiverMessage, file: messageData.file, quality: messageData.quality },
            'Messages',
            process.env.BUCKET_NAME_Chat_Send
          )
        : null,
    ]);

    if (!senderResult || (receiverMessage && !receiverResult)) {
      throw new AppError('Không thể lưu tin nhắn vào DynamoDB', 500);
    }

    await updateConversations(senderId, receiverId, messageId, baseMessage.timestamp, {
      content: baseMessage.content,
      senderId: baseMessage.senderId,
      type: baseMessage.type,
    });

    const initialStatus = getInitialStatus(isRestricted, isUserOnline(receiverId), senderId === receiverId);

    await Promise.all([
      updateMessageStatus(messageId, senderId, initialStatus),
      receiverMessage && updateMessageStatus(messageId, receiverId, initialStatus),
    ]);

    if (messageData.type === 'voice' && messageData.metadata?.transcribe) {
      logger.info('Adding transcribe job', { messageId });
      await addTranscribeJob(
        messageId,
        senderId,
        'Messages',
        process.env.BUCKET_NAME_Chat_Send,
        senderResult.mediaUrl,
        `voice-${messageId}-${senderId}`
      );
    }

    // Emit message với đúng mediaUrl
    io().to(senderId).emit('receiveMessage', { ...senderResult, status: initialStatus });
    if (senderId !== receiverId && isUserOnline(receiverId) && !isRestricted) {
      io().to(receiverId).emit('receiveMessage', { ...receiverResult, status: initialStatus });
    }

    logger.info('Message created successfully', { messageId });

    // Trả về bản ghi có mediaUrl
    return { ...senderResult, status: initialStatus };
  } catch (error) {
    await Promise.allSettled([
      senderResult?.mediaUrl &&
        deleteS3Object(
          process.env.BUCKET_NAME_Chat_Send,
          senderResult.mediaUrl.split('/').slice(3).join('/')
        ),
      receiverResult?.mediaUrl &&
        deleteS3Object(
          process.env.BUCKET_NAME_Chat_Send,
          receiverResult.mediaUrl.split('/').slice(3).join('/')
        ),
      updateMessageStatus(messageId, senderId, MESSAGE_STATUSES.FAILED),
      receiverResult && updateMessageStatus(messageId, receiverId, MESSAGE_STATUSES.FAILED),
    ]);

    io().to(senderId).emit('messageStatus', { messageId, status: MESSAGE_STATUSES.FAILED });
    logger.error(`Error creating message`, { messageId, error: error.message, stack: error.stack });
    throw new AppError(`Không thể gửi tin nhắn: ${error.message}`, 500);
  }
};

const updateConversations = async (senderId, receiverId, messageId, timestamp, messageData) => {
  const { content, senderId: msgSenderId, type, isRecalled = false } = messageData;

  const lastMessageData = {
    messageId,
    content: content || (type === 'image' ? '[Hình ảnh]' : `[${type}]`),
    createdAt: timestamp,
    senderId: msgSenderId,
    type,
    isRecalled,
  };

  const updatePromises = [
    dynamoDB
      .update({
        TableName: 'Conversations',
        Key: { userId: senderId, targetUserId: receiverId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': lastMessageData,
          ':time': timestamp,
        },
      })
      .promise(),
  ];

  if (senderId !== receiverId) {
    updatePromises.push(
      dynamoDB
        .update({
          TableName: 'Conversations',
          Key: { userId: receiverId, targetUserId: senderId },
          UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
          ExpressionAttributeValues: {
            ':msg': lastMessageData,
            ':time': timestamp,
          },
        })
        .promise()
    );
  }

  await Promise.all(updatePromises);
};

const buildMessageRecord = (baseMessage, ownerId, expiresAt) => ({
  ...baseMessage,
  ownerId,
  expiresAt,
});

const updateMessageStatus = async (messageId, ownerId, status, tableName = 'Messages') => {
  try {
    await dynamoDB
      .update({
        TableName: tableName,
        Key: { messageId, ownerId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status },
      })
      .promise();
    logger.info(`Updated message status`, { messageId, ownerId, status });
  } catch (error) {
    logger.error(`Failed to update message status`, { messageId, ownerId, status, error: error.message });
    throw new AppError(`Không thể cập nhật trạng thái tin nhắn: ${error.message}`, 500);
  }
};

const deleteS3Object = async (bucket, key) => {
  if (!key) return;
  try {
    await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
    logger.info(`Deleted S3 object`, { bucket, key });
  } catch (error) {
    logger.error(`Failed to delete S3 object`, { bucket, key, error: error.message });
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
  if (message.status === MESSAGE_STATUSES.RECALLED) throw new AppError('Cannot retry recalled message', 400);

  const deletedMessage = await dynamoDB.get({
    TableName: 'UserDeletedMessages',
    Key: { userId: senderId, messageId },
  }).promise();

  if (deletedMessage.Item) {
    const deletionTime = new Date(deletedMessage.Item.timestamp);
    const now = new Date();
    const timeDiffSeconds = (now - deletionTime) / 1000;
    if (timeDiffSeconds > 60) {
      throw new AppError('Cannot retry deleted message after 60 seconds', 400);
    }
  }

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

    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: senderId, targetUserId: savedMessage.receiverId },
    }).promise();

    const lastMessageId = conversation.Item?.lastMessage?.messageId;
    let shouldUpdateLastMessage = !lastMessageId;

    if (lastMessageId) {
      const lastMessage = await dynamoDB.get({
        TableName: 'Messages',
        Key: { messageId: lastMessageId, ownerId: senderId },
      }).promise();
      shouldUpdateLastMessage =
        !lastMessage.Item || new Date(savedMessage.timestamp) > new Date(lastMessage.Item.timestamp);
    }

    if (shouldUpdateLastMessage) {
      const lastMessageData = {
        messageId: savedMessage.messageId,
        content:
          savedMessage.content ||
          (savedMessage.type === 'image' ? '[Hình ảnh]' : `[${savedMessage.type}]`),
        createdAt: savedMessage.timestamp,
        senderId: savedMessage.senderId,
        type: savedMessage.type,
        isRecalled: false,
      };

      await Promise.all([
        dynamoDB.update({
          TableName: 'Conversations',
          Key: { userId: senderId, targetUserId: savedMessage.receiverId },
          UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
          ExpressionAttributeValues: {
            ':msg': lastMessageData,
            ':time': new Date().toISOString(),
          },
        }).promise(),
        dynamoDB.update({
          TableName: 'Conversations',
          Key: { userId: savedMessage.receiverId, targetUserId: senderId },
          UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
          ExpressionAttributeValues: {
            ':msg': lastMessageData,
            ':time': new Date().toISOString(),
          },
        }).promise(),
      ]);
    }

    if (receiverOnline) {
      io().to(savedMessage.receiverId).emit('receiveMessage', { ...savedMessage, status: newStatus });
    }
    io().to(senderId).emit('messageStatus', { messageId, status: newStatus });

    if (deletedMessage.Item) {
      await dynamoDB.delete({
        TableName: 'UserDeletedMessages',
        Key: { userId: senderId, messageId },
      }).promise();
    }

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
  }receiveMessage

  io().to(message.senderId).emit('messageStatus', { messageId, status: newStatus });
  io().to(userId).emit('messageStatus', { messageId, status: newStatus });

  return { message: `Message status updated to ${newStatus}` };
};

// Hàm thu hồi tin nhắn
const recallMessage = async (userId, messageId) => {
  logger.info(`Recalling message`, { messageId, userId });

  const { Item: message } = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();

  if (!message) throw new AppError('Không tìm thấy tin nhắn', 404);
  if (message.status === MESSAGE_STATUSES.RECALLED) throw new AppError('Tin nhắn đã bị thu hồi', 400);
  if (message.senderId !== userId && message.receiverId !== userId)
    throw new AppError('Unauthorized to recall this message', 403);

  const timeDiffHours = (new Date() - new Date(message.timestamp)) / (1000 * 60 * 60);
  if (timeDiffHours > 24) throw new AppError('Cannot recall message after 24 hours', 400);

  try {
    await Promise.all([
      updateMessageStatus(messageId, message.senderId, MESSAGE_STATUSES.RECALLED),
      updateMessageStatus(messageId, message.receiverId, MESSAGE_STATUSES.RECALLED),
    ]);

    if (message.mediaUrl) {
      const key = message.mediaUrl.split('/').slice(3).join('/');
      await deleteS3Object(process.env.BUCKET_NAME_Chat_Send, key);
    }

    const [senderConv, receiverConv] = await Promise.all([
      dynamoDB.get({
        TableName: 'Conversations',
        Key: { userId: message.senderId, targetUserId: message.receiverId },
      }).promise(),
      dynamoDB.get({
        TableName: 'Conversations',
        Key: { userId: message.receiverId, targetUserId: message.senderId },
      }).promise(),
    ]);

    const isLastMessageSender = senderConv.Item?.lastMessage?.messageId === messageId;
    const isLastMessageReceiver = receiverConv.Item?.lastMessage?.messageId === messageId;

    if (isLastMessageSender || isLastMessageReceiver) {
      const lastMessageUpdate = {
        messageId: message.messageId,
        content: message.content || (message.type === 'image' ? '[Hình ảnh]' : `[${message.type}]`),
        createdAt: message.timestamp,
        senderId: message.senderId,
        type: message.type,
        isRecalled: true,
      };

      await Promise.all([
        isLastMessageSender &&
          dynamoDB.update({
            TableName: 'Conversations',
            Key: { userId: message.senderId, targetUserId: message.receiverId },
            UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
            ExpressionAttributeValues: {
              ':msg': lastMessageUpdate,
              ':time': new Date().toISOString(),
            },
          }).promise(),
        isLastMessageReceiver &&
          dynamoDB.update({
            TableName: 'Conversations',
            Key: { userId: message.receiverId, targetUserId: message.senderId },
            UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
            ExpressionAttributeValues: {
              ':msg': lastMessageUpdate,
              ':time': new Date().toISOString(),
            },
          }).promise(),
      ]);
    }

    io().to(message.receiverId).emit('messageRecalled', { messageId });
    io().to(message.senderId).emit('messageRecalled', { messageId });

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

    // Kiểm tra trạng thái bạn bè và cài đặt restrictStrangerMessages
    let isFriend = true;
    let restrictStrangerMessages = false;
    if (user1 !== user2) {
      const [friendResult, userResult] = await Promise.all([
        dynamoDB.get({
          TableName: 'Friends',
          Key: { userId: user1, friendId: user2 },
        }).promise(),
        dynamoDB.get({
          TableName: 'Users',
          Key: { userId: user1 },
        }).promise(),
      ]);
      isFriend = !!friendResult.Item;
      restrictStrangerMessages = userResult.Item?.settings?.restrictStrangerMessages || false;
    }

    // Nếu bật restrictStrangerMessages và không phải bạn bè, chỉ lấy tin nhắn do user1 gửi
    const queryPromises = [];
    queryPromises.push(
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
        Limit: 100,
        ScanIndexForward: false,
      }).promise()
    );

    if (!restrictStrangerMessages || isFriend) {
      queryPromises.push(
        dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
          ExpressionAttributeValues: { ':user1': user1, ':user2': user2 },
          Limit: 100,
          ScanIndexForward: false,
        }).promise()
      );
    }

    const [senderResult, receiverResult] = await Promise.all(queryPromises);

    const allMessages = [
      ...(senderResult.Items || []),
      ...(receiverResult ? receiverResult.Items || [] : []),
    ];

    // Lọc tin nhắn: chỉ giữ những tin chưa expired, không bị xóa, thuộc user1
    const filteredMessages = allMessages.filter(
      msg =>
        (!msg.expiresAt || msg.expiresAt > now) &&
        msg.ownerId === user1 &&
        msg.status !== MESSAGE_STATUSES.DELETE &&
        (msg.status !== MESSAGE_STATUSES.RESTRICTED || msg.senderId === user1)
    );

    // Loại bỏ trùng và sắp xếp
    const uniqueMessages = Array.from(
      new Map(filteredMessages.map(msg => [`${msg.messageId}:${msg.ownerId}`, msg])).values()
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return { success: true, messages: uniqueMessages };
  } catch (error) {
    logger.error(`Error fetching messages`, { user1, user2, error: error.message });
    throw new AppError(`Failed to fetch messages: ${error.message}`, 500);
  }
};


const forwardMessageUnified = async (senderId, messageId, sourceIsGroup, targetIsGroup, targetId) => {
  logger.info(`Forwarding message`, { senderId, messageId, sourceIsGroup, targetIsGroup, targetId });

  // 1. Kiểm tra tham số đầu vào
  if (!senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId) || !targetId || !isValidUUID(targetId)) {
    throw new AppError('Tham số không hợp lệ', 400);
  }

  // 2. Lấy tin nhắn gốc
  let originalMessage = null;
  if (sourceIsGroup) {
    // Nguồn là nhóm: Lấy từ GroupMessages
    const sourceGroup = await dynamoDB.get({ TableName: 'Groups', Key: { groupId: targetId } }).promise();
    if (!sourceGroup.Item || !sourceGroup.Item.members.includes(senderId)) {
      throw new AppError('Bạn không phải thành viên nhóm gốc!', 403);
    }

    const messageResult = await dynamoDB.get({ TableName: 'GroupMessages', Key: { groupId: targetId, messageId } }).promise();
    if (!messageResult.Item) {
      throw new AppError('Tin nhắn gốc không tồn tại!', 404);
    }
    originalMessage = messageResult.Item;
  } else {
    // Nguồn là hội thoại cá nhân: Tìm trong Messages
    const senderQuery = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderIdMessageIdIndex',
      KeyConditionExpression: 'senderId = :senderId AND messageId = :messageId',
      ExpressionAttributeValues: {
        ':senderId': senderId,
        ':messageId': messageId,
      },
      Limit: 1,
    }).promise();

    if (senderQuery.Items?.[0]) {
      originalMessage = senderQuery.Items[0];
    } else {
      const receiverQuery = await dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'ReceiverSenderIndex',
        KeyConditionExpression: 'receiverId = :receiverId',
        FilterExpression: 'messageId = :messageId',
        ExpressionAttributeValues: {
          ':receiverId': senderId,
          ':messageId': messageId,
        },
        Limit: 1,
      }).promise();

      if (receiverQuery.Items?.[0]) {
        originalMessage = receiverQuery.Items[0];
      }
    }

    if (!originalMessage) {
      throw new AppError(`Không tìm thấy tin nhắn với messageId: ${messageId}`, 404);
    }
  }

  // 3. Kiểm tra trạng thái tin nhắn gốc
  if (originalMessage.status === MESSAGE_STATUSES.RECALLED || originalMessage.status === MESSAGE_STATUSES.DELETE) {
    throw new AppError('Không thể chuyển tiếp tin nhắn đã thu hồi hoặc đã xóa!', 400);
  }

  if (!sourceIsGroup && originalMessage.senderId !== senderId && originalMessage.receiverId !== senderId) {
    throw new AppError('Không có quyền chuyển tiếp tin nhắn này', 403);
  }

  // 4. Kiểm tra quyền gửi tin nhắn đến đích
  let targetReceiverId = null;
  let targetGroupId = null;
  if (targetIsGroup) {
    // Đích là nhóm
    targetGroupId = targetId;
    const targetGroup = await dynamoDB.get({ TableName: 'Groups', Key: { groupId: targetGroupId } }).promise();
    if (!targetGroup.Item || !targetGroup.Item.members.includes(senderId)) {
      throw new AppError('Nhóm đích không tồn tại hoặc bạn không phải thành viên!', 403);
    }
  } else {
    // Đích là hội thoại cá nhân
    targetReceiverId = targetId;
    const { canSend, isRestricted } = await canSendMessageToUser(senderId, targetReceiverId, true);
    if (!canSend) throw new AppError('Không có quyền gửi tin nhắn!', 403);
  }

  // 5. Xử lý media (nếu có)
  let newMediaUrl = originalMessage.mediaUrl;
  let newS3Key = null;
  const bucketName = process.env.BUCKET_NAME_Chat_Send;
  const newMessageId = uuidv4();
  if (newMediaUrl && newMediaUrl.startsWith('s3://')) {
    const originalKey = newMediaUrl.split('/').slice(3).join('/');
    ({ mediaUrl: newMediaUrl, s3Key: newS3Key } = await copyS3File(bucketName, originalKey, newMessageId, originalMessage.mimeType));
  }

  // 6. Tạo tin nhắn mới
  const baseMessage = {
    messageId: newMessageId,
    senderId,
    type: originalMessage.type,
    content: originalMessage.content,
    mediaUrl: newMediaUrl,
    fileName: originalMessage.fileName,
    mimeType: originalMessage.mimeType,
    metadata: {
      ...originalMessage.metadata,
      forwardedFrom: sourceIsGroup ? { groupId: targetId, messageId } : messageId,
    },
    isAnonymous: false,
    isSecret: false,
    quality: originalMessage.quality,
    timestamp: new Date().toISOString(),
    status: MESSAGE_STATUSES.SENDING,
  };

  try {
    let savedMessage = null;
    if (targetIsGroup) {
      // Đích là nhóm: Lưu vào GroupMessages
      const newMessage = {
        ...baseMessage,
        groupId: targetGroupId,
      };
      savedMessage = await sendMessageCore(newMessage, 'GroupMessages', bucketName);
      await updateLastMessageForGroup(targetGroupId, savedMessage);
      io().to(targetGroupId).emit('groupMessage', savedMessage);
    } else {
      // Đích là hội thoại cá nhân: Lưu vào Messages
      const conversation = await dynamoDB.get({
        TableName: 'Conversations',
        Key: { userId: senderId, targetUserId: targetReceiverId },
      }).promise();
      if (!conversation.Item) {
        await createConversation(senderId, targetReceiverId);
      }

      const [senderAutoDelete, receiverAutoDelete] = await Promise.all([
        getAutoDeleteSetting(senderId, targetReceiverId),
        getAutoDeleteSetting(targetReceiverId, senderId),
      ]);

      const now = Date.now();
      const senderExpiresAt =
        senderAutoDelete !== 'never' && DAYS_TO_SECONDS[senderAutoDelete]
          ? Math.floor(now / 1000) + DAYS_TO_SECONDS[senderAutoDelete]
          : null;
      const receiverExpiresAt =
        receiverAutoDelete !== 'never' && DAYS_TO_SECONDS[receiverAutoDelete]
          ? Math.floor(now / 1000) + DAYS_TO_SECONDS[receiverAutoDelete]
          : null;

      const senderMessage = buildMessageRecord({ ...baseMessage, receiverId: targetReceiverId }, senderId, senderExpiresAt);
      const receiverMessage = buildMessageRecord({ ...baseMessage, receiverId: targetReceiverId }, targetReceiverId, receiverExpiresAt);

      await Promise.all([
        sendMessageCore(senderMessage, 'Messages', bucketName),
        sendMessageCore(receiverMessage, 'Messages', bucketName),
      ]);

      // Cập nhật lastMessage cho hội thoại cá nhân
      await updateConversations(senderId, targetReceiverId, newMessageId, baseMessage.timestamp, {
        content: baseMessage.content,
        senderId: baseMessage.senderId,
        type: baseMessage.type,
        isRecalled: false,
      });

      const { canSend, isRestricted } = await canSendMessageToUser(senderId, targetReceiverId, true);
      const initialStatus = getInitialStatus(isRestricted, isUserOnline(targetReceiverId), false);

      await Promise.all([
        updateMessageStatus(newMessageId, senderId, initialStatus),
        updateMessageStatus(newMessageId, targetReceiverId, initialStatus),
      ]);

      savedMessage = { ...senderMessage, status: initialStatus };
      io().to(senderId).emit('receiveMessage', savedMessage);
      if (!isRestricted) {
        io().to(targetReceiverId).emit('receiveMessage', { ...receiverMessage, status: initialStatus });
      }
    }

    logger.info('Message forwarded successfully', { newMessageId });
    return savedMessage;
  } catch (error) {
    if (newS3Key) {
      await deleteS3Object(bucketName, newS3Key);
    }
    logger.error(`Error forwarding message`, { messageId: newMessageId, error: error.message, stack: error.stack });
    throw new AppError(`Không thể chuyển tiếp tin nhắn: ${error.message}`, 500);
  }
};

// Hàm cho 1-1
const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  return await forwardMessageUnified(senderId, messageId, false, false, targetReceiverId);
};

// Hàm cho 1-group
const forwardMessageToGroup = async (senderId, messageId, targetGroupId) => {
  return await forwardMessageUnified(senderId, messageId, false, true, targetGroupId);
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
  if (message.status === MESSAGE_STATUSES.RECALLED || message.status === MESSAGE_STATUSES.FAILED) {
    throw new AppError('Không thể ghim tin nhắn đã thu hồi hoặc thất bại!', 400);
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

const deleteMessage = async (userId, messageId) => {
  try {
    logger.info('Deleting message:', { messageId, userId });

    const messageRes = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
    }).promise();

    const message = messageRes.Item;
    if (!message) throw new AppError('Tin nhắn không tồn tại!', 404);
    if (message.senderId !== userId && message.receiverId !== userId) {
      throw new AppError('Bạn không thuộc hội thoại này!', 403);
    }

    const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;

    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
      UpdateExpression: 'SET #status = :deleted, deletedAt = :deletedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':deleted': MESSAGE_STATUSES.DELETE,
        ':deletedAt': new Date().toISOString(),
      },
    }).promise();

    const conversationRes = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId: otherUserId },
    }).promise();

    const isLastMessage = conversationRes.Item?.lastMessage?.messageId === messageId;

    if (isLastMessage) {
      const [sentMessages, receivedMessages] = await Promise.all([
        dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'SenderReceiverIndex',
          KeyConditionExpression: 'senderId = :userId AND receiverId = :otherUserId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':otherUserId': otherUserId,
          },
          ScanIndexForward: false,
          // Limit: 10,
        }).promise(),
        dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :userId AND senderId = :otherUserId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':otherUserId': otherUserId,
          },
          ScanIndexForward: false,
          // Limit: 10,
        }).promise(),
      ]);

      const allMessages = [...(sentMessages.Items || []), ...(receivedMessages.Items || [])]
        .filter(
          msg =>
            msg.messageId !== messageId &&
            msg.ownerId === userId &&
            msg.status !== MESSAGE_STATUSES.RECALLED &&
            msg.status !== MESSAGE_STATUSES.FAILED &&
            msg.status !== MESSAGE_STATUSES.DELETE
        )
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const previousMessage = allMessages[0];

      await dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: otherUserId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': previousMessage
            ? {
                messageId: previousMessage.messageId,
                content:
                  previousMessage.content ||
                  (previousMessage.type === 'image' ? '[Hình ảnh]' : `[${previousMessage.type}]`),
                createdAt: previousMessage.timestamp,
                senderId: previousMessage.senderId,
                type: previousMessage.type,
                isRecalled: previousMessage.status === MESSAGE_STATUSES.RECALLED,
              }
            : null,
          ':time': new Date().toISOString(),
        },
      }).promise();
    }

    io().to(userId).emit('messageDeleted', { messageId });

    return { success: true, message: 'Tin nhắn đã được xóa chỉ với bạn!' };
  } catch (err) {
    logger.error('Lỗi khi xoá tin nhắn:', {
      messageId,
      userId,
      error: err.message,
      stack: err.stack,
    });
    throw new AppError('Không thể xoá tin nhắn. Vui lòng thử lại sau!', 500);
  }
};
// Hàm khôi phục tin nhắn
const restoreMessage = async (userId, messageId) => {
  try {
    logger.info('Restoring message:', { messageId, userId });

    const messageRes = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
    }).promise();

    const message = messageRes.Item;
    if (!message) throw new AppError('Tin nhắn không tồn tại!', 404);
    if (message.senderId !== userId && message.receiverId !== userId) {
      throw new AppError('Bạn không có quyền khôi phục tin nhắn này!', 403);
    }

    if (message.status !== MESSAGE_STATUSES.DELETE) {
      throw new AppError('Tin nhắn này không bị xóa!', 400);
    }

    const deletedAt = new Date(message.deletedAt);
    const currentTime = new Date();
    const timeDifference = currentTime - deletedAt;

    if (timeDifference > 60000) {
      throw new AppError('Bạn chỉ có thể khôi phục tin nhắn trong vòng 1 phút sau khi xóa!', 400);
    }

    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
      UpdateExpression: 'SET #status = :active, deletedAt = :deletedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': MESSAGE_STATUSES.SENT,
        ':deletedAt': null,
      },
    }).promise();

    const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;
    const conversationRes = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId: otherUserId },
    }).promise();

    const lastMessage = conversationRes.Item?.lastMessage;
    if (lastMessage?.messageId === messageId) {
      await dynamoDB.update({
        TableName: 'Conversations',
        Key: { userId, targetUserId: otherUserId },
        UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
        ExpressionAttributeValues: {
          ':msg': {
            messageId: message.messageId,
            content: message.content || (message.type === 'image' ? '[Hình ảnh]' : `[${message.type}]`),
            createdAt: message.timestamp,
            senderId: message.senderId,
            type: message.type,
            isRecalled: false,
          },
          ':time': new Date().toISOString(),
        },
      }).promise();
    }

    io().to(userId).emit('messageRestored', { messageId });

    return { success: true, message: 'Tin nhắn đã được khôi phục!' };
  } catch (err) {
    logger.error('Lỗi khi khôi phục tin nhắn:', {
      messageId,
      userId,
      error: err.message,
      stack: err.stack,
    });
    throw new AppError('Không thể khôi phục tin nhắn. Vui lòng thử lại sau!', 500);
  }
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



// Hàm kiểm tra quyền gửi tin nhắn
const canSendMessageToUser = async (senderId, receiverId, isForward = false) => {
  logger.info('Checking canSendMessageToUser:', { senderId, receiverId, isForward });

  if (senderId === receiverId) return { canSend: true, isRestricted: false };

  await checkBlockStatus(senderId, receiverId);

  const receiverResult = await dynamoDB.get({
    TableName: 'Users',
    Key: { userId: receiverId },
  }).promise();

  const receiver = receiverResult.Item;
  if (!receiver) throw new AppError('Người nhận không tồn tại!', 404);

  const restrictStrangerMessages = receiver.restrictStrangerMessages || false;

  if (!restrictStrangerMessages) {
    if (!isForward) return { canSend: true, isRestricted: false };

    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId: senderId, targetUserId: receiverId },
    }).promise();
    if (conversation.Item) return { canSend: true, isRestricted: false };

    throw new AppError('Chưa từng nhắn tin với người này, không thể chuyển tiếp!', 403);
  }

  const friendResult = await dynamoDB.get({
    TableName: 'Friends',
    Key: { userId: receiverId, friendId: senderId },
  }).promise();

  if (friendResult.Item) return { canSend: true, isRestricted: false };

  return { canSend: true, isRestricted: true };
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



module.exports = {
  createMessage,
  getMessagesBetweenUsers,
  forwardMessage,
  forwardMessageToGroup,
  forwardMessage,
  recallMessage,
  pinMessage,
  unpinMessage,
  getPinnedMessages,
  deleteMessage,
  restoreMessage,
  retryMessage,
  markMessageAsSeen,
  updateMessageStatusOnConnect,
  canSendMessageToUser,
  checkBlockStatus,
  forwardMessageUnified
};