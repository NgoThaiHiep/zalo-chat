const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const { sendMessageCore } = require('./messageCore');
const { io, transcribeQueue } = require('../socket');
const { redisClient, redisSubscriber } = require('../config/redis');
const bcrypt = require('bcrypt');
const { isUserOnline, getUserActivityStatus } = require('./auth.service');
require('dotenv').config();

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

// Hàm tạo tin nhắn
const createMessage = async (senderId, receiverId, messageData) => {
  if (!senderId || !receiverId || !messageData || !messageData.type) {
    throw new Error('senderId, receiverId hoặc messageData không hợp lệ!');
  }

  await canSendMessageToUser(senderId, receiverId);

  const senderAutoDelete = await getAutoDeleteSetting(senderId, receiverId);
  const receiverAutoDelete = await getAutoDeleteSetting(receiverId, senderId);
  const daysToSeconds = { '10s': 10, '60s': 60, '1d': 24 * 60 * 60, '3d': 3 * 24 * 60 * 60, '7d': 7 * 24 * 60 * 60 };

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && daysToSeconds[senderAutoDelete]
    ? new Date(now + daysToSeconds[senderAutoDelete] * 1000).toISOString()
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && daysToSeconds[receiverAutoDelete]
    ? new Date(now + daysToSeconds[receiverAutoDelete] * 1000).toISOString()
    : null;

  const messageId = uuidv4();
  const baseMessage = {
    messageId,
    senderId,
    receiverId,
    ...messageData,
    replyToMessageId: messageData.replyToMessageId || null,
    status: 'sending',
    timestamp: new Date().toISOString(),
  };

  const senderMessage = {
    ...baseMessage,
    ownerId: senderId,
    expiresAt: senderExpiresAt,
  };

  const receiverMessage = {
    ...baseMessage,
    ownerId: receiverId,
    expiresAt: receiverExpiresAt,
  };

  console.log('Creating sender message:', senderMessage);
  console.log('Creating receiver message:', receiverMessage);
  io().to(senderId).emit('messageStatus', { messageId, status: 'sending' });

  let senderResult = null;
  let receiverResult = null;
  let senderS3Key = null;
  let receiverS3Key = null;

  try {
    const results = await Promise.allSettled([
      sendMessageCore(senderMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send).then(result => {
        senderS3Key = result.mediaUrl && result.mediaUrl.startsWith(`s3://${process.env.BUCKET_NAME_Chat_Send}/`)
          ? result.mediaUrl.split('/').slice(3).join('/')
          : null;
        return result;
      }),
      sendMessageCore(receiverMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send).then(result => {
        receiverS3Key = result.mediaUrl && result.mediaUrl.startsWith('s3://')
          ? result.mediaUrl.split('/').slice(3).join('/')
          : null;
        return result;
      }),
    ]);

    senderResult = results[0].status === 'fulfilled' ? results[0].value : null;
    receiverResult = results[1].status === 'fulfilled' ? results[1].value : null;

    if (!senderResult && !receiverResult) {
      await Promise.allSettled([
        senderS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: senderS3Key }).promise(),
        receiverS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: receiverS3Key }).promise(),
      ]);
      throw new Error('Cả hai bản ghi tin nhắn đều thất bại!');
    }

    const receiverOnline = isUserOnline(receiverId);
    const initialStatus = receiverOnline ? 'delivered' : 'sent';

    console.log('Updating status for message:', { messageId, senderId, receiverId, initialStatus });

    const updateResults = await Promise.allSettled([
      senderResult &&
        dynamoDB.update({
          TableName: 'Messages',
          Key: { messageId, ownerId: senderId },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': initialStatus },
        }).promise().catch(err => {
          console.error('Error updating sender message status:', err);
          throw err;
        }),
      receiverResult &&
        dynamoDB.update({
          TableName: 'Messages',
          Key: { messageId, ownerId: receiverId },
          UpdateExpression: 'SET #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': initialStatus },
        }).promise().catch(err => {
          console.error('Error updating receiver message status:', err);
          throw err;
        }),
    ]);

    const failedUpdates = updateResults.filter(result => result.status === 'rejected');
    if (failedUpdates.length > 0) {
      await Promise.allSettled([
        senderS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: senderS3Key }).promise(),
        receiverS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: receiverS3Key }).promise(),
      ]);
      console.error('Update status failed:', failedUpdates.map(result => result.reason));
      throw new Error('Cập nhật trạng thái tin nhắn thất bại!');
    }

    console.log('Sender expiresAt:', senderExpiresAt || 'Not set (never)');
    console.log('Receiver expiresAt:', receiverExpiresAt || 'Not set (never)');

    if (messageData.type === 'voice' && messageData.metadata?.transcribe && receiverResult) {
      await transcribeQueue().add(
        {
          messageId,
          senderId,
          receiverId,
          tableName: 'Messages',
          bucketName: process.env.BUCKET_NAME_Chat_Send,
        },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
      );
    }

    if (receiverOnline && receiverResult) {
      io().to(receiverId).emit('receiveMessage', { ...receiverMessage, status: initialStatus });
    }
    if (senderResult) {
      io().to(senderId).emit('messageStatus', { messageId, status: initialStatus });
    }

    return { ...baseMessage, status: initialStatus };
  } catch (error) {
    console.error('Error in createMessage:', error);
    await Promise.allSettled([
      senderS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: senderS3Key }).promise(),
      receiverS3Key && s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: receiverS3Key }).promise(),
    ]);
    await Promise.all([
      senderResult &&
        dynamoDB.update({
          TableName: 'Messages',
          Key: { messageId, ownerId: senderId },
          UpdateExpression: 'SET #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed' },
        }).promise().catch(err => console.error('Error updating sender failed status:', err)),
      receiverResult &&
        dynamoDB.update({
          TableName: 'Messages',
          Key: { messageId, ownerId: receiverId },
          UpdateExpression: 'SET #status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':failed': 'failed' },
        }).promise().catch(err => console.error('Error updating receiver failed status:', err)),
    ]);
    io().to(senderId).emit('messageStatus', { messageId, status: 'failed' });
    throw new Error('Gửi tin nhắn thất bại!');
  }
};

