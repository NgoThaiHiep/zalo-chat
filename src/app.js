require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { corsOptions } = require('./config/cors');
const { errorHandler } = require('./middlewares/errorHandler');
const morgan = require('morgan');
const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./routes/messageRoutes');
const groupRoutes = require('./routes/groupRoutes');
const friendRoutes = require('./routes/friendRoutes');
const conversationRoutes = require('./routes/conversationRoutes');
const searchRoutes = require('./routes/searchRouters');
const { getSocketInstance } = require('./socket'); // Import from socket.js

const app = express();

// Middleware
app.use(cors(corsOptions));
app.use(morgan('combined'));
app.use(express.json());

// Gắn io vào req
app.use((req, res, next) => {
  try {
    req.io = getSocketInstance(); // Get initialized io instance
    next();
  } catch (error) {
    logger.error('[App] Failed to attach Socket.IO to req', { error: error.message });
    next(error);
  }
});

// Định nghĩa routes
const API_PREFIX = '/api';
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/messages`, messageRoutes);
app.use(`${API_PREFIX}/groups`, groupRoutes);
app.use(`${API_PREFIX}/friends`, friendRoutes);
app.use(`${API_PREFIX}/conversations`, conversationRoutes);
app.use(`${API_PREFIX}/searchs`, searchRoutes);

// Xử lý lỗi toàn cục
app.use(errorHandler);

module.exports = app;