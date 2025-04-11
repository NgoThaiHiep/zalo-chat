const MessageService = require('../services/message.service');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/heic', 'image/gif',
      'video/mp4',
      'audio/mpeg', 'audio/wav','audio/mp4',
      'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/vnd.rar', 'text/plain'
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('MIME type không được hỗ trợ!'), false);
    }
  },
});
const setAutoDeleteSettingController = async (req, res) => {
  try {
    const  userId  = req.user.id; // Giả sử userId lấy từ middleware xác thực
    const { targetUserId, autoDeleteAfter } = req.body;

    if (!targetUserId || !autoDeleteAfter) {
      return res.status(400).json({ message: 'Thiếu targetUserId hoặc autoDeleteAfter!' });
    }

    const result = await MessageService.setAutoDeleteSetting(userId, targetUserId, autoDeleteAfter);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Lỗi khi cài đặt tự động xóa!' });
  }
};

const getAutoDeleteSettingController = async (req, res) => {
  try {
    const  userId  = req.user.id;
    const { targetUserId } = req.params;

    if (!targetUserId) {
      return res.status(400).json({ message: 'Thiếu targetUserId!' });
    }

    const setting = await MessageService.getAutoDeleteSetting(userId, targetUserId);
    res.status(200).json({ autoDeleteAfter: setting });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Lỗi khi lấy cài đặt tự động xóa!' });
  }
};

const sendMessage = async (req, res) => {
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
    if (!messageId || !targetReceiverId) {
      return res.status(400).json({ success: false, message: 'messageId hoặc targetReceiverId là bắt buộc!' });
    }
    const result = await MessageService.forwardMessage(senderId, messageId, targetReceiverId);
    res.status(200).json({ success: true, message: 'Chuyển tiếp thành công!', data: result });
  } catch (error) {
    const statusCode = error.message.includes('không tồn tại') ? 404 : error.message.includes('quyền') ? 403 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
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
    const userId = req.user.id;
    const { messageId } = req.params;

    const result = await MessageService.markMessageAsSeen(userId, messageId);
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    const statusCode = error.message.includes('không tồn tại') ? 404 : error.message.includes('quyền') ? 403 : 500;
    res.status(statusCode).json({ success: false, message: error.message });
  }
};

const muteConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { mutedUserId, duration } = req.body;
    if (!mutedUserId || !duration) {
      return res.status(400).json({ success: false, message: 'mutedUserId và duration là bắt buộc!' });
    }
    const result = await MessageService.muteConversation(userId, mutedUserId, duration);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const hideConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { hiddenUserId, password } = req.body;
    if (!hiddenUserId || !password) {
      return res.status(400).json({ success: false, message: 'hiddenUserId và password là bắt buộc!' });
    }
    const result = await MessageService.hideConversation(userId, hiddenUserId, password);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const unhideConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { hiddenUserId, password } = req.body;
    if (!hiddenUserId || !password) {
      return res.status(400).json({ success: false, message: 'hiddenUserId và password là bắt buộc!' });
    }
    const result = await MessageService.unhideConversation(userId, hiddenUserId, password);
    res.status(200).json(result);
  } catch (error) {
    res.status(403).json({ success: false, message: error.message });
  }
};

const setConversationNicknameController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId, nickname } = req.body;
    if (!targetUserId || !nickname) {
      return res.status(400).json({ success: false, message: 'targetUserId và nickname là bắt buộc!' });
    }
    const result = await MessageService.setConversationNickname(userId, targetUserId, nickname);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
const checkBlockStatusController = async (req, res) => {
  try {
    const senderId = req.user.id; // Lấy senderId từ token
    const { receiverId } = req.body; // Lấy receiverId từ query params (hoặc req.body nếu bạn muốn)

    // Kiểm tra đầu vào
    if (!receiverId) {
      return res.status(400).json({
        success: false,
        message: 'receiverId là bắt buộc!',
      });
    }

    // Gọi AuthService.checkBlockStatus để kiểm tra trạng thái chặn
    await MessageService.checkBlockStatus(senderId, receiverId);

    // Nếu không có lỗi nào được ném ra, tức là không bị chặn
    res.status(200).json({
      success: true,
      message: 'Không có trạng thái chặn giữa hai người dùng.',
      data: {
        senderId,
        receiverId,
        isSenderBlocked: false, // Receiver không chặn sender
        isReceiverBlocked: false, // Sender không chặn receiver
      },
    });
  } catch (error) {
    // Xử lý lỗi từ checkBlockStatus
    const statusCode = error.message.includes('không thể gửi tin nhắn') ? 403 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message,
    });
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
  retryMessageController,
  markMessageAsSeenController,
  muteConversationController,
  hideConversationController,
  unhideConversationController,
  setConversationNicknameController,
  checkBlockStatusController,
  setAutoDeleteSettingController,
  getAutoDeleteSettingController,
};