// Hàm mute hội thoại
const muteConversation = async (userId, mutedUserId, duration) => {
  const muteUntil = duration === 'forever' ? null : new Date(Date.now() + duration * 60 * 60 * 1000);
  await dynamoDB.put({
    TableName: 'MutedConversations',
    Item: { userId, mutedUserId, muteUntil, timestamp: new Date().toISOString() },
  }).promise();
  return { success: true, message: 'Đã chặn thông báo!' };
};

// Hàm thử lại tin nhắn
const retryMessage = async (senderId, messageId) => {
  console.log('Retrying message:', { messageId, senderId });

  // Sửa để dùng khóa đúng
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise().catch(err => {
    console.error('Error getting message in retryMessage:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền gửi lại tin nhắn này!');
  if (message.Item.status !== 'failed') throw new Error('Tin nhắn không ở trạng thái thất bại!');

  await dynamoDB.update({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
    UpdateExpression: 'SET #status = :sending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':sending': 'sending' },
  }).promise().catch(err => {
    console.error('Error updating status to sending:', err);
    throw err;
  });

  io().to(senderId).emit('messageStatus', { messageId, status: 'sending' });

  try {
    const savedMessage = await sendMessageCore(message.Item, 'Messages', process.env.BUCKET_NAME_Chat_Send);
    const receiverOnline = isUserOnline(savedMessage.receiverId);
    const newStatus = receiverOnline ? 'delivered' : 'sent';

    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: senderId },
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': newStatus },
    }).promise().catch(err => {
      console.error('Error updating status to delivered/sent:', err);
      throw err;
    });

    savedMessage.status = newStatus;

    if (receiverOnline) {
      io().to(savedMessage.receiverId).emit('receiveMessage', savedMessage);
    }
    io().to(senderId).emit('messageStatus', { messageId, status: newStatus });
    return savedMessage;
  } catch (error) {
    console.error('Error in retryMessage:', error);
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: senderId },
      UpdateExpression: 'SET #status = :failed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed' },
    }).promise().catch(err => console.error('Error updating status to failed:', err));
    io().to(senderId).emit('messageStatus', { messageId, status: 'failed' });
    throw new Error('Gửi lại tin nhắn thất bại!');
  }
};

