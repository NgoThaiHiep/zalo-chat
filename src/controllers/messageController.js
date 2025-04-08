const MessageService = require('../services/message.service');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/heic', 'image/gif',
      'video/mp4',
      'audio/mpeg', 'audio/wav',
      'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/vnd.rar', 'text/plain'
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('MIME type không được hỗ trợ!'), false);
    }
  },
});

const sendMessage = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { receiverId, type, content, metadata, isAnonymous = 'false', isSecret = 'false', quality = 'original' } = req.body;
    const file = req.file ? req.file.buffer : null;
    const fileName = req.file ? req.file.originalname : null;
    const mimeType = req.file ? req.file.mimetype : null;

    console.log('Request body:', req.body);
    console.log('File:', req.file);

    if (!receiverId || !type) {
      return res.status(400).json({ success: false, message: 'receiverId hoặc type là bắt buộc!' });
    }

    // Kiểm tra file cho các loại tin nhắn yêu cầu file
    if (['image', 'file', 'video', 'voice', 'sticker'].includes(type)) {
      if (!req.file) {
        return res.status(400).json({ success: false, message: `File là bắt buộc cho loại tin nhắn ${type}!` });
      }
      if (!file || !Buffer.isBuffer(file) || !mimeType) {
        return res.status(400).json({ success: false, message: 'File hoặc MIME type không hợp lệ!' });
      }
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
    };

    const newMessage = await MessageService.createMessage(senderId, receiverId, messageData);
    res.status(201).json({
      success: true,
      message: 'Gửi tin nhắn thành công!',
      data: newMessage,
    });
  } catch (error) {
    const statusCode = error.message.includes('là bắt buộc') ? 400 : error.message.includes('không tồn tại') ? 404 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
  }
};
const getMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.id;

    if (!userId) {
      return res.status(400).json({ message: 'userId là bắt buộc!' });
    }

    const messages = await MessageService.getMessagesBetweenUsers(currentUserId, userId);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};

const getConversationUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id;
    const result = await MessageService.getConversationUsers(currentUserId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách người nhắn', error: error.message });
  }
};

const forwardMessageController = async (req, res) => {
  try {
    const senderId = req.user.id;
    const { messageId, targetReceiverId } = req.body;

    const result = await MessageService.forwardMessage(senderId, messageId, targetReceiverId);
    res.status(200).json({ success: true, message: 'Chuyển tiếp thành công!', data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const recallMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.recallMessage(senderId, messageId);
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const pinMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.pinMessage(senderId, messageId);
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const setReminderController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;
    const { reminder } = req.body;

    const result = await MessageService.setReminder(senderId, messageId, reminder);
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const deleteMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;
    const { deleteType } = req.body;

    const result = await MessageService.deleteMessage(senderId, messageId, deleteType || 'everyone');
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const restoreMessageController = async (req, res) => {
  try {
    const { messageId } = req.params;
    const senderId = req.user.id;

    const result = await MessageService.restoreMessage(senderId, messageId);
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

module.exports = {
  sendMessage: [upload.single('file'), sendMessage],
  getMessages,
  getConversationUsers,
  forwardMessageController,
  recallMessageController,
  pinMessageController,
  setReminderController,
  deleteMessageController,
  restoreMessageController,
};