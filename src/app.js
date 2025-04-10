require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./routes/messageRoutes');
const groupRoutes = require('./routes/groupRoutes');
const friendRoutes = require('./routes/friendRoutes')
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
// Middleware
app.use(cors({ 
        origin: 
        ['http://localhost:3001', 
          'http://localhost:8081', 
          'http://192.168.1.2:8081'], 
        credentials: true }));
app.use(express.json());
app.use(upload.any()); // Xử lý multipart/form-data

// Định nghĩa routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/friends',friendRoutes)

module.exports = app; // Chỉ export app