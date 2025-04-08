const GroupService = require('../services/group.service');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

const createGroupController = async (req, res) => {
  try {
    const { name, members } = req.body;
    const createdBy = req.user.id;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Tên nhóm không được để trống!' });
    }
    const newGroup = await GroupService.createGroup(name, createdBy, members);
    res.status(201).json({ success: true, group: newGroup });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};

const joinGroupController = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;
    if (!groupId) {
      return res.status(400).json({ success: false, message: 'groupId không hợp lệ!' });
    }
    const result = await GroupService.joinGroup(groupId, userId);
    res.json({ success: true, message: 'Tham gia nhóm thành công!', group: result });
  } catch (error) {
    const statusCode = error.message.includes('Nhóm không tồn tại') ? 404 : 500;
    res.status(statusCode).json({ message: 'Lỗi server', error: error.message });
  }
};

const leaveGroupController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;

        if (!groupId) {
            return res.status(400).json({ success: false, message: "groupId không hợp lệ!" });
        }

        const result = await GroupService.leaveGroup(groupId, userId);
        return res.status(200).json({ 
            success: true, 
            message: result.message, 
            groupId: result.groupId, 
            newAdmin: result.newAdmin 
        });
    } catch (error) {
        console.error(`Error leaving group (groupId: ${req.params.groupId}, userId: ${req.user.id}):`, error.message);
        const statusCode = error.message.includes("Nhóm không tồn tại") ? 404 :
                          error.message.includes("Bạn không phải là thành viên") ? 403 :
                          error.message.includes("Nhóm đã bị xóa") ? 410 : // Nếu cần xử lý thêm trường hợp nhóm bị xóa
                          500;
        return res.status(statusCode).json({ success: false, message: error.message });
    }
};

const kickMemberController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const adminUserId = req.user.id;
        const { targetUserId } = req.body;

        console.log("Controller - groupId:", groupId);
        console.log("Controller - adminUserId:", adminUserId);
        console.log("Controller - targetUserId:", targetUserId);

        if (!groupId) {
            return res.status(400).json({ success: false, message: "groupId không hợp lệ!" });
        }
        if (!targetUserId) {
            return res.status(400).json({ success: false, message: "targetUserId không hợp lệ!" });
        }

        const result = await GroupService.kickMember(groupId, adminUserId, targetUserId);
        return res.status(200).json({ 
            success: true, 
            message: result.message, 
            groupId: result.groupId, 
            newAdmin: result.newAdmin 
        });
    } catch (error) {
        console.error(`Error kicking member (groupId: ${req.params.groupId}, adminUserId: ${req.user.id}):`, error.message);
        const statusCode = error.message.includes("Nhóm không tồn tại") ? 404 :
                          error.message.includes("Bạn không phải là thành viên") ? 403 :
                          error.message.includes("Bạn không có quyền") ? 403 :
                          error.message.includes("Thành viên cần踢") ? 404 :
                          error.message.includes("Bạn không thể tự踢") ? 400 :
                          error.message.includes("Không thể踢 khi nhóm chỉ có một thành viên") ? 400 : 500;
        return res.status(statusCode).json({ success: false, message: error.message });
    }
};

const deleteGroupController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const adminUserId = req.user.id;

        console.log("Controller - groupId:", groupId);
        console.log("Controller - adminUserId:", adminUserId);

        if (!groupId) {
            return res.status(400).json({ success: false, message: "groupId không hợp lệ!" });
        }

        const result = await GroupService.deleteGroup(groupId, adminUserId);
        return res.status(200).json({ 
            success: true, 
            message: result.message, 
            groupId: result.groupId 
        });
    } catch (error) {
        console.error(`Error deleting group (groupId: ${req.params.groupId}, adminUserId: ${req.user.id}):`, error.message);
        const statusCode = error.message.includes("Nhóm không tồn tại") ? 404 :
                          error.message.includes("Bạn không phải là thành viên") ? 403 :
                          error.message.includes("Bạn không có quyền") ? 403 : 500;
        return res.status(statusCode).json({ success: false, message: error.message });
    }
};
/**
 * 📌 Lấy danh sách nhóm của user
 */
const getUserGroupsController = async (req, res) => {
    try {
        const userId = req.user.id;
        const groups = await GroupService.getUserGroups(userId);
        res.json({ success: true, groups });
    } catch (error) {
        res.status(500).json({ message: "Lỗi server", error: error.message });
    }
};

/**
 * Controller gửi tin nhắn trong nhóm
 */

