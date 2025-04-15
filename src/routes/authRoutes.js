const express = require('express');
const router = express.Router();
const { uploadProfileImages } = require('../middlewares/uploadMiddleware');
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


// Sử dụng POST cho các hành động tạo mới (register, login, send-otp, reset-password, logout, verify-otp).
// Sử dụng PATCH cho các hành động cập nhật (profile, reset-password-login).
// Sử dụng GET cho việc lấy dữ liệu (profile).

// Nhóm: Đăng ký và xác thực
router.post('/register', registerController); // Đăng ký người dùng
router.post('/send-otp', sendOTPController); //Gửi mã OTP
router.post('/verify-otp', verifyOTPController); //Xác thực mã OTP
router.post('/login', loginController); // Đăng nhập người dùng
router.post('/logout', authMiddleware,checkBlacklist,logoutController);// Đăng xuất người dùng

// Nhóm: Quản lý mật khẩu
router.post('/reset-password', resetPasswordController);// Đặt lại mật khẩu (không cần đăng nhập) 
router.patch('/reset-password-login', authMiddleware, checkBlacklist, changePasswordController); // Thay đổi mật khẩu (đã đăng nhập)

// Nhóm: Quản lý hồ sơ
router.get('/profile', authMiddleware, checkBlacklist, getProfileController); // Lấy hồ sơ người dùng
router.patch(
    '/profile',
    authMiddleware,
    uploadProfileImages, // Sử dụng middleware riêng
    updateUserProfileController
  );// Cập nhật hồ sơ (avatar, coverPhoto)

// Nhóm: Cài đặt người dùng
router.patch('/online-status', authMiddleware, updateOnlineStatusController); // Cập nhật trạng thái trực tuyến
router.patch('/privacy-settings', authMiddleware, updatePrivacySettingsController); // Cập nhật cài đặt quyền riêng tư
router.patch('/restrict-stranger-messages', authMiddleware, updateRestrictStrangerMessagesController); // Hạn chế tin nhắn từ người lạ
router.patch('/update-read-receipts', authMiddleware, updateReadReceiptsSettingController); // Cập nhật cài đặt biên lai đọc


module.exports = router;