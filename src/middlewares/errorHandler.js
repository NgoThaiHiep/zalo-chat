const { AppError } = require('../untils/errorHandler')

const errorHandler = (err, req, res, next) => {
  console.error(`Error: ${err.message}\nStack: ${err.stack}`);
  
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  
  res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau!' });
};

module.exports = { errorHandler };
