const express = require('express');
const { loginController, logoutController, getProfileController } = require('../controllers/authController');
const { sendOTPController, registerController, resetPasswordController, verifyOTPController } = require('../controllers/authController'); // Gộp OTP vào authController
const checkBlacklist = require('../middlewares/checkBlacklist');
const authMiddleware = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/logout', logoutController);
router.post('/register', registerController);
router.post('/send-otp', sendOTPController);
router.post('/reset-password', resetPasswordController);
router.post('/login', loginController);
router.post('/verify-otp', verifyOTPController);
router.get('/profile', authMiddleware, checkBlacklist, getProfileController);

module.exports = router;