const sendGroupMessageController = async (req, res) => {
    try {
      const { groupId } = req.params;
      const senderId = req.user.id;
      const { type, content, isAnonymous, isSecret, quality, replyToMessageId, metadata } = req.body;
      const file = req.file;
  
      const messageData = {
        type,
        content,
        file: file ? file.buffer : null,
        fileName: file ? file.originalname : null,
        mimeType: file ? file.mimetype : null,
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
        isAnonymous: isAnonymous === true || isAnonymous === 'true',
        isSecret: isSecret === true || isSecret === 'true',
        quality,
        replyToMessageId,
      };
  
      const result = await GroupService.sendGroupMessage(groupId, senderId, messageData);
      res.status(200).json({ success: true, message: 'Gửi tin nhắn thành công!', data: result });
    } catch (error) {
      const statusCode = error.message.includes('không hợp lệ') ? 400 : error.message.includes('Nhóm không tồn tại') ? 404 : 500;
      res.status(statusCode).json({ success: false, message: error.message });
    }
  };
const forwardGroupMessageController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const senderId = req.user.id;
        const { messageId, targetGroupId } = req.body;

        const result = await GroupService.forwardGroupMessage(groupId, senderId, { messageId, targetGroupId });
        res.status(200).json({ success: true, message: "Chuyển tiếp thành công!", data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const recallGroupMessageController = async (req, res) => {
    try {
        const { groupId, messageId } = req.params;
        const senderId = req.user.id;

        const result = await GroupService.recallGroupMessage(groupId, senderId, messageId);
        res.status(200).json(result);
    } catch (error) {
        res.status(403).json({ success: false, message: error.message });
    }
};

const pinGroupMessageController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const senderId = req.user.id;
        const { messageId } = req.body;

        const result = await GroupService.pinGroupMessage(groupId, senderId, messageId);
        res.status(200).json(result);
    } catch (error) {
        res.status(403).json({ success: false, message: error.message });
    }
};

const setReminderController = async (req, res) => {
    try {
        const { groupId, messageId } = req.params;
        const senderId = req.user.id;
        const { reminder } = req.body;

        const result = await GroupService.setReminder(groupId, senderId, messageId, reminder);
        res.status(200).json(result);
    } catch (error) {
        res.status(403).json({ success: false, message: error.message });
    }
};

const deleteGroupMessageController = async (req, res) => {
    try {
        const { groupId, messageId } = req.params;
        const senderId = req.user.id;
        const { deleteType } = req.body; // 'everyone' hoặc 'self', mặc định 'everyone'

        const result = await GroupService.deleteGroupMessage(groupId, senderId, messageId, deleteType);
        res.status(200).json(result);
    } catch (error) {
        res.status(403).json({ success: false, message: error.message });
    }
};

const restoreGroupMessageController = async (req, res) => {
    try {
        const { groupId, messageId } = req.params;
        const senderId = req.user.id;

        const result = await GroupService.restoreGroupMessage(groupId, senderId, messageId);
        res.status(200).json(result);
    } catch (error) {
        res.status(403).json({ success: false, message: error.message });
    }
};

const getGroupMessagesController = async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.id;
        const { limit, lastKey } = req.query;

        if (!groupId) {
            return res.status(400).json({ success: false, message: "groupId không hợp lệ!" });
        }

        const result = await GroupService.getGroupMessages(groupId, userId, limit, lastKey ? JSON.parse(lastKey) : null);
        return res.status(200).json({ 
            success: true, 
            message: "Lấy danh sách tin nhắn thành công!",
            data: result.messages,
            lastEvaluatedKey: result.lastEvaluatedKey
        });
    } catch (error) {
        console.error(`Error getting group messages (groupId: ${req.params.groupId}, userId: ${req.user.id}):`, error.message);
        const statusCode = error.message.includes("Nhóm không tồn tại") ? 404 :
                          error.message.includes("Bạn không phải thành viên") ? 403 :
                          error.message.includes("không hợp lệ") ? 400 : 500;
        return res.status(statusCode).json({ success: false, message: error.message });
    }
};

module.exports = {
    createGroupController,
    joinGroupController,
    leaveGroupController,
    kickMemberController,
    deleteGroupController,
    getUserGroupsController,
    sendGroupMessageController: [upload.single('file'), sendGroupMessageController],
    getGroupMessagesController,
    forwardGroupMessageController,
    recallGroupMessageController,
    pinGroupMessageController,
    setReminderController,
    deleteGroupMessageController,
    restoreGroupMessageController,
  };