// Hàm đánh dấu tin nhắn đã xem
const markMessageAsSeen = async (userId, messageId) => {
  console.log('Marking message as seen:', { messageId, userId });

  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: userId },
  }).promise().catch(err => {
    console.error('Error getting message in markMessageAsSeen:', err);
    throw err;
  });

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
      Key: { messageId, ownerId: userId },
      UpdateExpression: 'SET #status = :seen',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':seen': 'seen' },
    }).promise().catch(err => {
      console.error('Error updating status to seen:', err);
      throw err;
    });
  } else if (message.Item.status === 'sent') {
    await dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: userId },
      UpdateExpression: 'SET #status = :delivered',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':delivered': 'delivered' },
    }).promise().catch(err => {
      console.error('Error updating status to delivered:', err);
      throw err;
    });
  }

  io().to(message.Item.senderId).emit('messageStatus', { messageId, status: newStatus });
  io().to(userId).emit('messageStatus', { messageId, status: newStatus });
  return { message: `Tin nhắn ở trạng thái ${newStatus}` };
};


// Hàm lấy tin nhắn giữa hai người dùng
const getMessagesBetweenUsers = async (user1, user2) => {
  try {
    const now = new Date().toISOString();
    console.log('Đang lấy tin nhắn giữa:', { user1, user2, now });

    // Lấy danh sách messageId bị xóa bởi user1
    let deletedMessageIds = new Set();
    try {
      const deletedMessages = await dynamoDB.scan({
        TableName: 'UserDeletedMessages',
        FilterExpression: 'userId = :user1',
        ExpressionAttributeValues: { ':user1': user1 },
      }).promise();

      deletedMessageIds = new Set((deletedMessages.Items || []).map(item => item.messageId));
      console.log('Danh sách messageId bị xóa:', Array.from(deletedMessageIds));
    } catch (err) {
      console.error('Lỗi khi quét UserDeletedMessages:', err);
    }

    // Tham số truy vấn tin nhắn (2 chiều)
    const params1Sender = {
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :user1 AND receiverId = :user2',
      ExpressionAttributeValues: {
        ':user1': user1,
        ':user2': user2,
      },
      Limit: 100,
      ScanIndexForward: false,
    };

    const params1Receiver = {
      TableName: 'Messages',
      IndexName: 'ReceiverSenderIndex',
      KeyConditionExpression: 'receiverId = :user1 AND senderId = :user2',
      ExpressionAttributeValues: {
        ':user1': user1,
        ':user2': user2,
      },
      Limit: 100,
      ScanIndexForward: false,
    };

    // Chạy song song 2 truy vấn
    const [result1Sender, result1Receiver] = await Promise.all([
      dynamoDB.query(params1Sender).promise().catch(err => {
        console.error('Lỗi truy vấn params1Sender:', err);
        return { Items: [] };
      }),
      dynamoDB.query(params1Receiver).promise().catch(err => {
        console.error('Lỗi truy vấn params1Receiver:', err);
        return { Items: [] };
      }),
    ]);

    console.log('Kết quả truy vấn:', {
      sender1Count: result1Sender.Items?.length || 0,
      receiver1Count: result1Receiver.Items?.length || 0,
    });

    // Gộp tất cả tin nhắn
    const allMessages = [
      ...(result1Sender.Items || []),
      ...(result1Receiver.Items || []),
    ];

    console.log('Tổng số tin nhắn trước khi lọc:', allMessages.length);

    // ✅ Gộp filter: bỏ tin đã xoá, check expiresAt, check owner
    const filteredMessages = allMessages.filter(msg => {
      const isNotDeleted = !deletedMessageIds.has(msg.messageId);
      const isValidExpiresAt = !msg.expiresAt || msg.expiresAt > now;
      const isOwner = msg.ownerId === user1;
      return isNotDeleted && isValidExpiresAt && isOwner;
    });

    console.log('Tổng số tin nhắn sau khi lọc:', filteredMessages.length);

    // Bỏ trùng (messageId + ownerId), sort theo thời gian
    const uniqueMessages = Array.from(
      new Map(filteredMessages.map(msg => [`${msg.messageId}:${msg.ownerId}`, msg])).values()
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    console.log('Tổng số tin nhắn duy nhất:', uniqueMessages.length);

    return { success: true, messages: uniqueMessages };
  } catch (error) {
    console.error('Lỗi khi lấy tin nhắn giữa hai người dùng:', error);
    return { success: false, error: error.message || 'Không thể lấy tin nhắn' };
  }
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
  return { success: true, users: usersWithNicknames.filter(user => user && !hiddenUserIds.has(user.id)) };
};

// Hàm chuyển tiếp tin nhắn
const forwardMessage = async (senderId, messageId, targetReceiverId) => {
  console.log('Forwarding message:', { senderId, messageId, targetReceiverId });

  await canSendMessageToUser(senderId, targetReceiverId, true);

  // Thử lấy tin nhắn gốc với ownerId là senderId
  let originalMessage;
  try {
    originalMessage = await dynamoDB.get({
      TableName: 'Messages',
      Key: { messageId, ownerId: senderId },
    }).promise();
    console.log('Get message with senderId:', originalMessage);
  } catch (err) {
    console.error('Error getting message with senderId:', err);
    throw err;
  }
  if(originalMessage.Item.isRecalled){
    throw new Error('Tin nhắn đã bị thu hồi, không thể chyển tiếp!');
  }
  // Nếu không tìm thấy, thử với ownerId là receiverId của tin nhắn gốc
  if (!originalMessage.Item) {
    try {
      const tempMessage = await dynamoDB.query({
        TableName: 'Messages',
        IndexName: 'ReceiverSenderIndex',
        KeyConditionExpression: 'receiverId = :senderId AND messageId = :messageId',
        ExpressionAttributeValues: {
          ':senderId': senderId,
          ':messageId': messageId,
        },
        Limit: 1,
      }).promise();
      console.log('Query message with receiverId:', tempMessage);

      if (tempMessage.Items && tempMessage.Items.length > 0) {
        originalMessage = { Item: tempMessage.Items[0] };
      }
    } catch (err) {
      console.error('Error querying message with receiverId:', err);
      throw err;
    }
  }

  if (!originalMessage.Item) {
    throw new Error('Tin nhắn gốc không tồn tại!');
  }

  if (originalMessage.Item.senderId !== senderId && originalMessage.Item.receiverId !== senderId) {
    throw new Error('Bạn không có quyền chuyển tiếp tin nhắn này!');
  }

  const senderAutoDelete = await getAutoDeleteSetting(senderId, targetReceiverId);
  const receiverAutoDelete = await getAutoDeleteSetting(targetReceiverId, senderId);
  const daysToSeconds = { '10s': 10, '60s': 60, '1d': 24 * 60 * 60, '3d': 3 * 24 * 60 * 60, '7d': 7 * 24 * 60 * 60 };

  const now = Date.now();
  const senderExpiresAt = senderAutoDelete !== 'never' && daysToSeconds[senderAutoDelete]
    ? new Date(now + daysToSeconds[senderAutoDelete] * 1000).toISOString()
    : null;
  const receiverExpiresAt = receiverAutoDelete !== 'never' && daysToSeconds[receiverAutoDelete]
    ? new Date(now + daysToSeconds[receiverAutoDelete] * 1000).toISOString()
    : null;

  const newMessageId = uuidv4();
  let newMediaUrl = originalMessage.Item.mediaUrl;
  let newS3Key = null;

  if (newMediaUrl && newMediaUrl.startsWith('s3://')) {
    const bucketName = process.env.BUCKET_NAME_Chat_Send;
    const originalKey = newMediaUrl.split('/').slice(3).join('/');
    const mimeType = originalMessage.Item.mimeType;
    const mimeTypeMap = {
      'image/jpeg': { folder: 'images', ext: 'jpg' },
      'image/png': { folder: 'images', ext: 'png' },
      'image/heic': { folder: 'images', ext: 'heic' },
      'image/gif': { folder: 'gifs', ext: 'gif' },
      'video/mp4': { folder: 'videos', ext: 'mp4' },
      'audio/mpeg': { folder: 'voice', ext: 'mp3' },
      'audio/wav': { folder: 'voice', ext: 'wav' },
      'audio/mp4': { folder: 'voice', ext: 'm4a' },
      'application/pdf': { folder: 'files', ext: 'pdf' },
      'application/zip': { folder: 'files', ext: 'zip' },
      'application/x-rar-compressed': { folder: 'files', ext: 'rar' },
      'application/vnd.rar': { folder: 'files', ext: 'rar' },
      'text/plain': { folder: 'files', ext: 'txt' },
      'image/webp': { folder: 'images', ext: 'webp' },
    };

    const mimeInfo = mimeTypeMap[mimeType];
    if (!mimeInfo) throw new Error(`MIME type ${mimeType} không được hỗ trợ!`);

    newS3Key = `${mimeInfo.folder}/${newMessageId}.${mimeInfo.ext}`;
    try {
      await s3.copyObject({
        Bucket: bucketName,
        CopySource: `${bucketName}/${originalKey}`,
        Key: newS3Key,
        ContentType: mimeType,
      }).promise();
      newMediaUrl = `s3://${bucketName}/${newS3Key}`;
    } catch (s3Error) {
      console.error('Lỗi khi sao chép file S3:', s3Error);
      throw new Error(`Lỗi khi sao chép file S3: ${s3Error.message}`);
    }
  }

  const baseMessage = {
    messageId: newMessageId,
    senderId,
    receiverId: targetReceiverId,
    type: originalMessage.Item.type,
    content: originalMessage.Item.content,
    mediaUrl: newMediaUrl,
    fileName: originalMessage.Item.fileName,
    mimeType: originalMessage.Item.mimeType,
    metadata: { ...originalMessage.Item.metadata, forwardedFrom: messageId },
    isAnonymous: false,
    isSecret: false,
    quality: originalMessage.Item.quality,
    timestamp: new Date().toISOString(),
    status: 'sending',
  };

  const senderMessage = {
    ...baseMessage,
    ownerId: senderId,
    expiresAt: senderExpiresAt,
  };

  const receiverMessage = {
    ...baseMessage,
    ownerId: targetReceiverId,
    expiresAt: receiverExpiresAt,
  };

  console.log('Forwarding sender message:', senderMessage);
  console.log('Forwarding receiver message:', receiverMessage);

  try {
    await Promise.all([
      sendMessageCore(senderMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send),
      sendMessageCore(receiverMessage, 'Messages', process.env.BUCKET_NAME_Chat_Send),
    ]);

    const receiverOnline = isUserOnline(targetReceiverId);
    const initialStatus = receiverOnline ? 'delivered' : 'sent';

    console.log('Updating status for forwarded message:', { newMessageId, senderId, targetReceiverId, initialStatus });

    const updateResults = await Promise.allSettled([
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: newMessageId, ownerId: senderId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': initialStatus },
      }).promise().catch(err => {
        console.error('Error updating sender forwarded message status:', err);
        throw err;
      }),
      dynamoDB.update({
        TableName: 'Messages',
        Key: { messageId: newMessageId, ownerId: targetReceiverId },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': initialStatus },
      }).promise().catch(err => {
        console.error('Error updating receiver forwarded message status:', err);
        throw err;
      }),
    ]);

    if (updateResults.some(result => result.status === 'rejected') && newS3Key) {
      await s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: newS3Key }).promise();
      console.error('Update status failed:', updateResults.filter(result => result.status === 'rejected').map(result => result.reason));
      throw new Error('Cập nhật trạng thái tin nhắn thất bại!');
    }

    console.log('Sender expiresAt:', senderExpiresAt || 'Not set (never)');
    console.log('Receiver expiresAt:', receiverExpiresAt || 'Not set (never)');

    io().to(targetReceiverId).emit('receiveMessage', { ...receiverMessage, status: initialStatus });
    io().to(senderId).emit('receiveMessage', { ...senderMessage, status: initialStatus });
    return { ...baseMessage, status: initialStatus };
  } catch (error) {
    if (newS3Key) {
      await s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: newS3Key }).promise();
    }
    console.error('Error in forwardMessage:', error);
    throw error;
  }
};

