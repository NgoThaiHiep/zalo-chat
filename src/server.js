const http = require('http');
const app = require('./app');
const { initializeDatabase } = require('./config/database');
const { initializeSocket } = require('./socket');
const { initializeChatSocket } = require('./sockets/chat.socket');
require('./services/messageExpiration.service');

const server = http.createServer(app);
const io = initializeSocket(server);

io.on('connection', (socket) => {
  initializeChatSocket(socket);
});

const startServer = async () => {
  try {
    await initializeDatabase();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = { server, io };