require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { corsOptions } = require('./config/cors');
const { errorHandler } = require('./middlewares/errorHandler'); // Middleware xử lý lỗi
const morgan = require('morgan'); // Logging middleware

const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./routes/messageRoutes');
const groupRoutes = require('./routes/groupRoutes');
const friendRoutes = require('./routes/friendRoutes')
const conversationRoutes = require('./routes/conversationRoutes');
const searchRoutes = require('./routes/searchRouters'); // Tìm kiếm người dùng và tin nhắn
const app = express();

// Middleware

app.use(cors(corsOptions)); // Áp dụng cấu hình CORS
app.use(morgan('combined')); // Ghi log các request
app.use(express.json()); // Parse JSON body


// Định nghĩa routes
const API_PREFIX = '/api';
app.use(`${API_PREFIX}/auth`, authRoutes); // Quản lý xác thực
app.use(`${API_PREFIX}/messages`, messageRoutes); // Quản lý tin nhắn
app.use(`${API_PREFIX}/groups`, groupRoutes); // Quản lý nhóm
app.use(`${API_PREFIX}/friends`, friendRoutes); // Quản lý bạn bè
app.use(`${API_PREFIX}/conversations`, conversationRoutes); // Quản lý hội thoại
app.use(`${API_PREFIX}/searchs`, searchRoutes); // Tìm kiếm người dùng và tin nhắn

// Xử lý lỗi toàn cục
app.use(errorHandler);

module.exports = app; // Chỉ export app