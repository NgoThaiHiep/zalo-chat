const ConversationService = require('../services/conversation.service');
const logger = require('../config/logger');
const { dynamoDB } = require('../config/aws.config');
const { isValidUUID } = require('../utils/helpers');
const { AppError } = require('../utils/errorHandler');
const setAutoDeleteSettingController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId, autoDeleteAfter } = req.body;
    if (!targetUserId || !autoDeleteAfter) {
      throw new AppError('targetUserId và autoDeleteAfter là bắt buộc', 400);
    }
    if (!isValidUUID(targetUserId)) {
      throw new AppError('targetUserId không hợp lệ', 400);
    }
    const result = await ConversationService.setAutoDeleteSetting(userId, targetUserId, autoDeleteAfter);
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:setAutoDelete', {
      success: true,
      data: { message: result.message, targetUserId, autoDeleteAfter },
    });
    logger.info(`[ConversationController] Emitted conversation:setAutoDelete to user:${userId}`);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    logger.error('[setAutoDeleteSettingController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi cài đặt tự động xóa', error.statusCode || 500);
  }
};

const muteConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { mutedUserId, duration } = req.body;

    if (!mutedUserId || !duration) {
      return res.status(400).json({ success: false, message: 'mutedUserId và duration là bắt buộc!' });
    }

    const validDurations = ['off', '1h', '3h', '8h', 'on'];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({ success: false, message: 'duration phải là: off, 1h, 3h, 8h, on' });
    }

    const result = await ConversationService.muteConversation(userId, mutedUserId, duration);

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:mute:success', {
      message: result.message,
      mutedUserId,
      muteUntil: result.muteUntil,
    });

    // Thông báo người kia nếu là bạn bè
    const isFriend = await dynamoDB.get({
      TableName: 'Friends',
      Key: { userId, friendId: mutedUserId },
    }).promise().then(res => !!res.Item);
    if (isFriend) {
      req.io.of('/conversation').to(`user:${mutedUserId}`).emit('conversation:mute:notify', {
        mutedBy: userId,
        duration,
      });
    }
    logger.info(`[ConversationController] Emitted conversation:mute:success to user:${userId}${isFriend ? ` and conversation:mute:notify to user:${mutedUserId}` : ''}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[muteConversationController] Error', { error: error.message });
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

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:hide:success', {
      message: result.message,
      hiddenUserId,
    });
    logger.info(`[ConversationController] Emitted conversation:hide:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[hideConversationController] Error', { error: error.message });
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

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:unhide:success', {
      message: result.message,
      hiddenUserId,
    });
    logger.info(`[ConversationController] Emitted conversation:unhide:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[unhideConversationController] Error', { error: error.message });
    res.status(403).json({ success: false, message: error.message || 'Lỗi khi bỏ ẩn hội thoại' });
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

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:pin:success', {
      message: result.message,
      pinnedUserId,
    });
    logger.info(`[ConversationController] Emitted conversation:pin:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[pinConversationController] Error', { error: error.message });
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

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    req.io.of('/conversation').to(`user:${userId}`).emit('conversation:unpin:success', {
      message: result.message,
      pinnedUserId,
    });
    logger.info(`[ConversationController] Emitted conversation:unpin:success to user:${userId}`);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[unpinConversationController] Error', { error: error.message });
    res.status(400).json({ success: false, message: error.message || 'Lỗi khi bỏ ghim hội thoại' });
  }
};

const createConversationController = async (req, res) => {
  const { userId, targetUserId } = req.body;

  try {
    const result = await ConversationService.createConversation(userId, targetUserId);

    // Phát sự kiện qua Socket.IO trong namespace /conversation
    if (result.conversationId) {
      req.io.of('/conversation').to(`user:${userId}`).emit('conversation:create:success', {
        message: 'Hội thoại được tạo thành công',
        conversationId: result.conversationId,
        targetUserId,
      });
      req.io.of('/conversation').to(`user:${targetUserId}`).emit('conversation:created', {
        conversationId: result.conversationId,
        createdBy: userId,
      });
      logger.info(`[ConversationController] Emitted conversation:create:success to user:${userId} and conversation:created to user:${targetUserId}`);
    }

    if (result.conversationId) {
      return res.status(201).json({
        success: true,
        message: 'Hội thoại được tạo thành công',
        data: { conversationId: result.conversationId },
      });
    } else {
      return res.status(200).json({
        success: true,
        message: 'Hội thoại đã tồn tại',
        data: { conversationId: null },
      });
    }
  } catch (error) {
    logger.error('[createConversationController] Error', { userId, targetUserId, error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getAutoDeleteSettingController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId } = req.query;

    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
    }

    const result = await ConversationService.getAutoDeleteSetting(userId, targetUserId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getAutoDeleteSettingController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getMutedConversationsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await ConversationService.getMutedConversations(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getMutedConversationsController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getHiddenConversationsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await ConversationService.getHiddenConversations(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getHiddenConversationsController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getPinnedConversationsController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await ConversationService.getPinnedConversations(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getPinnedConversationsController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getConversationController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({ success: false, message: 'conversationId là bắt buộc!' });
    }

    const result = await ConversationService.getConversation(userId, conversationId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getConversationController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message || 'Lỗi server' });
  }
};

const getConversationSummaryController = async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await ConversationService.getConversationSummary(userId);
    res.status(200).json(result);
  } catch (error) {
    logger.error('[getConversationSummaryController] Error', { error: error.message });
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
  createConversationController,
  getConversationController,
  getConversationSummaryController,
};