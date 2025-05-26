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
const {GET_DEFAULT_CONTENT_BY_TYPE} = require('../config/constants');
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

  
    logger.error(`Error creating message`, { messageId, error: error.message, stack: error.stack });
    throw new AppError(`Không thể gửi tin nhắn: ${error.message}`, 500);
  }
};

const updateConversations = async (senderId, receiverId, messageId, timestamp, messageData) => {
  const { content, senderId: msgSenderId, type, isRecalled = false } = messageData;

  // Nếu tin nhắn bị thu hồi, content phải là "Tin nhắn đã bị thu hồi"
  const lastMessageContent = isRecalled ? 'Tin nhắn đã bị thu hồi' : (content || GET_DEFAULT_CONTENT_BY_TYPE(type));

  const lastMessageData = {
    messageId,
    content: lastMessageContent,
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
          savedMessage.status === MESSAGE_STATUSES.RECALLED
            ? 'Tin nhắn đã bị thu hồi'
            : (savedMessage.content || GET_DEFAULT_CONTENT_BY_TYPE(savedMessage.type)),
        createdAt: savedMessage.timestamp,
        senderId: savedMessage.senderId,
        type: savedMessage.type,
        isRecalled: savedMessage.status === MESSAGE_STATUSES.RECALLED,
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
        content: 'Tin nhắn đã bị thu hồi', // Đặt content thành "Tin nhắn đã bị thu hồi"
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

 

    return { success: true, message: 'Message recalled successfully' };
  } catch (error) {
    logger.error(`Error recalling message`, { messageId, error: error.message });
    throw new AppError(`Failed to recall message: ${error.message}`, 500);
  }
};
// Hàm lấy tin nhắn giữa hai người dùng
const getMessagesBetweenUsers = async (userId, otherUserId, limit = 20, lastEvaluatedKey = null) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    let isFriend = true;
    let restrictStrangerMessages = false;
    if (userId !== otherUserId) {
      const [friendResult, userResult] = await Promise.all([
        dynamoDB.get({ TableName: 'Friends', Key: { userId, friendId: otherUserId } }).promise(),
        dynamoDB.get({ TableName: 'Users', Key: { userId } }).promise(),
      ]);
      isFriend = !!friendResult.Item;
      restrictStrangerMessages = userResult.Item?.settings?.restrictStrangerMessages || false;
    }

    const queryPromises = [];
    queryPromises.push(
      dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'SenderReceiverIndex',
        KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
        ExpressionAttributeValues: { ':user1': userId, ':user2': otherUserId },
        Limit: limit,
        ScanIndexForward: false,
        ExclusiveStartKey: lastEvaluatedKey,
      }).promise()
    );

    if (!restrictStrangerMessages || isFriend) {
      queryPromises.push(
        dynamoDB.query({
          TableName: 'Messages',
          IndexName: 'ReceiverSenderIndex',
          KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
          ExpressionAttributeValues: { ':user1': userId, ':user2': otherUserId },
          Limit: limit,
          ScanIndexForward: false,
          ExclusiveStartKey: lastEvaluatedKey,
        }).promise()
      );
    }

    const [senderResult, receiverResult] = await Promise.all(queryPromises);

    const allMessages = [
      ...(senderResult.Items || []),
      ...(receiverResult ? receiverResult.Items || [] : []),
    ];

    const filteredMessages = allMessages.filter(
      msg =>
        (!msg.expiresAt || msg.expiresAt > now) &&
        msg.ownerId === userId &&
        msg.status !== MESSAGE_STATUSES.DELETE &&
        (msg.status !== MESSAGE_STATUSES.RESTRICTED || msg.senderId === userId)
    );

    const uniqueMessages = Array.from(
      new Map(filteredMessages.map(msg => [`${msg.messageId}:${msg.ownerId}`, msg])).values()
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Lấy thông tin sender
    const senderIds = [...new Set(uniqueMessages.map(msg => msg.senderId))];
    const userPromises = senderIds.map(senderId =>
      dynamoDB.get({ TableName: 'Users', Key: { userId: senderId } }).promise()
      .then(result => {
        if (result.Item) {
          const { userId, name, avatar, phoneNumber } = result.Item;
          return { userId, name, avatar, phoneNumber };
        } else {
          return {
            userId: senderId,
            name: 'Chưa có tên',
            avatar: 'default-avatar.png',
            phoneNumber: 'Chưa có số điện thoại',
          };
        }
      })
    );

    const users = await Promise.all(userPromises);
    const userMap = users.reduce((map, user) => {
      map[user.userId] = user;
      return map;
    }, {});

    const enrichedMessages = uniqueMessages.map(msg => ({
      ...msg,
      sender: { ...userMap[msg.senderId] },
    }));

    return {
      success: true,
      messages: enrichedMessages,
      lastEvaluatedKey: senderResult.LastEvaluatedKey || receiverResult?.LastEvaluatedKey,
    };
  } catch (error) {
    logger.error(`Error fetching messages`, { userId, otherUserId, error: error.message });
    throw new AppError(`Failed to fetch messages: ${error.message}`, 500);
  }
};

