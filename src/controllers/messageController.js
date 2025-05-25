const { log } = require('winston');
const MessageService = require('../services/message.service');
const multer = require('multer');
const { isValidUUID } = require('../utils/helpers');
const logger = require('../config/logger');
const upload = require('../middlewares/upload');
const { AppError } = require('../utils/errorHandler');

const sendMessageController = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, type, content, metadata, isAnonymous = 'false', isSecret = 'false', quality = 'original', expiresAfter } = req.body;
    const file = req.file ? req.file.buffer : null;
    const fileName = req.file ? req.file.originalname : null;
    const mimeType = req.file ? req.file.mimetype : null;

    if (!receiverId || !type) {
      throw new AppError('receiverId và type là bắt buộc', 400);
    }
    if (!isValidUUID(receiverId)) {
      throw new AppError('receiverId không hợp lệ', 400);
    }
    if (['image', 'file', 'video', 'voice', 'sticker', 'gif'].includes(type) && !req.file) {
      throw new AppError(`File là bắt buộc cho loại tin nhắn ${type}`, 400);
    }

    const messageData = {
      type,
      content: content || null,
      file,
      fileName,
      mimeType,
      metadata: metadata ? JSON.parse(metadata) : null,
      isAnonymous: isAnonymous === 'true' || isAnonymous === true,
      isSecret: isSecret === 'true' || isSecret === true,
      quality,
      expiresAfter,
    };

    const newMessage = await MessageService.createMessage(senderId, receiverId, messageData);
    req.io.of('/chat').to(`user:${senderId}`).emit('receiveMessage', newMessage);
    if (senderId !== receiverId) {
      req.io.of('/chat').to(`user:${receiverId}`).emit('receiveMessage', newMessage);
    }
    logger.info(`[MessageController] Emitted receiveMessage to user:${senderId} and user:${receiverId}`);
    res.status(201).json({ success: true, data: newMessage });
  } catch (error) {
    logger.error('[sendMessageController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi gửi tin nhắn', error.statusCode || 500);
  }
};

const getMessagesBetweenController = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.id;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId là bắt buộc!' });
    }

    console.log('Đang lấy tin nhắn cho:', { currentUserId, userId });

    const messages = await MessageService.getMessagesBetweenUsers(currentUserId, userId);
    if (!messages.success) {
      return res.status(500).json({ success: false, message: messages.error });
    }

    res.json(messages);
  } catch (error) {
    console.error('Lỗi trong getMessagesBetweenController:', error);
    res.status(500).json({ success: false, message: 'Lỗi server', error: error.message });
  }
};

const forwardMessageController = async (req, res) => {
  try {
    const { messageId, targetReceiverId } = req.body;
    const senderId = req.user.id;
    console.log('Sender ID:', senderId);
    console.log('Forward message request:', { senderId, messageId, targetReceiverId });

    if (!messageId || !targetReceiverId) {
      return res.status(400).json({ success: false, message: 'Thiếu messageId hoặc targetReceiverId' });
    }

    const result = await MessageService.forwardMessage(senderId, messageId, targetReceiverId);

    try {
      req.io.of('/chat').to(`user:${senderId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
      logger.info(`[Controller] Emitted receiveMessage to user:${senderId}`);
    } catch (error) {
      logger.error(`[Controller] Error emitting receiveMessage`, { error: error.message });
    }
    if (senderId !== targetReceiverId) {
      req.io.of('/chat').to(`user:${targetReceiverId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
    }

    logger.info(`[MessageController] Emitted receiveMessage to user:${senderId} and user:${targetReceiverId}`);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error in forwardMessageController:', error);
    const statusCode =
      error.message.includes('là bắt buộc') ||
      error.message.includes('Thiếu') ||
      error.message.includes('Tham số không hợp lệ')
        ? 400
        : error.message.includes('không tồn tại') || error.message.includes('quyền')
        ? 403
        : 500;
    return res.status(statusCode).json({ success: false, message: error.message });
  }
};

const forwardMessageToGroupController = async (req, res) => {
  try {
    const { messageId, targetGroupId } = req.body;
    const senderId = req.user.id;
    console.log('Sender ID:', senderId);
    console.log('Forward message to group request:', { senderId, messageId, targetGroupId });

    if (!messageId || !targetGroupId) {
      return res.status(400).json({ success: false, message: 'Thiếu messageId hoặc targetGroupId' });
    }

    const result = await MessageService.forwardMessageToGroup(senderId, messageId, targetGroupId);

    req.io.of('/group').to(`group:${targetGroupId}`).emit('newGroupMessage', {
      success: true,
      data: {
        groupId: targetGroupId,
        message: result,
      },
    });

    try {
      req.io.of('/chat').to(`user:${senderId}`).emit('receiveMessage', {
        success: true,
        data: result,
      });
      logger.info(`[Controller] Emitted receiveMessage to user:${senderId}`);
    } catch (error) {
      logger.error(`[Controller] Error emitting receiveMessage`, { error: error.message });
    }

    logger.info(`[MessageController] Emitted newGroupMessage to group:${targetGroupId} and receiveMessage to user:${senderId}`);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error in forwardMessageToGroupController:', error);
    const statusCode =
      error.message.includes('là bắt buộc') ||
      error.message.includes('Thiếu') ||
      error.message.includes('Tham số không hợp lệ')
        ? 400
        : error.message.includes('không tồn tại') || error.message.includes('quyền')
        ? 403
        : 500;
    return res.status(statusCode).json({ success: false, message: error.message });
  }
};

const recallMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    if (!messageId) {
      throw new AppError('messageId là bắt buộc', 400);
    }
    if (!isValidUUID(messageId)) {
      throw new AppError('messageId không hợp lệ', 400);
    }
    const result = await MessageService.recallMessage(userId, messageId);
    const message = await MessageService.getMessageById(messageId, userId);
    if (message) {
      req.io.of('/chat').to(`user:${userId}`).emit('messageRecalled', { messageId });
      if (message.senderId !== userId) {
        req.io.of('/chat').to(`user:${message.receiverId}`).emit('messageRecalled', { messageId });
      }
    }
    logger.info(`[MessageController] Emitted messageRecalled to user:${userId} and user:${message?.receiverId}`);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    logger.error('[recallMessageController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi thu hồi tin nhắn', error.statusCode || 403);
  }
};

const pinMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.pinMessage(senderId, messageId);

    // Phát sự kiện messagePinned tới phòng conversation
    const message = await MessageService.getMessageById(messageId, senderId);
    if (message) {
      const otherUserId = message.senderId === senderId ? message.receiverId : message.senderId;
      const room = `conversation:${[senderId, otherUserId].sort().join(':')}`;
      req.io.of('/chat').to(room).emit('messagePinned', { messageId, otherUserId });
      logger.info('[MessageController] Emitted messagePinned to room', { room, messageId });
    }

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const unpinMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    if (!messageId) {
      return res.status(400).json({ success: false, message: 'messageId là bắt buộc!' });
    }

    console.log('Unpin message request:', { userId, messageId });

    const result = await MessageService.unpinMessage(userId, messageId);

    // Phát sự kiện messageUnpinned tới phòng conversation
    const message = await MessageService.getMessageById(messageId, userId);
    if (message) {
      const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;
      const room = `conversation:${[userId, otherUserId].sort().join(':')}`;
      req.io.of('/chat').to(room).emit('messageUnpinned', { messageId, otherUserId });
      logger.info('[MessageController] Emitted messageUnpinned to room', { room, messageId });
    }

    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const getPinnedMessagesController = async (req, res) => {
  try {
    const { otherUserId } = req.params;
    const userId = req.user.id;

    if (!otherUserId) {
      return res.status(400).json({ success: false, message: 'otherUserId là bắt buộc!' });
    }

    console.log('Get pinned messages request:', { userId, otherUserId });

    const result = await MessageService.getPinnedMessages(userId, otherUserId);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Error in getPinnedMessagesController:', error);
    res.status(500).json({ success: false, message: error.message || 'Không thể lấy tin nhắn ghim' });
  }
};

const deleteMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    if (!messageId) {
      return res.status(400).json({ success: false, message: 'messageId là bắt buộc!' });
    }

    console.log('Delete message request:', { userId, messageId });

    const result = await MessageService.deleteMessage(userId, messageId);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const restoreMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.restoreMessage(senderId, messageId);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const retryMessageController = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { messageId } = req.body;

    if (!messageId) {
      return res.status(400).json({ success: false, message: 'messageId là bắt buộc!' });
    }

    const result = await MessageService.retryMessage(senderId, messageId);
    res.status(200).json({
      success: true,
      message: 'Gửi lại tin nhắn thành công!',
      data: result,
    });
  } catch (error) {
    const statusCode = error.message.includes('không tồn tại') ? 404 : error.message.includes('quyền') ? 403 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
  }
};

const markMessageAsSeenController = async (req, res) => {
  try {
    console.log("Current req.user:", req.user);
    const userId = req.user.id;
    const { messageId } = req.params;
    console.log("Mark message as seen request:", { userId, messageId });
    const result = await MessageService.markMessageAsSeen(userId, messageId);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    const statusCode = error.message.includes('không tồn tại') ? 404 : error.message.includes('quyền') ? 403 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
  }
};

const checkBlockStatusController = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId } = req.body;

    if (!receiverId) {
      return res.status(400).json({
        success: false,
        message: 'receiverId là bắt buộc!',
      });
    }

    await MessageService.checkBlockStatus(senderId, receiverId);

    res.status(200).json({
      success: true,
      message: 'Không có trạng thái chặn giữa hai người dùng.',
      data: {
        senderId,
        receiverId,
        isSenderBlocked: false,
        isReceiverBlocked: false,
      },
    });
  } catch (error) {
    const statusCode = error.message.includes('không thể gửi tin nhắn') ? 403 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  sendMessageController: [upload.single('file'), sendMessageController],
  getMessagesBetweenController,
  forwardMessageController,
  forwardMessageToGroupController,
  recallMessageController,
  pinMessageController,
  unpinMessageController,
  getPinnedMessagesController,
  deleteMessageController,
  restoreMessageController,
  retryMessageController,
  markMessageAsSeenController,
  checkBlockStatusController,
};