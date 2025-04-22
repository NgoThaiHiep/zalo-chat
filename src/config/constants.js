// src/config/constants.js
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
    RESTRICTED: 'restricted',
    DELETE: 'delete',
    ADMINDRECALLED: 'admin-recalled',
  };
  
  const MIME_TYPE_MAP = {
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

  const GET_DEFAULT_CONTENT_BY_TYPE = (type) => {
    switch (type) {
      case 'image':
        return '[Hình ảnh]';
      case 'gif':
        return '[GIF]';
      case 'sticker':
        return '[Nhãn dán]';
      case 'video':
        return '[Video]';
      case 'voice':
        return '[Tin nhắn thoại]';
      case 'file':
        return '[Tệp tin]';
      default:
        return `[${type}]`;
    }
  };
  
  
  module.exports = { DAYS_TO_SECONDS, MESSAGE_STATUSES, MIME_TYPE_MAP,GET_DEFAULT_CONTENT_BY_TYPE };