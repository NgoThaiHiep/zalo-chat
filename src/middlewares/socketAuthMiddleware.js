const jwt = require('jsonwebtoken');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');

const authenticateSocket = (socket, next) => {
  const token = socket.handshake.auth.token?.replace('Bearer ', '');
  if (!token) {
    logger.warn('[SocketAuth] No token provided');
    return next(new AppError('Authentication error: No token provided', 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = { id: decoded.id }; // Lưu user ID vào socket.user.id
    logger.info('[SocketAuth] User authenticated', { userId: decoded.id });
    next();
  } catch (error) {
    logger.warn('[SocketAuth] Invalid token', { error: error.message });
    return next(new AppError('Authentication error: Invalid token', 403));
  }
};

module.exports = authenticateSocket;