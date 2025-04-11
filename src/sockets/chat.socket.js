const { io } = require('../socket');
const {
  createMessage,
  recallMessage,
  pinMessage,
  deleteMessage,
  restoreMessage,
  forwardMessage,
  updateMessageStatusOnConnect,
  hideConversation,
  unhideConversation,
  setConversationNickname,
} = require('../services/message.service');

// Debounce để giảm tải sự kiện typing
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

const initializeChatSocket = (socket) => {
  console.log('🔌 Client connected to chat socket:', socket.id);

  // Xác thực người dùng khi join
  socket.on('join', async ({ userId, token }) => {
    try {
      // Giả sử có hàm verifyToken trong auth.service.js để kiểm tra token
      const { id } = await verifyToken(token); // Cần triển khai trong auth.service.js
      if (id !== userId) throw new Error('Token không hợp lệ!');
      
      socket.userId = userId;
      socket.join(userId);
      console.log(`👤 User ${userId} joined room`);
      await updateMessageStatusOnConnect(userId);
    } catch (error) {
      socket.emit('error', { message: 'Xác thực thất bại: ' + error.message });
      socket.disconnect();
    }
  });

  // Debounce typing event để giảm tải
  const emitTyping = debounce(({ receiverId }) => {
    if (socket.userId && receiverId) {
      io().to(receiverId).emit('userTyping', { senderId: socket.userId });
    }
  }, 500);

  socket.on('typing', emitTyping);

  socket.on('stopTyping', ({ receiverId }) => {
    if (socket.userId && receiverId) {
      io().to(receiverId).emit('userStoppedTyping', { senderId: socket.userId });
    }
  });

  socket.on('sendMessage', async (messageData) => {
    try {
      const {
        receiverId,
        type,
        content,
        file,
        fileName,
        mimeType,
        metadata,
        isAnonymous,
        isSecret,
        quality,
        expiresAfter,
      } = messageData;

      if (!socket.userId || !receiverId || !type) {
        throw new Error('Thiếu thông tin cần thiết!');
      }

      const messagePayload = {
        type,
        content: content || null,
        file: file ? Buffer.from(file, 'base64') : null, // Giả sử file là base64 từ client
        fileName,
        mimeType,
        metadata: metadata ? JSON.parse(metadata) : null,
        isAnonymous: isAnonymous || false,
        isSecret: isSecret || false,
        quality: quality || 'original',
        expiresAfter,
      };

      const savedMessage = await createMessage(socket.userId, receiverId, messagePayload);
      socket.emit('messageSent', { success: true, data: savedMessage });
    } catch (error) {
      console.error('Lỗi khi gửi tin nhắn:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('recallMessage', async ({ messageId }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await recallMessage(socket.userId, messageId);
      socket.emit('recallMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('pinMessage', async ({ messageId }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await pinMessage(socket.userId, messageId);
      socket.emit('pinMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('deleteMessage', async ({ messageId, deleteType }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await deleteMessage(socket.userId, messageId, deleteType || 'everyone');
      socket.emit('deleteMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('restoreMessage', async ({ messageId }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await restoreMessage(socket.userId, messageId);
      socket.emit('restoreMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('forwardMessage', async ({ messageId, targetReceiverId }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await forwardMessage(socket.userId, messageId, targetReceiverId);
      socket.emit('forwardMessageSuccess', { success: true, message: 'Chuyển tiếp thành công!', data: result });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('hideConversation', async ({ hiddenUserId, password }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await hideConversation(socket.userId, hiddenUserId, password);
      socket.emit('hideConversationSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('unhideConversation', async ({ hiddenUserId, password }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await unhideConversation(socket.userId, hiddenUserId, password);
      socket.emit('unhideConversationSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('setConversationNickname', async ({ targetUserId, nickname }) => {
    try {
      if (!socket.userId) throw new Error('Chưa xác thực!');
      const result = await setConversationNickname(socket.userId, targetUserId, nickname);
      socket.emit('setConversationNicknameSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected from chat socket:', socket.id);
  });
};

module.exports = { initializeChatSocket };