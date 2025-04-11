const { dynamoDB, s3, transcribe } = require('../config/aws.config');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const sendMessageCore = async (message, tableName, bucketName) => {
  const { 
    type, content, file, fileName, mimeType, metadata, mediaUrl,
    isAnonymous, isSecret, quality, replyToMessageId ,expiresAt
  } = message;

  console.log('Core - type:', type);
  console.log('Core - content:', content);

  // Danh sách loại tin nhắn hợp lệ
  const validTypes = ['text', 'image', 'file', 'video', 'voice', 'sticker', 'gif', 'location', 'contact', 'poll', 'event'];
  if (!validTypes.includes(type)) throw new Error('Loại tin nhắn không hợp lệ!');

  // Kiểm tra input hợp lệ
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

  // MIME type và cấu hình upload
  const mimeTypeMap = {
    'image/jpeg': { type: 'image', folder: 'images', ext: 'jpg', maxSize: 10 * 1024 * 1024 },
    'image/png': { types: ['image', 'sticker'], folder: 'images', ext: 'png', maxSize: 10 * 1024 * 1024 },
    'image/heic': { type: 'image', folder: 'images', ext: 'heic', maxSize: 10 * 1024 * 1024 },
    'image/gif':{ type: ['gif', 'sticker'], folder: 'gifs', ext: 'gif', maxSize: 10 * 1024 * 1024 },
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

  let finalMediaUrl = mediaUrl; // Sử dụng mediaUrl từ tin nhắn gốc nếu có
  let s3Key = null;
  if (['image', 'file', 'video', 'voice', 'sticker','gif'].includes(type) && !finalMediaUrl) {
    const mimeInfo = mimeTypeMap[mimeType];
    if (!mimeInfo) throw new Error(`MIME type ${mimeType} không được hỗ trợ!`);
    if (!mimeInfo.type.includes(type)) throw new Error(`MIME type ${mimeType} không phù hợp với loại tin nhắn ${type}!`);
    if (file.length > mimeInfo.maxSize) {
      throw new Error(`File vượt quá dung lượng tối đa (${mimeInfo.maxSize / 1024 / 1024}MB)!`);
    }

    let processedFile = file;
    if (type === 'image' && quality === 'compressed') {
      processedFile = await sharp(file).jpeg({ quality: 80 }).toBuffer();
    }
    const messageId = message.messageId || uuidv4();
    s3Key = `${mimeInfo.folder}/${messageId}.${mimeInfo.ext}`;
    try {
      await s3
        .upload({
          Bucket: bucketName,
          Key: s3Key,
          Body: processedFile,
          ContentType: mimeType,
        })
        .promise();
        finalMediaUrl = `s3://${bucketName}/${s3Key}`;
    } catch (s3Error) {
      throw new Error(`Lỗi khi upload file lên S3: ${s3Error.message}`);
    }
  }

  // Tạo object tin nhắn để lưu
  let messageToSave = {};
  const messageId = message.messageId || uuidv4();

  if (tableName === 'Messages') {
      messageToSave = {
      messageId,
      senderId: message.senderId,
      receiverId: message.receiverId,
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
      isRecalled: false,
      isPinned: false,
      reminder: null,
      timestamp: new Date().toISOString(),
      expiresAt
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
      isRecalled: false,
      isPinned: false,
      reminder: null,
      timestamp: new Date().toISOString(),
      
    };
  }

  // Xử lý transcribe cho tin nhắn thoại
  if (type === 'voice' && metadata?.transcribe) {
    const transcribeJobName = `voice-${messageToSave.messageId}`;
    try {
      await transcribe
        .startTranscriptionJob({
          LanguageCode: 'vi-VN',
          Media: { MediaFileUri: finalMediaUrl },
          OutputBucketName: bucketName,
          TranscriptionJobName: transcribeJobName,
        })
        .promise();
      messageToSave.metadata = {
        ...messageToSave.metadata,
        transcript: `s3://${bucketName}/${transcribeJobName}.json`,
        transcribeStatus: 'IN_PROGRESS',
      };
    } catch (transcribeError) {
      console.error('Lỗi khi tạo job transcribe:', transcribeError);
      throw new Error(`Lỗi khi tạo job transcribe: ${transcribeError.message}`);
    }
  }

  // Lưu vào DynamoDB
  try {
    console.log('Saving to DynamoDB:', messageToSave);
    await dynamoDB.put({
      TableName: tableName,
      Item: messageToSave,
    }).promise();
  } catch (dbError) {
    console.error('DynamoDB error:', dbError);
    if (finalMediaUrl && s3Key) {
      await s3.deleteObject({ Bucket: bucketName, Key: s3Key }).promise();
    }
    throw new Error(`Lỗi khi lưu tin nhắn vào DynamoDB: ${dbError.message}`);
  }

  console.log('Core - Đã gửi tin nhắn:', messageToSave);
  return messageToSave;
};

module.exports = { sendMessageCore };