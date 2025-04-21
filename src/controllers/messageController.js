const { log } = require('winston');
const MessageService = require('../services/message.service');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/heic', 'image/gif',
      'video/mp4',
      'audio/mpeg', 'audio/wav', 'audio/mp4',
      'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/vnd.rar', 'text/plain',
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('MIME type không được hỗ trợ!'), false);
    }
  },
});

const sendMessageController = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, type, content, metadata, isAnonymous = 'false', isSecret = 'false', quality = 'original', expiresAfter } = req.body;
    const file = req.file ? req.file.buffer : null;
    const fileName = req.file ? req.file.originalname : null;
    const mimeType = req.file ? req.file.mimetype : null;

    if (!receiverId || !type) {
      return res.status(400).json({ success: false, message: 'receiverId hoặc type là bắt buộc!' });
    }

    if (['image', 'file', 'video', 'voice', 'sticker'].includes(type) && !req.file) {
      return res.status(400).json({ success: false, message: `File là bắt buộc cho loại tin nhắn ${type}!` });
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
    res.status(201).json({
      success: true,
      message: 'Gửi tin nhắn thành công!',
      data: newMessage,
    });
  } catch (error) {
    console.error('Error in sendMessage:', error);
    const statusCode = error.message.includes('là bắt buộc') ? 400 : 
                       error.message.includes('không tồn tại') ? 404 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
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
    const senderId = req.user.id; // Lấy senderId từ thông tin người dùng đã xác thực
    console.log('Sender ID:', senderId);
    console.log('Forward message request:', { senderId, messageId, targetReceiverId });

    // Kiểm tra đầu vào
    if (!messageId || !targetReceiverId) {
      return res.status(400).json({ success: false, message: 'Thiếu messageId hoặc targetReceiverId' });
    }

    const result = await MessageService.forwardMessage(senderId, messageId, targetReceiverId);
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

// Controller cho 1-group
const forwardMessageToGroupController = async (req, res) => {
  try {
    const { messageId, targetGroupId } = req.body;
    const senderId = req.user.id;
    console.log('Sender ID:', senderId);
    console.log('Forward message to group request:', { senderId, messageId, targetGroupId });

    // Kiểm tra đầu vào
    if (!messageId || !targetGroupId) {
      return res.status(400).json({ success: false, message: 'Thiếu messageId hoặc targetGroupId' });
    }

    const result = await MessageService.forwardMessageToGroup(senderId, messageId, targetGroupId);
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
      return res.status(400).json({ success: false, message: 'messageId là bắt buộc!' });
    }

    console.log('Recall message request:', { userId, messageId });

    const result = await MessageService.recallMessage(userId, messageId);
   
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const pinMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.pinMessage(senderId, messageId);
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
  // getConversationSummaryController,
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