const extractBucketFromMediaUrl = (mediaUrl) => {
  if (!mediaUrl || !mediaUrl.startsWith('s3://')) return null;
  const parts = mediaUrl.replace('s3://', '').split('/');
  return parts[0]; // bucket name
};

const forwardMessageUnified = async (senderId, messageId, sourceIsGroup, targetIsGroup, sourceId, targetId) => {
  logger.info(`Forwarding message`, { senderId, messageId, sourceIsGroup, targetIsGroup, sourceId, targetId });

  if (!senderId || !isValidUUID(senderId) || !messageId || !isValidUUID(messageId) || !targetId || !isValidUUID(targetId)) {
    throw new AppError('Tham số không hợp lệ', 400);
  }

  let originalMessage = null;

  if (sourceIsGroup) {
    const group = await dynamoDB.get({ TableName: 'Groups', Key: { groupId: sourceId } }).promise();
    if (!group.Item || !group.Item.members.includes(senderId)) {
      throw new AppError('Bạn không phải thành viên nhóm gốc!', 403);
    }

    const msgRes = await dynamoDB.query({
      TableName: 'GroupMessages',
      IndexName: 'groupId-messageId-index',
      KeyConditionExpression: 'groupId = :groupId AND messageId = :messageId',
      ExpressionAttributeValues: {
        ':groupId': sourceId,
        ':messageId': messageId,
      },
      Limit: 1,
    }).promise();

    originalMessage = msgRes.Items?.[0];
  } else {
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

      originalMessage = receiverQuery.Items?.[0];
    }
  }

  if (!originalMessage) {
    throw new AppError(`Không tìm thấy tin nhắn với messageId: ${messageId}`, 404);
  }

  if ([MESSAGE_STATUSES.RECALLED, MESSAGE_STATUSES.DELETE].includes(originalMessage.status)) {
    throw new AppError('Không thể chuyển tiếp tin nhắn đã thu hồi hoặc đã xóa!', 400);
  }

  if (!sourceIsGroup && originalMessage.senderId !== senderId && originalMessage.receiverId !== senderId) {
    throw new AppError('Không có quyền chuyển tiếp tin nhắn này', 403);
  }

  // Xác định đích
  let targetReceiverId = null;
  let targetGroupId = null;

  if (targetIsGroup) {
    targetGroupId = targetId;
    const group = await dynamoDB.get({ TableName: 'Groups', Key: { groupId: targetGroupId } }).promise();
    if (!group.Item || !group.Item.members.includes(senderId)) {
      throw new AppError('Nhóm đích không tồn tại hoặc bạn không phải thành viên!', 403);
    }
  } else {
    targetReceiverId = targetId;
    const { canSend } = await canSendMessageToUser(senderId, targetReceiverId, true);
    if (!canSend) throw new AppError('Không có quyền gửi tin nhắn!', 403);
  }

  // Xử lý media
  let newMediaUrl = originalMessage.mediaUrl;
  let newS3Key = null;
  const newMessageId = uuidv4();

  if (newMediaUrl?.startsWith('s3://')) {
    const originalKey = newMediaUrl.split('/').slice(3).join('/');
    const originalBucket = extractBucketFromMediaUrl(newMediaUrl);
    if (!originalBucket) throw new AppError('Không thể xác định bucket từ mediaUrl!', 500);

    ({ mediaUrl: newMediaUrl, s3Key: newS3Key } = await copyS3File(
      originalBucket,
      originalKey,
      newMessageId,
      originalMessage.mimeType
    ));
  }

  const messageData = {
    type: originalMessage.type,
    content: originalMessage.content,
    mediaUrl: newMediaUrl,
    fileName: originalMessage.fileName,
    mimeType: originalMessage.mimeType,
    metadata: originalMessage.metadata,
    replyToMessageId: originalMessage.replyToMessageId || null,
  };

  let result;
  const now = new Date().toISOString();

  if (targetIsGroup) {
    result = await sendMessageCore(
      {
        groupId: targetGroupId,
        senderId,
        ...messageData,
        ownerId: targetGroupId,
        isAnonymous: originalMessage.isAnonymous || false,
        isSecret: originalMessage.isSecret || false,
        status: MESSAGE_STATUSES.SENT,
      },
      'GroupMessages',
      process.env.BUCKET_NAME_GroupChat_Send
    );

    const group = await dynamoDB.get({ TableName: 'Groups', Key: { groupId: targetGroupId } }).promise();
    const members = group.Item?.members || [];

    const lastMessage = {
      messageId: result.messageId,
      content: result.content || GET_DEFAULT_CONTENT_BY_TYPE(result.type),
      createdAt: result.timestamp || now,
      senderId: result.senderId,
      type: result.type,
      isRecalled: false,
    };

    await Promise.all(
      members.map((memberId) =>
        dynamoDB.update({
          TableName: 'Conversations',
          Key: { userId: memberId, targetUserId: targetGroupId },
          UpdateExpression: 'SET lastMessage = :msg, updatedAt = :time',
          ExpressionAttributeValues: {
            ':msg': lastMessage,
            ':time': now,
          },
        }).promise()
      )
    );
  } else {
    result = await createMessage(senderId, targetReceiverId, messageData);
  }

  return result;
};
// Hàm cho 1-1
const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  return await forwardMessageUnified(senderId, messageId, false, false, null, targetReceiverId);
};

