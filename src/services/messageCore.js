// src/services/messageCore.js
const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const logger = require('../config/logger');
const { uploadS3File, addTranscribeJob, parseEmoji } = require('../utils/messageUtils');
const { MIME_TYPE_MAP, MESSAGE_STATUSES } = require('../config/constants');
const { AppError } = require('../utils/errorHandler');

const sendMessageCore = async (message, tableName, bucketName) => {
  const {
    type,
    content,
    file,
    fileName,
    mimeType,
    metadata = {},
    mediaUrl,
    isAnonymous = false,
    isSecret = false,
    quality,
    replyToMessageId,
    expiresAt,
    senderId,
    receiverId,
    ownerId,
    groupId,
    status: initialStatus = MESSAGE_STATUSES.SENDING,
  } = message;

  logger.info('Core - Sending message', { type, senderId, receiverId, ownerId, groupId });

  // Input validation
  if (!type || (tableName === 'Messages' && (!senderId || !receiverId || !ownerId)) || (tableName === 'GroupMessages' && !groupId)) {
    throw new AppError('Missing required message parameters', 400);
  }
  if (tableName === 'Messages' && ownerId !== senderId && ownerId !== receiverId) {
    throw new AppError('ownerId phải là senderId hoặc receiverId!', 400);
  }

  // Validate message type
  const validTypes = ['text', 'image', 'file', 'video', 'voice', 'sticker', 'gif', 'location', 'contact', 'poll', 'event'];
  if (!validTypes.includes(type)) {
    throw new AppError(`Loại tin nhắn không hợp lệ: ${type}`, 400);
  }

  // Validate input based on message type
  const validateInput = () => {
    switch (type) {
      case 'text':
        if (!content || typeof content !== 'string' || content.trim() === '') {
          throw new AppError('Nội dung văn bản không hợp lệ!', 400);
        }
        break;
      case 'image':
      case 'file':
      case 'video':
      case 'voice':
      case 'sticker':
      case 'gif':
        if (!mediaUrl && (!file || !Buffer.isBuffer(file) || !mimeType)) {
          throw new AppError('File hoặc MIME type không hợp lệ!', 400);
        }
        if (mediaUrl && !mimeType) {
          throw new AppError('MIME type không hợp lệ khi có mediaUrl!', 400);
        }
        break;
      case 'location':
        if (!metadata?.latitude || !metadata?.longitude) {
          throw new AppError('Vị trí cần có latitude và longitude!', 400);
        }
        break;
      case 'contact':
        if (!metadata?.name || !metadata?.phone) {
          throw new AppError('Danh bạ cần có tên và số điện thoại!', 400);
        }
        break;
      case 'poll':
        if (!metadata?.question || !Array.isArray(metadata.options)) {
          throw new AppError('Khảo sát cần có câu hỏi và danh sách tùy chọn!', 400);
        }
        break;
      case 'event':
        if (!metadata?.title || !metadata?.date) {
          throw new AppError('Sự kiện cần có tiêu đề và ngày!', 400);
        }
        break;
    }
  };
  validateInput();

  // Parse emojis for text messages
  const parsedContent = type === 'text' ? parseEmoji(content) : content;

  // Handle file upload
  let finalMediaUrl = mediaUrl;
  let s3Key = null;
  const messageId = message.messageId || uuidv4();

  if (['image', 'file', 'video', 'voice', 'sticker', 'gif'].includes(type) && !finalMediaUrl && file) {
    ({ mediaUrl: finalMediaUrl, s3Key } = await uploadS3File(bucketName, messageId, file, mimeType, type, quality));
  }

  // Validate expiresAt
  const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (expiresAt && isNaN(parsedExpiresAt)) {
    throw new AppError('expiresAt không đúng định dạng ISO!', 400);
  }

  // Prepare message record
  const messageToSave = tableName === 'Messages'
    ? {
        messageId,
        ownerId,
        senderId,
        receiverId,
        type,
        content: content || null,
        mediaUrl: finalMediaUrl,
        fileName: fileName || null,
        mimeType: mimeType || null,
        metadata: metadata || null,
        isAnonymous,
        isSecret,
        quality,
        replyToMessageId: replyToMessageId || null,
        isPinned: false,
        status: initialStatus,
        timestamp: new Date().toISOString(),
        expiresAt: expiresAt ? parsedExpiresAt.toISOString() : null,
      }
    : {
        groupId,
        messageId,
        senderId: isAnonymous ? null : senderId,
        type,
        content: parsedContent || null,
        mediaUrl: finalMediaUrl,
        fileName: fileName || null,
        mimeType: mimeType || null,
        metadata: metadata || null,
        isAnonymous,
        isSecret,
        quality,
        replyToMessageId: replyToMessageId || null,
        isPinned: false,
        status: initialStatus,
        timestamp: new Date().toISOString(),
        expiresAt: expiresAt ? parsedExpiresAt.toISOString() : null,
      };

  // Handle transcription
  if (type === 'voice' && metadata?.transcribe) {
    const transcribeJobName = `voice-${messageId}-${groupId || ownerId}`;
    messageToSave.metadata = {
      ...metadata,
      transcript: `s3://${bucketName}/${transcribeJobName}.json`,
      transcribeStatus: 'QUEUED',
    };
    await addTranscribeJob(messageId, groupId || ownerId, tableName, bucketName, finalMediaUrl, transcribeJobName);
  }

  // Save to DynamoDB
  try {
    await dynamoDB
      .put({
        TableName: tableName,
        Item: messageToSave,
      })
      .promise();
    logger.info('Saved message to DynamoDB:', { messageId, tableName, ownerId, groupId });
  } catch (error) {
    if (finalMediaUrl && s3Key) {
      await s3.deleteObject({ Bucket: bucketName, Key: s3Key }).promise().catch(s3Error => {
        logger.error('Lỗi khi xóa file S3 sau lỗi DynamoDB:', s3Error);
      });
    }
    logger.error('Lỗi khi lưu tin nhắn vào DynamoDB:', error);
    throw new AppError(`Lỗi khi lưu tin nhắn vào DynamoDB: ${error.message}`, 500);
  }

  logger.info('Core - Đã gửi tin nhắn thành công:', { messageId, tableName, ownerId, groupId });
  return messageToSave;
};

module.exports = { sendMessageCore };