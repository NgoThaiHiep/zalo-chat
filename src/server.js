const http = require('http');
const app = require('./app');
const { initializeDatabase } = require('./config/database');
const logger = require('./config/logger');
const { initializeSocket } = require('./socket');
const initializeChatSocket = require('./sockets/chat.socket');
const { initializeFriendSocket } = require('./sockets/friend.socket');
const { initializeConversationSocket } = require('./sockets/conversation.socket');
const initializeSearchSocket = require('./sockets/search.socket');

const server = http.createServer(app);
const io = initializeSocket(server);

// Initialize socket namespaces
const chatIo = io.of('/chat');
const friendIo = io.of('/friend');
const conversationIo = io.of('/conversation');
const searchIo = io.of('/search');

// Ensure socket initialization completes before attaching handlers
Promise.resolve()
  .then(() => {
    initializeChatSocket(chatIo);
    initializeFriendSocket(friendIo);
    initializeConversationSocket(conversationIo);
    initializeSearchSocket(searchIo);
    logger.info('[SERVER] All socket namespaces initialized');
  })
  .catch((error) => {
    logger.error('[SERVER] Failed to initialize socket namespaces', { error: error.message });
  });

const shutdown = async () => {
  logger.info('[SERVER] Initiating graceful shutdown');
  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    io.close();
    logger.info('[SERVER] Server and Socket.IO closed');
    process.exit(0);
  } catch (error) {
    logger.error('[SERVER] Shutdown error', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const startServer = async () => {
  try {
    await initializeDatabase();
    const PORT = process.env.PORT || 3000;
    await new Promise((resolve, reject) => {
      server.listen(PORT, (err) => {
        if (err) return reject(err);
        logger.info(`[SERVER] Server running on port ${PORT}`);
        resolve();
      });
    });
  } catch (error) {
    logger.error('[SERVER] Failed to start server', { error: error.message });
    process.exit(1);
  }
};

startServer();

module.exports = { server, io, startServer };