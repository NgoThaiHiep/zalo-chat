const http = require('http');
const app = require('./app');
const { initializeDatabase } = require('./config/database');
const { initializeSocket } = require('./socket');
const { initializeChatSocket,setupReminderCheck } = require('./sockets/chat.socket');
const { initializeFriendSocket } = require('./sockets/friend.socket');
const { initializeConversationSocket } = require('./sockets/conversation.socket');
const logger = require('./config/logger');

const server = http.createServer(app);
const io = initializeSocket(server);

io.on('connection', (socket) => {
  logger.info('[SERVER] New socket connection', { socketId: socket.id });
  initializeChatSocket(socket);
  initializeFriendSocket(socket);
  initializeConversationSocket(socket);
});

// Thiết lập kiểm tra nhắc nhở (nếu cần)
setupReminderCheck();

// Graceful shutdown
const shutdown = async () => {
  logger.info('[SERVER] Initiating graceful shutdown');
  try {
    await new Promise((resolve) => server.close(resolve));
    io.close();
    logger.info('[SERVER] Server and Socket.IO closed');
    process.exit(0);
  } catch (error) {
    logger.error('[SERVER] Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

// Xử lý tín hiệu dừng server
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const startServer = async () => {
  try {
    await initializeDatabase();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(`[SERVER] Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('[SERVER] Failed to start server', { error: error.message });
    process.exit(1);
  }
};

startServer();

module.exports = { server, io, startServer };