// Hàm cho 1-group
const forwardMessageToGroup = async (senderId, messageId, targetGroupId) => {
  return await forwardMessageUnified(senderId, messageId, false, true, null, targetGroupId);
};

const pinMessage = async (userId, messageId) => {
  logger.info('Pinning message:', { messageId, userId });

  let message;
  let isGroupMessage = false;
  let groupId;
  let messageTimestamp;

  // 1. Kiểm tra tin nhắn trong bảng Messages (chat 1-1)
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

  // 2. Nếu không tìm thấy trong bảng Messages, kiểm tra trong bảng GroupMessages (chat nhóm)
  if (!message) {
    try {
      // Truy vấn tất cả các nhóm mà userId là thành viên để lấy danh sách groupId
      const groupMemberResult = await dynamoDB.query({
        TableName: 'GroupMembers',
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
      }).promise();

      const groupIds = groupMemberResult.Items?.map(item => item.groupId) || [];

      // Thử lấy tin nhắn từ bảng GroupMessages với từng groupId
      for (const gid of groupIds) {
        const groupMessagesResult = await dynamoDB.query({
          TableName: 'GroupMessages',
          IndexName: 'groupId-messageId-index',
          KeyConditionExpression: 'groupId = :groupId AND messageId = :messageId',
          ExpressionAttributeValues: {
            ':groupId': gid,
            ':messageId': messageId,
          },
          Limit: 1,
        }).promise();

        if (groupMessagesResult.Items?.length > 0) {
          message = groupMessagesResult.Items[0];
          groupId = gid;
          messageTimestamp = message.timestamp; // Lưu timestamp để sử dụng làm sort key
          isGroupMessage = true;
          break;
        }
      }

      if (!message) {
        throw new AppError('Tin nhắn không tồn tại!', 404);
      }
    } catch (err) {
      logger.error('Lỗi truy vấn GroupMessages:', err);
      throw new AppError('Lỗi truy vấn tin nhắn nhóm: ' + err.message, 500);
    }
  }

  if (!message) throw new AppError('Tin nhắn không tồn tại!', 404);

  // 3. Kiểm tra quyền và trạng thái tin nhắn
  if (isGroupMessage) {
    // Chat nhóm: Kiểm tra xem userId có phải thành viên nhóm không
    const group = await dynamoDB.get({
      TableName: 'Groups',
      Key: { groupId: groupId },
    }).promise();

    if (!group.Item || !group.Item.members.includes(userId)) {
      throw new AppError('Bạn không phải thành viên nhóm này!', 403);
    }
  } else {
    // Chat 1-1: Kiểm tra xem userId có thuộc cuộc trò chuyện không
    if (message.senderId !== userId && message.receiverId !== userId) {
      throw new AppError('Bạn không có quyền ghim tin nhắn này!', 403);
    }
  }

  if (message.isPinned) {
    throw new AppError('Tin nhắn đã được ghim!', 400);
  }
  if (message.status === MESSAGE_STATUSES.RECALLED || message.status === MESSAGE_STATUSES.FAILED) {
    throw new AppError('Không thể ghim tin nhắn đã thu hồi hoặc thất bại!', 400);
  }

  let otherUserId;
  if (!isGroupMessage) {
    otherUserId = message.senderId === userId ? message.receiverId : message.senderId;
  }

  // 4. Kiểm tra số lượng tin nhắn ghim
  let pinnedMessageIds = [];
  if (isGroupMessage) {
    const group = await dynamoDB.get({
      TableName: 'Groups',
      Key: { groupId: groupId },
    }).promise();
    pinnedMessageIds = group.Item?.settings?.pinnedMessages || [];
  } else {
    const conversation = await dynamoDB.get({
      TableName: 'Conversations',
      Key: { userId, targetUserId: otherUserId },
    }).promise();
    pinnedMessageIds = conversation.Item?.settings?.pinnedMessages || [];
  }

  if (pinnedMessageIds.length >= 3) {
    throw new AppError('Hội thoại chỉ có thể ghim tối đa 3 tin nhắn!', 400);
  }

  // 5. Cập nhật bảng Messages hoặc GroupMessages và Conversations
  try {
    if (isGroupMessage) {
      // Cập nhật bảng GroupMessages
      await dynamoDB.update({
        TableName: 'GroupMessages',
        Key: { groupId: groupId, timestamp: messageTimestamp },
        UpdateExpression: 'SET isPinned = :p, pinnedBy = :userId',
        ExpressionAttributeValues: { ':p': true, ':userId': userId },
      }).promise();

      // Cập nhật danh sách pinnedMessages trong Groups
      await dynamoDB.update({
        TableName: 'Groups',
        Key: { groupId: groupId },
        UpdateExpression: 'SET settings.pinnedMessages = list_append(if_not_exists(settings.pinnedMessages, :empty), :msg)',
        ExpressionAttributeValues: {
          ':msg': [messageId],
          ':empty': [],
        },
      }).promise();
    } else {
      // Cập nhật bảng Messages và Conversations
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
    }

    return { success: true, message: `Tin nhắn đã được ghim bởi ${userId}` };
  } catch (err) {
    logger.error('Lỗi khi ghim tin nhắn:', err);
    throw new AppError('Không thể ghim tin nhắn', 500);
  }
};

