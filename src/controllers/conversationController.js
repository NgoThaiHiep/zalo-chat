
const ConversationService = require('../services/conversation.service');

const setAutoDeleteSettingController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId, autoDeleteAfter } = req.body;

    if (!targetUserId || !autoDeleteAfter) {
      return res.status(400).json({ message: 'Thiếu targetUserId hoặc autoDeleteAfter!' });
    }

    const result = await ConversationService.setAutoDeleteSetting(userId, targetUserId, autoDeleteAfter);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: error.message || 'Lỗi khi cài đặt tự động xóa!' });
  }
};

const getAutoDeleteSettingController = async (req, res) => {
    try {
      const userId = req.user.id;
      const { targetUserId } = req.params;
  
      if (!targetUserId) {
        return res.status(400).json({ message: 'Thiếu targetUserId!' });
      }
  
      const setting = await ConversationService.getAutoDeleteSetting(userId, targetUserId);
      res.status(200).json({ autoDeleteAfter: setting });
    } catch (error) {
      res.status(500).json({ message: error.message || 'Lỗi khi lấy cài đặt tự động xóa!' });
    }
};

const muteConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { mutedUserId, duration } = req.body;

    // Kiểm tra input
    if (!mutedUserId || !duration) {
      return res.status(400).json({ success: false, message: 'mutedUserId và duration là bắt buộc!' });
    }

    const validDurations = ['off', '1h', '3h', '8h', 'on'];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({ success: false, message: 'duration phải là: off, 1h, 3h, 8h, on' });
    }

    const result = await ConversationService.muteConversation(userId, mutedUserId, duration);
    res.status(200).json(result);
  } catch (error) {
    console.error('Lỗi trong muteConversationController:', error);
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getMutedConversationsController = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await ConversationService.getMutedConversations(userId);
    res.status(200).json(result);
  } catch (error) {
    console.error('Lỗi trong getMutedConversationsController:', error);
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const hideConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { hiddenUserId, password } = req.body;

    if (!hiddenUserId || !password) {
      return res.status(400).json({ success: false, message: 'hiddenUserId và password là bắt buộc!' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mật khẩu phải có ít nhất 6 ký tự!' });
    }

    const result = await ConversationService.hideConversation(userId, hiddenUserId, password);
    res.status(200).json(result);
  } catch (error) {
    console.error('Lỗi trong hideConversationController:', error);
    res.status(400).json({ success: false, message: error.message || 'Lỗi khi ẩn hội thoại' });
  }
};

const unhideConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { hiddenUserId, password } = req.body;

    if (!hiddenUserId || !password) {
      return res.status(400).json({ success: false, message: 'hiddenUserId và password là bắt buộc!' });
    }

    const result = await ConversationService.unhideConversation(userId, hiddenUserId, password);
    res.status(200).json(result);
  } catch (error) {
    console.error('Lỗi trong unhideConversationController:', error);
    res.status(403).json({ success: false, message: error.message || 'Lỗi khi bỏ ẩn hội thoại' });
  }
};

const getHiddenConversationsController = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await ConversationService.getHiddenConversations(userId);
    res.status(200).json(result);
  } catch (error) {
    console.error('Lỗi trong getHiddenConversationsController:', error);
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const pinConversationController = async (req, res) => {
    try {
      const userId = req.user.id;
      const { pinnedUserId } = req.body;
  
      if (!pinnedUserId) {
        return res.status(400).json({ success: false, message: 'pinnedUserId là bắt buộc!' });
      }
  
      const result = await ConversationService.pinConversation(userId, pinnedUserId);
      res.status(200).json(result);
    } catch (error) {
      console.error('Lỗi trong pinConversationController:', error);
      res.status(400).json({ success: false, message: error.message || 'Lỗi khi ghim hội thoại' });
    }
};
  
const unpinConversationController = async (req, res) => {
    try {
      const userId = req.user.id;
      const { pinnedUserId } = req.body;
  
      if (!pinnedUserId) {
        return res.status(400).json({ success: false, message: 'pinnedUserId là bắt buộc!' });
      }
  
      const result = await ConversationService.unpinConversation(userId, pinnedUserId);
      res.status(200).json(result);
    } catch (error) {
      console.error('Lỗi trong unpinConversationController:', error);
      res.status(400).json({ success: false, message: error.message || 'Lỗi khi bỏ ghim hội thoại' });
    }
};

const getPinnedConversationsController = async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await ConversationService.getPinnedConversations(userId);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error('Lỗi trong getPinnedConversationsController:', error);
      res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
    }
  };

 
module.exports = {
    setAutoDeleteSettingController,
    getAutoDeleteSettingController,
    pinConversationController,
    unpinConversationController,

    muteConversationController,
    getMutedConversationsController,
    hideConversationController,
    unhideConversationController,
    getHiddenConversationsController,

    getPinnedConversationsController,
}