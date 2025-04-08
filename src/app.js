require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const messageRoutes = require('./routes/messageRoutes');
const groupRoutes = require('./routes/groupRoutes');

const app = express();

// Middleware
app.use(
  cors({
    origin: 'http://localhost:3001',
    credentials: true,
  })
);
app.use(express.json());

// Định nghĩa routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/groups', groupRoutes);

module.exports = app; // Chỉ export app