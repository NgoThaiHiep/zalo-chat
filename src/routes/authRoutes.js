const express = require('express');
const multer = require('multer');
const router = express.Router();

const { loginController, logoutController, getProfileController } = require('../controllers/authController');
const { 
    sendOTPController, 
    registerController,
    resetPasswordController, 
    verifyOTPController,
    updateUserProfileController,
    changePasswordController 
} = require('../controllers/authController'); // Gộp OTP vào authController
const checkBlacklist = require('../middlewares/checkBlacklist');
const {authMiddleware ,checkOwnership} = require('../middlewares/authMiddleware');
const { updateUserPassword } = require('../services/auth.service');
const upload = multer({ storage: multer.memoryStorage() });

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
router.patch('/profile', authMiddleware, upload.fields([{ name: 'avatar', maxCount: 1 }]), updateUserProfileController);


module.exports = router;