class AppError extends Error {
      constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
      }
    }
  
  const handleError = (error, context, socketEmitter = null) => {
    console.error(`Error in ${context}:`, error.message, error.stack);
    if (socketEmitter) {
      socketEmitter.emit('error', { message: error.message });
    }
    throw new AppError(error.message);
  };
  
  module.exports = { AppError, handleError };