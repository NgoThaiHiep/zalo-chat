const { dynamoDB, s3 } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { transcribeQueue } = require('../socket');
const logger = require('../config/logger');

const sendMessageCore = async (message, tableName, bucketName) => {
  const {
    type,
    content,
    file,
    fileName,
    mimeType,
    metadata,
    mediaUrl,
    isAnonymous,
    isSecret,
    quality,
    replyToMessageId,
    expiresAt,
    senderId,
    receiverId,
    ownerId,
    status: initialStatus,
  } = message;

  logger.info('Core - Sending message', { type, senderId, receiverId, ownerId });

  // Kiểm tra ownerId
  if (tableName === 'Messages' && ownerId !== senderId && ownerId !== receiverId) {
    throw new Error('ownerId phải là senderId hoặc receiverId!');
  }

  // Kiểm tra loại tin nhắn
  const validTypes = ['text', 'image', 'file', 'video', 'voice', 'sticker', 'gif', 'location', 'contact', 'poll', 'event'];
  if (!validTypes.includes(type)) {
    throw new Error(`Loại tin nhắn không hợp lệ: ${type}`);
  }

  // Hàm kiểm tra đầu vào
  const validateInput = () => {
    switch (type) {
      case 'text':
        if (!content || typeof content !== 'string' || content.trim() === '') {
          throw new Error('Nội dung văn bản không hợp lệ!');
        }
        break;
      case 'image':
      case 'file':
      case 'video':
      case 'voice':
      case 'sticker':
      case 'gif':
        if (!mediaUrl && (!file || !Buffer.isBuffer(file) || !mimeType)) {
          throw new Error('File hoặc MIME type không hợp lệ!');
        }
        if (mediaUrl && !mimeType) {
          throw new Error('MIME type không hợp lệ khi có mediaUrl!');
        }
        break;
      case 'location':
        if (!metadata?.latitude || !metadata?.longitude) {
          throw new Error('Vị trí cần có latitude và longitude!');
        }
        break;
      case 'contact':
        if (!metadata?.name || !metadata?.phone) {
          throw new Error('Danh bạ cần có tên và số điện thoại!');
        }
        break;
      case 'poll':
        if (!metadata?.question || !Array.isArray(metadata.options)) {
          throw new Error('Khảo sát cần có câu hỏi và danh sách tùy chọn!');
        }
        break;
      case 'event':
        if (!metadata?.title || !metadata?.date) {
          throw new Error('Sự kiện cần có tiêu đề và ngày!');
        }
        break;
    }
  };

  validateInput();

  // Kiểm tra senderId và receiverId cho bảng Messages
  if (tableName === 'Messages' && (!senderId || !receiverId)) {
    throw new Error('senderId hoặc receiverId không hợp lệ!');
  }

  // Định nghĩa MIME type
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

  let finalMediaUrl = mediaUrl;
  let s3Key = null;

  // Xử lý file upload lên S3
  if (['image', 'file', 'video', 'voice', 'sticker', 'gif'].includes(type) && !finalMediaUrl && file) {
    const mimeInfo = mimeTypeMap[mimeType];
    if (!mimeInfo) {
      throw new Error(`MIME type không được hỗ trợ: ${mimeType}`);
    }
    if (!Array.isArray(mimeInfo.type) ? mimeInfo.type !== type : !mimeInfo.type.includes(type)) {
      throw new Error(`MIME type ${mimeType} không phù hợp với loại tin nhắn ${type}!`);
    }
    if (file.length > mimeInfo.maxSize) {
      throw new Error(`File vượt quá dung lượng tối đa (${mimeInfo.maxSize / 1024 / 1024}MB)!`);
    }

    let processedFile = file;
    if (type === 'image' && quality === 'compressed') {
      try {
        processedFile = await sharp(file).jpeg({ quality: 80 }).toBuffer();
      } catch (sharpError) {
        logger.error('Lỗi khi nén ảnh:', sharpError);
        throw new Error('Lỗi khi nén ảnh!');
      }
    }

    const messageId = message.messageId || uuidv4();
    s3Key = `${mimeInfo.folder}/${messageId}.${mimeInfo.ext}`;
    try {
      await s3.upload({
        Bucket: bucketName,
        Key: s3Key,
        Body: processedFile,
        ContentType: mimeType,
      }).promise();
      finalMediaUrl = `s3://${bucketName}/${s3Key}`;
    } catch (s3Error) {
      logger.error('Lỗi khi upload file lên S3:', s3Error);
      throw new Error(`Lỗi khi upload file lên S3: ${s3Error.message}`);
    }
  }

  // Chuẩn bị bản ghi tin nhắn
  const messageId = message.messageId || uuidv4();
  const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (expiresAt && isNaN(parsedExpiresAt)) {
    throw new Error('expiresAt không đúng định dạng ISO!');
  }

  let messageToSave = {};
  if (tableName === 'Messages') {
    messageToSave = {
      messageId,
      ownerId,
      senderId,
      receiverId,
      type,
      content: content || null,
      mediaUrl: finalMediaUrl,
      fileName,
      mimeType,
      metadata: metadata || null,
      isAnonymous,
      isSecret,
      quality,
      replyToMessageId: replyToMessageId || null,
      isPinned: false,
      status: initialStatus || (senderId === receiverId ? 'sent' : 'sending'),
      timestamp: new Date().toISOString(),
      expiresAt: expiresAt ? parsedExpiresAt.toISOString() : null,
    };
  } else if (tableName === 'GroupMessages') {
    messageToSave = {
      groupId: message.groupId,
      messageId,
      senderId: isAnonymous ? null : message.senderId,
      type,
      content: content ? content.trim() : null,
      mediaUrl: finalMediaUrl,
      fileName,
      mimeType,
      metadata: metadata || null,
      isAnonymous,
      isSecret,
      quality,
      replyToMessageId: replyToMessageId || null,
      isPinned: false,
      status: initialStatus || 'sending',
      timestamp: new Date().toISOString(),
      expiresAt: expiresAt ? parsedExpiresAt.toISOString() : null,
    };
  }

  // Xử lý phiên âm cho tin nhắn thoại
  if (type === 'voice' && metadata?.transcribe) {
    const transcribeJobName = `voice-${messageId}-${ownerId}`;
    messageToSave.metadata = {
      ...messageToSave.metadata,
      transcript: `s3://${bucketName}/${transcribeJobName}.json`,
      transcribeStatus: 'QUEUED',
    };
    try {
      await transcribeQueue().add(
        {
          messageId,
          ownerId,
          tableName,
          bucketName,
          mediaUrl: finalMediaUrl,
          transcribeJobName,
        },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
      );
      logger.info('Đã thêm job phiên âm vào hàng đợi', { messageId, transcribeJobName });
    } catch (queueError) {
      logger.error('Lỗi khi thêm job phiên âm:', queueError);
      throw new Error(`Lỗi khi thêm job phiên âm vào hàng đợi: ${queueError.message}`);
    }
  }

  // Lưu tin nhắn vào DynamoDB
  try {
    logger.info('Saving message to DynamoDB:', { messageId, tableName, ownerId });
    await dynamoDB.put({
      TableName: tableName,
      Item: messageToSave,
    }).promise();
  } catch (dbError) {
    logger.error('Lỗi khi lưu tin nhắn vào DynamoDB:', dbError);
    if (finalMediaUrl && s3Key) {
      try {
        await s3.deleteObject({ Bucket: bucketName, Key: s3Key }).promise();
        logger.info('Đã xóa file S3 sau lỗi DynamoDB', { s3Key });
      } catch (s3CleanupError) {
        logger.error('Lỗi khi xóa file S3 sau lỗi DynamoDB:', s3CleanupError);
      }
    }
    throw new Error(`Lỗi khi lưu tin nhắn vào DynamoDB: ${dbError.message}`);
  }

  logger.info('Core - Đã gửi tin nhắn thành công:', { messageId, tableName, ownerId });
  return messageToSave;
};

module.exports = { sendMessageCore };