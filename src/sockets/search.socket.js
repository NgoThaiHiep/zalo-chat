const SearchService = require('../services/search.service');
const { AppError } = require('../utils/errorHandler');
const logger = require('../config/logger');

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info('[SEARCH_SOCKET] Client connected', { socketId: socket.id, userId: socket.userId });

    socket.on('search', async ({ keyword }, callback) => {
      try {
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 3) {
          throw new AppError('Từ khóa tìm kiếm phải có ít nhất 3 ký tự', 400);
        }
        logger.info('[SEARCH_SOCKET] Searching all', { userId: socket.userId, keyword });
        const result = await SearchService.searchAll(socket.userId, keyword);
        callback({ success: true, data: result.data });
      } catch (error) {
        logger.error('[SEARCH_SOCKET] Failed to search all', { userId: socket.userId, keyword, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('searchMessages', async ({ otherUserId, keyword }, callback) => {
      try {
        if (!otherUserId || typeof otherUserId !== 'string' || !keyword || typeof keyword !== 'string' || keyword.trim().length < 3) {
          throw new AppError('otherUserId hoặc từ khóa tìm kiếm không hợp lệ, tối thiểu 3 ký tự', 400);
        }
        logger.info('[SEARCH_SOCKET] Searching messages', { userId: socket.userId, otherUserId, keyword });
        const result = await SearchService.searchMessagesBetweenUsers(socket.userId, otherUserId, keyword);
        callback({ success: true, data: result.data });
      } catch (error) {
        logger.error('[SEARCH_SOCKET] Failed to search messages', { userId: socket.userId, otherUserId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('searchUsers', async ({ keyword }, callback) => {
      try {
        if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 3) {
          throw new AppError('Từ khóa tìm kiếm phải có ít nhất 3 ký tự', 400);
        }
        logger.info('[SEARCH_SOCKET] Searching users', { userId: socket.userId, keyword });
        const result = await SearchService.searchUsersByNameAndPhone(socket.userId, keyword);
        callback({ success: true, data: result.data });
      } catch (error) {
        logger.error('[SEARCH_SOCKET] Failed to search users', { userId: socket.userId, error: error.message });
        callback({ success: false, error: { message: error.message, statusCode: error.statusCode || 500 } });
      }
    });

    socket.on('disconnect', () => {
      logger.info('[SEARCH_SOCKET] Client disconnected', { socketId: socket.id, userId: socket.userId });
    });
  });
};