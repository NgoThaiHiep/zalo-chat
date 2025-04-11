const express = require('express');
const multer = require('multer');
const router = express.Router();

const { 
    loginController,
    logoutController,
    getProfileController,
    sendOTPController,
    registerController,
    resetPasswordController,
    verifyOTPController,
    updateUserProfileController,
    changePasswordController,
    updateOnlineStatusController,
    updatePrivacySettingsController,
    updateRestrictStrangerMessagesController,
    updateReadReceiptsSettingController,


} = require('../controllers/authController'); // Gộp OTP vào authController
const checkBlacklist = require('../middlewares/checkBlacklist');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');

// Cấu hình multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // Giới hạn 5MB
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Định dạng file không hỗ trợ!'));
      }
    }
  });

// Sử dụng POST cho các hành động tạo mới (register, login, send-otp, reset-password, logout, verify-otp).
// Sử dụng PATCH cho các hành động cập nhật (profile, reset-password-login).
// Sử dụng GET cho việc lấy dữ liệu (profile).

router.post('/send-otp', sendOTPController);
router.post('/register', registerController);
router.post('/verify-otp', verifyOTPController);
router.post('/login', loginController);
router.post('/logout', authMiddleware,checkBlacklist,logoutController);

router.post('/reset-password', resetPasswordController);
router.patch('/reset-password-login', authMiddleware, checkBlacklist, changePasswordController);

router.get('/profile', authMiddleware, checkBlacklist, getProfileController);
router.patch(
    '/profile',
    authMiddleware,
    upload.fields([
      { name: 'avatar', maxCount: 1 },
      { name: 'coverPhoto', maxCount: 1 }
    ]),
    updateUserProfileController
  );


router.post('/online-status', authMiddleware, updateOnlineStatusController); // Bật/tắt trạng thái
router.post('/privacy-settings', authMiddleware, updatePrivacySettingsController); // Cài đặt ẩn trạng thái hoạt động bạn bè hoặc mọi người

router.post('/restrict-stranger-messages', authMiddleware, updateRestrictStrangerMessagesController);

router.post('/update-read-receipts', authMiddleware, updateReadReceiptsSettingController);


module.exports = router;