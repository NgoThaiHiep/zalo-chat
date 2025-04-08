const { io } = require('../socket');
const {
  createMessage,
  recallMessage,
  pinMessage,
  deleteMessage,
  restoreMessage,
  forwardMessage,
} = require('../services/message.service');

const initializeChatSocket = (socket) => {
  console.log('🔌 Client connected to chat socket:', socket.id);

  socket.on('join', (userId) => {
    socket.join(userId);
    console.log(`👤 User ${userId} joined room`);
  });

  socket.on('sendMessage', async (messageData) => {
    try {
      const { senderId, receiverId, type, content, file, fileName, mimeType, metadata, isAnonymous, isSecret, quality } = messageData;
      const savedMessage = await createMessage(senderId, receiverId, {
        type,
        content,
        file: file ? Buffer.from(file) : null,
        fileName,
        mimeType,
        metadata,
        isAnonymous: isAnonymous || false,
        isSecret: isSecret || false,
        quality: quality || 'original',
      });
    } catch (error) {
      console.error('Lỗi khi gửi tin nhắn:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('recallMessage', async ({ senderId, messageId }) => {
    try {
      const result = await recallMessage(senderId, messageId);
      socket.emit('recallMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('pinMessage', async ({ senderId, messageId }) => {
    try {
      const result = await pinMessage(senderId, messageId);
      socket.emit('pinMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('deleteMessage', async ({ senderId, messageId, deleteType }) => {
    try {
      const result = await deleteMessage(senderId, messageId, deleteType || 'everyone');
      socket.emit('deleteMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('restoreMessage', async ({ senderId, messageId }) => {
    try {
      const result = await restoreMessage(senderId, messageId);
      socket.emit('restoreMessageSuccess', result);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('forwardMessage', async ({ senderId, messageId, targetReceiverId }) => {
    try {
      const result = await forwardMessage(senderId, messageId, targetReceiverId);
      socket.emit('forwardMessageSuccess', { success: true, message: 'Chuyển tiếp thành công!', data: result });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected from chat socket:', socket.id);
  });
};

module.exports = { initializeChatSocket };