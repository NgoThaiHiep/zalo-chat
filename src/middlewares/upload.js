const multer = require('multer');
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    fileFilter: (req, file, cb) => {
      const allowedMimeTypes = [
        'image/jpeg', 'image/png', 'image/heic', 'image/gif',
        'video/mp4',
        'audio/mpeg', 'audio/wav', 'audio/mp4',
        'application/pdf', 'application/zip', 'application/x-rar-compressed', 'application/vnd.rar', 'text/plain',
      ];
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('MIME type không được hỗ trợ!'), false);
      }
    },
  });

module.exports = upload;