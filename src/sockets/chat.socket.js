const logger = require('../config/logger');
const authenticateSocket = require('../middlewares/socketAuthMiddleware');
const MessageService = require('../services/message.service');
const { AppError } = require('../utils/errorHandler');

const initializeChatSocket = (chatIo) => {
  chatIo.use(authenticateSocket);

  chatIo.on('connection', (socket) => {
    const userId = socket.user.id;
    logger.info('[ChatSocket] User connected', { userId, socketId: socket.id });

    socket.join(`user:${userId}`);
    logger.info('[ChatSocket] User joined room', { userId, room: `user:${userId}` });

    const joinConversationRooms = async () => {
      try {
        const conversations = await MessageService.getConversationsForUser(userId);
        logger.info('[ChatSocket] Conversations found for user', { userId, conversationCount: conversations.length });
        conversations.forEach((conversation) => {
          const otherUserId = conversation.targetUserId;
          const room = `conversation:${[userId, otherUserId].sort().join(':')}`;
          socket.join(room);
          logger.info('[ChatSocket] User joined conversation room', { userId, room });
        });
      } catch (error) {
        logger.error('[ChatSocket] Error joining conversation rooms', { userId, error: error.message });
      }
    };

    joinConversationRooms();

    const updateMessagesOnConnect = async () => {
      try {
        await MessageService.updateMessageStatusOnConnect(userId);
        logger.info('[ChatSocket] Updated message statuses on connect', { userId });
      } catch (error) {
        logger.error('[ChatSocket] Failed to update message statuses on connect', {
          userId,
          error: error.message,
        });
      }
    };

    updateMessagesOnConnect();

    socket.on('joinRoom', (data) => {
      const { room } = data;
      socket.join(room);
      logger.info('[ChatSocket] User joined room via joinRoom event', { userId, room });
    });

    socket.on('sendMessage', async (data, callback) => {
      try {
        const {
          receiverId,
          type,
          content,
          metadata,
          isAnonymous = false,
          isSecret = false,
          quality = 'original',
          expiresAfter,
          file,
        } = data;

        if (!receiverId || !type) {
          throw new AppError('receiverId and type are required', 400);
        }

        if (['image', 'file', 'video', 'voice', 'sticker', 'gif'].includes(type) && !file) {
          throw new AppError(`File is required for message type ${type}`, 400);
        }

        const messageData = {
          type,
          content: content || null,
          file: file ? Buffer.from(file.data) : null,
          fileName: file ? file.name : null,
          mimeType: file ? file.mimeType : null,
          metadata,
          isAnonymous: !!isAnonymous,
          isSecret: !!isSecret,
          quality,
          expiresAfter,
        };

        const newMessage = await MessageService.createMessage(userId, receiverId, messageData);

        if (receiverId) {
          chatIo.to(`user:${receiverId}`).emit('receiveMessage', newMessage);
          // Phát tín hiệu để cập nhật danh sách chat-item cho cả sender và receiver
          const conversationRoom = `conversation:${[userId, receiverId].sort().join(':')}`;
          chatIo.to(conversationRoom).emit('updateChatList', {
            conversationId: conversationRoom,
            message: newMessage,
          });
        }

        logger.info('[ChatSocket] Message sent', { messageId: newMessage.messageId, senderId: userId, receiverId });
        callback({ success: true, data: newMessage });
      } catch (error) {
        logger.error('[ChatSocket] Error sending message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('getMessagesBetween', async (data, callback) => {
      try {
        const { userId: targetUserId } = data;
        if (!targetUserId) {
          throw new AppError('userId is required', 400);
        }

        const result = await MessageService.getMessagesBetweenUsers(userId, targetUserId);

        logger.info('[ChatSocket] Fetched messages between users', { userId, targetUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error fetching messages', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('forwardMessage', async (data, callback) => {
      try {
        const { messageId, targetReceiverId } = data;
        if (!messageId || !targetReceiverId) {
          throw new AppError('messageId and targetReceiverId are required', 400);
        }

        const result = await MessageService.forwardMessage(userId, messageId, targetReceiverId);

        chatIo.to(`user:${userId}`).emit('receiveMessage', result);
        chatIo.to(`user:${targetReceiverId}`).emit('receiveMessage', result);

        // Cập nhật danh sách chat-item cho cả sender và receiver
        const conversationRoomSender = `conversation:${[userId, targetReceiverId].sort().join(':')}`;
        chatIo.to(conversationRoomSender).emit('updateChatList', {
          conversationId: conversationRoomSender,
          message: result,
        });

        logger.info('[ChatSocket] Message forwarded', { messageId, userId, targetReceiverId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error forwarding message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('forwardMessageToGroup', async (data, callback) => {
      try {
        const { messageId, targetGroupId } = data;
        if (!messageId || !targetGroupId) {
          throw new AppError('messageId and targetGroupId are required', 400);
        }

        const result = await MessageService.forwardMessageToGroup(userId, messageId, targetGroupId);

        chatIo.to(`group:${targetGroupId}`).emit('newGroupMessage', {
          groupId: targetGroupId,
          message: result,
        });

        // Cập nhật danh sách chat-item cho nhóm
        chatIo.to(`group:${targetGroupId}`).emit('updateChatList', {
          conversationId: targetGroupId,
          message: result,
        });

        logger.info('[ChatSocket] Message forwarded to group', { messageId, userId, targetGroupId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error forwarding message to group', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('recallMessage', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          throw new AppError('messageId is required', 400);
        }

        const result = await MessageService.recallMessage(userId, messageId);

        const message = await MessageService.getMessageById(messageId, userId);
        if (message) {
          chatIo.to(`user:${userId}`).emit('messageRecalled', { messageId });
          if (message.groupId) {
            chatIo.to(`group:${message.groupId}`).emit('messageRecalled', { messageId });
          } else if (message.receiverId && message.receiverId !== userId) {
            chatIo.to(`user:${message.receiverId}`).emit('messageRecalled', { messageId });
          }
        } else {
          logger.warn('[ChatSocket] Message not found for recall', { messageId, userId });
        }

        logger.info('[ChatSocket] Message recalled', { messageId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error recalling message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('getPinnedMessages', async (data, callback) => {
      try {
        const { otherUserId } = data;
        if (!otherUserId) {
          throw new AppError('otherUserId is required', 400);
        }

        const result = await MessageService.getPinnedMessages(userId, otherUserId);

        logger.info('[ChatSocket] Fetched pinned messages', { userId, otherUserId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error fetching pinned messages', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('deleteMessage', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          throw new AppError('messageId is required', 400);
        }

        const result = await MessageService.deleteMessage(userId, messageId);

        chatIo.to(`user:${userId}`).emit('messageDeleted', { messageId });

        logger.info('[ChatSocket] Message deleted', { messageId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error deleting message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('restoreMessage', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          throw new AppError('messageId is required', 400);
        }

        const result = await MessageService.restoreMessage(userId, messageId);

        chatIo.to(`user:${userId}`).emit('messageRestored', { messageId });

        logger.info('[ChatSocket] Message restored', { messageId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error restoring message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('retryMessage', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          throw new AppError('messageId is required', 400);
        }

        const result = await MessageService.retryMessage(userId, messageId);

        chatIo.to(`user:${userId}`).emit('receiveMessage', result);
        if (result.receiverId !== userId) {
          chatIo.to(`user:${result.receiverId}`).emit('receiveMessage', result);
        }

        // Cập nhật danh sách chat-item
        const conversationRoom = `conversation:${[userId, result.receiverId].sort().join(':')}`;
        chatIo.to(conversationRoom).emit('updateChatList', {
          conversationId: conversationRoom,
          message: result,
        });

        logger.info('[ChatSocket] Message retried', { messageId, userId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error retrying message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('markMessageAsSeen', async (data, callback) => {
      try {
        const { messageId } = data;
        if (!messageId) {
          throw new AppError('messageId is required', 400);
        }

        const result = await MessageService.markMessageAsSeen(userId, messageId);

        const message = await MessageService.getMessageById(messageId, userId);
        if (message) {
          chatIo.to(`user:${userId}`).emit('messageStatus', {
            messageId,
            status: message.status,
          });
          if (message.senderId !== userId) {
            chatIo.to(`user:${message.senderId}`).emit('messageStatus', {
              messageId,
              status: message.status,
            });
          }
        }

        logger.info('[ChatSocket] Message marked as seen', { messageId, userId });
        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (error) {
        logger.error('[ChatSocket] Error marking message as seen', { error: error.message });
        if (typeof callback === 'function') {
          callback({ success: false, message: error.message });
        } else {
          logger.warn('[ChatSocket] No callback provided for markMessageAsSeen');
        }
      }
    });

    socket.on('checkBlockStatus', async (data, callback) => {
      try {
        const { receiverId } = data;
        if (!receiverId) {
          throw new AppError('receiverId is required', 400);
        }

        const result = await MessageService.checkBlockStatus(userId, receiverId);

        logger.info('[ChatSocket] Checked block status', { userId, receiverId });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error checking block status', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

    socket.on('pinMessage', async (data, callback) => {
      try {
        const { messageId, room } = data;
        if (!messageId || !room) {
          throw new AppError('messageId and room are required', 400);
        }

        const result = await MessageService.pinMessage(userId, messageId);
        const message = await MessageService.getMessageById(messageId, userId);
        const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;

        // Lấy danh sách tin nhắn ghim mới
        const pinnedMessages = await MessageService.getPinnedMessages(userId, otherUserId);

        // Phát sự kiện đến cả hai người dùng trong cuộc trò chuyện
        chatIo.to(room).emit('messagePinned', {
          messageId,
          messages: pinnedMessages.messages, // Gửi danh sách tin nhắn ghim mới
        });

        logger.info('[ChatSocket] Message pinned', { messageId, userId, room });
        callback({ success: true, data: result });
      } catch (error) {
        logger.error('[ChatSocket] Error pinning message', { error: error.message });
        callback({ success: false, message: error.message });
      }
    });

  socket.on('unpinMessage', async (data, callback) => {
    try {
      const { messageId, room } = data;
      if (!messageId || !room) {
        throw new AppError('messageId and room are required', 400);
      }

      const result = await MessageService.unpinMessage(userId, messageId);
      const message = await MessageService.getMessageById(messageId, userId);
      const otherUserId = message.senderId === userId ? message.receiverId : message.senderId;

      // Lấy danh sách tin nhắn ghim mới
      const pinnedMessages = await MessageService.getPinnedMessages(userId, otherUserId);

      // Phát sự kiện đến cả hai người dùng trong cuộc trò chuyện
      chatIo.to(room).emit('messageUnpinned', {
        messageId,
        messages: pinnedMessages.messages, // Gửi danh sách tin nhắn ghim mới
      });

      logger.info('[ChatSocket] Message unpinned', { messageId, userId, room });
      callback({ success: true, data: result });
    } catch (error) {
      logger.error('[ChatSocket] Error unpinning message', { error: error.message });
      callback({ success: false, message: error.message });
    }
  });

    socket.on('disconnect', () => {
      logger.info('[ChatSocket] User disconnected', { userId, socketId: socket.id });
    });
  });
};

module.exports = initializeChatSocket;