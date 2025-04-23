module.exports = {
    corsOptions: {
      origin: [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:8081',
        'http://192.168.1.2:8081',
        // Thêm các origin khác nếu cần
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    },
  };