const { s3 } = require('../config/aws.config');
const sharp = require('sharp');
const logger = require('../config/logger');
const { MESSAGE_STATUSES, MIME_TYPE_MAP } = require('../config/constants');
const { transcribeQueue } = require('../socket');

const copyS3File = async (bucketName, originalKey, newMessageId, mimeType) => {
  const mimeInfo = MIME_TYPE_MAP[mimeType];
  if (!mimeInfo) throw new Error(`Unsupported MIME type: ${mimeType}`);

  const newS3Key = `${mimeInfo.folder}/${newMessageId}.${mimeInfo.ext}`;
  try {
    await s3
      .copyObject({
        Bucket: bucketName,
        CopySource: `${bucketName}/${originalKey}`,
        Key: newS3Key,
        ContentType: mimeType,
      })
      .promise();
    return { mediaUrl: `s3://${bucketName}/${newS3Key}`, s3Key: newS3Key };
  } catch (error) {
    logger.error(`Error copying S3 file`, { error: error.message });
    throw new Error(`Failed to copy S3 file: ${error.message}`);
  }
};

const uploadS3File = async (bucketName, messageId, file, mimeType, type, quality) => {
  const mimeInfo = MIME_TYPE_MAP[mimeType];
  if (!mimeInfo) throw new Error(`MIME type không được hỗ trợ: ${mimeType}`);
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
    } catch (error) {
      logger.error('Lỗi khi nén ảnh:', error);
      throw new Error('Lỗi khi nén ảnh!');
    }
  }

  const s3Key = `${mimeInfo.folder}/${messageId}.${mimeInfo.ext}`;
  try {
    await s3
      .upload({
        Bucket: bucketName,
        Key: s3Key,
        Body: processedFile,
        ContentType: mimeType,
      })
      .promise();
    return { mediaUrl: `s3://${bucketName}/${s3Key}`, s3Key };
  } catch (error) {
    logger.error('Lỗi khi upload file lên S3:', error);
    throw new Error(`Lỗi khi upload file lên S3: ${error.message}`);
  }
};

const addTranscribeJob = async (messageId, ownerId, tableName, bucketName, mediaUrl, transcribeJobName) => {
  try {
    await transcribeQueue().add(
      { messageId, ownerId, tableName, bucketName, mediaUrl, transcribeJobName },
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
    );
    logger.info('Đã thêm job phiên âm vào hàng đợi', { messageId, transcribeJobName });
  } catch (error) {
    logger.error('Lỗi khi thêm job phiên âm:', error);
    throw new Error(`Lỗi khi thêm job phiên âm: ${error.message}`);
  }
};

const getInitialStatus = (isRestricted, isReceiverOnline, isSelfMessage) => {
  if (isSelfMessage) return MESSAGE_STATUSES.SENT;
  if (isRestricted) return MESSAGE_STATUSES.RESTRICTED;
  return isReceiverOnline ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.SENT;
};

const parseEmoji = (content) => {
    const emojiMap = { ':smile:': '😊', ':heart:': '❤️', ':thumbsup:': '👍' };
    return content
      ? Object.keys(emojiMap).reduce(
          (text, key) => text.replace(key, emojiMap[key]),
          content
        )
      : content;
};

module.exports = { copyS3File, uploadS3File, addTranscribeJob, getInitialStatus ,parseEmoji};