const unpinMessage = async (userId, messageId) => {
  logger.info('Unpinning message:', { userId, messageId });

  let message;
  let isGroupMessage = false;
  let groupId;
  let messageTimestamp;

  // 1. Kiểm tra tin nhắn trong bảng Messages (chat 1-1)
  const messageRes = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise();
  message = messageRes.Item;

  // 2. Nếu không tìm thấy trong bảng Messages, kiểm tra trong bảng GroupMessages (chat nhóm)
  if (!message) {
    try {
      // Truy vấn tất cả các nhóm mà userId là thành viên để lấy danh sách groupId
      const groupMemberResult = await dynamoDB.query({
        TableName: 'GroupMembers',
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
      }).promise();

      const groupIds = groupMemberResult.Items?.map(item => item.groupId) || [];

      // Thử lấy tin nhắn từ bảng GroupMessages với từng groupId
      for (const gid of groupIds) {
        const groupMessagesResult = await dynamoDB.query({
          TableName: 'GroupMessages',
          IndexName: 'groupId-messageId-index',
          KeyConditionExpression: 'groupId = :groupId AND messageId = :messageId',
          ExpressionAttributeValues: {
            ':groupId': gid,
            ':messageId': messageId,
          },
          Limit: 1,
        }).promise();

        if (groupMessagesResult.Items?.length > 0) {
          message = groupMessagesResult.Items[0];
          groupId = gid;
          messageTimestamp = message.timestamp; // Lưu timestamp để sử dụng làm sort key
          isGroupMessage = true;
          break;
        }
      }

      if (!message) {
        throw new AppError('Tin nhắn không tồn tại!', 404);
      }
    } catch (err) {
      logger.error('Lỗi truy vấn GroupMessages:', err);
      throw new AppError('Lỗi truy vấn tin nhắn nhóm: ' + err.message, 500);
    }
  }

  if (!message) throw new AppError('Tin nhắn không tồn tại!', 404);
  if (!message.isPinned) throw new AppError('Tin nhắn chưa được ghim!', 400);

  let otherUserId;
  if (!isGroupMessage) {
    otherUserId = message.senderId === userId ? message.receiverId : message.senderId;
  }

  // 3. Cập nhật bảng Messages hoặc GroupMessages và Conversations
  try {
    if (isGroupMessage) {
      // Cập nhật bảng GroupMessages
      await dynamoDB.update({
        TableName: 'GroupMessages',
        Key: { groupId: groupId, timestamp: messageTimestamp },
        UpdateExpression: 'SET isPinned = :false REMOVE pinnedBy',
        ExpressionAttributeValues: { ':false': false },
      }).promise();

      // Cập nhật danh sách pinnedMessages trong Groups
      await dynamoDB.update({
        TableName: 'Groups',
        Key: { groupId: groupId },
        UpdateExpression: 'SET settings.pinnedMessages = :msgs',
        ExpressionAttributeValues: {
          ':msgs': (await dynamoDB.get({
            TableName: 'Groups',
            Key: { groupId: groupId },
          }).promise()).Item?.settings?.pinnedMessages?.filter(id => id !== messageId) || [],
        },
      }).promise();
    } else {
      // Cập nhật bảng Messages và Conversations
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
    }

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
      let pinnedMessageIds = [];
      let isGroupChat = false;

      // Kiểm tra xem otherUserId có phải là groupId không
      const group = await dynamoDB.get({
        TableName: 'Groups',
        Key: { groupId: otherUserId },
      }).promise();

      if (group.Item) {
        // Đây là chat nhóm
        isGroupChat = true;
        pinnedMessageIds = group.Item?.settings?.pinnedMessages || [];
      } else {
        // Chat 1-1
        const conversation = await dynamoDB.get({
          TableName: 'Conversations',
          Key: { userId, targetUserId: otherUserId },
        }).promise();
        pinnedMessageIds = conversation.Item?.settings?.pinnedMessages || [];
      }

      if (!pinnedMessageIds.length) {
        return { success: true, messages: [] };
      }

      let messages = [];
      if (isGroupChat) {
        // Lấy tin nhắn từ bảng GroupMessages
        messages = await Promise.all(
          pinnedMessageIds.map(async messageId => {
            const messageResult = await dynamoDB.query({
              TableName: 'GroupMessages',
              IndexName: 'groupId-messageId-index',
              KeyConditionExpression: 'groupId = :groupId AND messageId = :messageId',
              ExpressionAttributeValues: {
                ':groupId': otherUserId,
                ':messageId': messageId,
              },
              Limit: 1,
            }).promise();
            return messageResult.Items?.[0] || null;
          })
        );
      } else {
        // Lấy tin nhắn từ bảng Messages
        messages = await Promise.all(
          pinnedMessageIds.map(async messageId => {
            const message = await dynamoDB.get({
              TableName: 'Messages',
              Key: { messageId, ownerId: userId },
            }).promise();
            return message.Item;
          })
        );
      }

      const validMessages = messages
        .filter(msg => msg && msg.isPinned && msg.status !== MESSAGE_STATUSES.RECALLED);

      // Lấy thông tin sender cho mỗi tin nhắn
      const senderIds = [...new Set(validMessages.map(msg => msg.senderId).filter(id => id))];
      const userPromises = senderIds.map(senderId =>
        dynamoDB.get({
          TableName: 'Users',
          Key: { userId: senderId },
        }).promise()
        .then(result => {
          if (result.Item) {
            const { userId, name, avatar, phoneNumber } = result.Item;
            return { userId, name, avatar, phoneNumber };
          } else {
            logger.error('User not found', { userId: senderId });
            return {
              userId: senderId,
              name: 'Chưa có tên',
              avatar: 'default-avatar.png',
              phoneNumber: 'Chưa có số điện thoại',
            };
          }
        })
        .catch(error => {
          logger.error('Failed to fetch user info', { userId: senderId, error: error.message });
          return {
            userId: senderId,
            name: 'Chưa có tên',
            avatar: 'default-avatar.png',
            phoneNumber: 'Chưa có số điện thoại',
          };
        })
      );

      const users = await Promise.all(userPromises);
      const userMap = users.reduce((map, user) => {
        map[user.userId] = user;
        return map;
      }, {});

      // Gắn thông tin sender vào tin nhắn
      const enrichedMessages = validMessages.map(msg => ({
        ...msg,
        sender: msg.senderId ? { ...userMap[msg.senderId] } : null,
      }));

      // Sắp xếp theo timestamp giảm dần
      enrichedMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return { success: true, messages: enrichedMessages };
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
                  previousMessage.status === MESSAGE_STATUSES.RECALLED
                    ? 'Tin nhắn đã bị thu hồi'
                    : (previousMessage.content || GET_DEFAULT_CONTENT_BY_TYPE(previousMessage.type)),
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
            content:
              message.status === MESSAGE_STATUSES.RECALLED
                ? 'Tin nhắn đã bị thu hồi'
                : (message.content || GET_DEFAULT_CONTENT_BY_TYPE(message.type)),
            createdAt: message.timestamp,
            senderId: message.senderId,
            type: message.type,
            isRecalled: message.status === MESSAGE_STATUSES.RECALLED,
          },
          ':time': new Date().toISOString(),
        },
      }).promise();
    }



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


const getMessageById = async (messageId, ownerId) => {
  try {
    const { Item } = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId },
    }).promise();
    if (!Item) {
      throw new AppError('Tin nhắn không tồn tại', 404);
    }
    return Item;
  } catch (error) {
    logger.error('[MessageService] Error fetching message by ID', { messageId, ownerId, error: error.message });
    throw new AppError(`Không thể lấy tin nhắn: ${error.message}`, 500);
  }
};

const getConversationsForUser = async (userId) => {
  logger.info('Fetching conversations for user', { userId });

  try {
    const result = await dynamoDB.query({
      TableName: 'Conversations',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    }).promise();

    return result.Items || [];
  } catch (error) {
    logger.error('Error fetching conversations for user', { userId, error: error.message });
    throw new AppError(`Failed to fetch conversations: ${error.message}`, 500);
  }
};
module.exports = {
  createMessage,
  getMessagesBetweenUsers,
  forwardMessage,
  forwardMessageToGroup,
  forwardMessageUnified,
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
  getMessageById,
  getConversationsForUser
  
};