// Hàm thu hồi tin nhắn với mọi người
const recallMessage = async (senderId, messageId) => {
  console.log('Recalling message:', { messageId, senderId });

  // Lấy bản ghi tin nhắn của người gửi
  const message = await dynamoDB.get({
    TableName: 'Messages',
    Key: { messageId, ownerId: senderId },
  }).promise().catch(err => {
    console.error('Error getting message in recallMessage:', err);
    throw err;
  });

  if (!message.Item) throw new Error('Tin nhắn không tồn tại!');
  if (message.Item.senderId !== senderId) throw new Error('Bạn không có quyền thu hồi tin nhắn này!');

  const timeDiffHours = (new Date() - new Date(message.Item.timestamp)) / (1000 * 60 * 60);
  if (timeDiffHours > 24) throw new Error('Không thể thu hồi tin nhắn sau 24 giờ!');

  // Cập nhật isRecalled cho cả hai bản ghi
  await Promise.all([
    dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: senderId },
      UpdateExpression: 'SET isRecalled = :r',
      ExpressionAttributeValues: { ':r': true },
    }).promise().catch(err => {
      console.error('Error updating isRecalled for sender:', err);
      throw err;
    }),
    dynamoDB.update({
      TableName: 'Messages',
      Key: { messageId, ownerId: message.Item.receiverId },
      UpdateExpression: 'SET isRecalled = :r',
      ExpressionAttributeValues: { ':r': true },
    }).promise().catch(err => {
      console.error('Error updating isRecalled for receiver:', err);
      throw err;
    }),
  ]);

  // Xóa media trên S3 nếu có
  if (message.Item.mediaUrl) {
    const key = message.Item.mediaUrl.split('/').slice(3).join('/');
    await s3.deleteObject({ Bucket: process.env.BUCKET_NAME_Chat_Send, Key: key }).promise().catch(err => {
      console.error('Error deleting S3 object:', err);
    });
  }

  io().to(message.Item.receiverId).emit('messageRecalled', { messageId });
  io().to(senderId).emit('messageRecalled', { messageId });
  return { success: true, message: 'Tin nhắn đã được thu hồi!' };
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

// Hàm ẩn hội thoại
const hideConversation = async (userId, hiddenUserId, password) => {
  const hashedPassword = await bcrypt.hash(password, 10);
  const hiddenData = JSON.stringify({ hiddenUserId, password: hashedPassword });
  await redisClient.set(`hidden:${userId}:${hiddenUserId}`, hiddenData);
  return { success: true, message: 'Đã ẩn cuộc trò chuyện!' };
};

// Hàm bỏ ẩn hội thoại
const unhideConversation = async (userId, hiddenUserId, password) => {
  const hiddenData = await redisClient.get(`hidden:${userId}:${hiddenUserId}`);
  if (!hiddenData) throw new Error('Cuộc trò chuyện không được ẩn!');
  const { password: hashedPassword } = JSON.parse(hiddenData);
  const isMatch = await bcrypt.compare(password, hashedPassword);
  if (!isMatch) throw new Error('Mật khẩu không đúng!');
  await redisClient.del(`hidden:${userId}:${hiddenUserId}`);
  return { success: true, message: 'Đã mở ẩn cuộc trò chuyện!' };
};

// Hàm lấy danh sách hội thoại ẩn
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

// Hàm đặt tên gợi nhớ
const setConversationNickname = async (userId, targetUserId, nickname) => {
  await redisClient.set(`nickname:${userId}:${targetUserId}`, nickname);
  return { success: true, message: 'Đã đặt tên gợi nhớ!' };
};

// Hàm lấy tên gợi nhớ
const getConversationNickname = async (userId, targetUserId) => {
  return await redisClient.get(`nickname:${userId}:${targetUserId}`);
};

// Hàm kiểm tra chặn
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

module.exports = {
  createMessage,
  getMessagesBetweenUsers,
  getConversationUsers,
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