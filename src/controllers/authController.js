const jwt = require('jsonwebtoken');
const AuthService = require('../services/auth.service');
const OtpService = require('../services/otp.services');
const { redisClient } = require('../config/redis');
const logger = require('../config/logger');
const { dynamoDB } = require('../config/aws.config');
const { isValidUUID } = require('../utils/helpers');
const { AppError } = require('../utils/errorHandler');
const loginController = async (req, res) => {
  try {
    let { phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
      return res.status(400).json({ success: false, message: 'Thiếu số điện thoại hoặc mật khẩu!' });
    }
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.startsWith('0')) phoneNumber = '84' + phoneNumber.substring(1);

    const { user, token } = await AuthService.loginUser(phoneNumber, password);

    // Phát sự kiện user:login qua namespace /auth
    if (req.io) {
      req.io.of('/auth').to(user.userId).emit('user:status', { userId: user.userId, status: 'online' });
      logger.info(`[loginController] Emitted user:login for user ${user.userId}`);
    } else {
      logger.warn('[loginController] req.io not available, skipping socket emission');
    }

    res.json({
      success: true,
      message: 'Đăng nhập thành công!',
      token,
      user: { id: user.userId, name: user.name, phoneNumber: user.phoneNumber },
    });
  } catch (error) {
    logger.error('[loginController] Error', { error: error.message });
    res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};

const logoutController = async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Không tìm thấy token xác thực' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
    }

    const userId = decoded.id;

    await redisClient.set(token, 'blacklisted', 'EX', 604800);
    await AuthService.updateOnlineStatus(userId, false);

    // Phát sự kiện qua namespace /auth
    if (req.io) {
      req.io.of('/auth').to(userId).emit('user:status', { userId, status: 'offline' });
      logger.info(`[logoutController] Emitted user:status offline for user ${userId}`);
    } else {
      logger.warn('[logoutController] req.io not available, skipping socket emission');
    }

    res.json({ success: true, message: 'Đăng xuất thành công' });
  } catch (error) {
    logger.error('[logoutController] Error', { error: error.message });
    res.status(500).json({ success: false, message: 'Đăng xuất thất bại!' });
  }
};

const getProfileController = async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
    }

    const userData = await AuthService.getOwnProfile(userId);
    res.json({
      success: true,
      data: userData,
    });
  } catch (error) {
    logger.error('[getProfileController] Error', { error: error.message });
    res.status(500).json({ success: false, message: 'Lỗi server', error: error.message });
  }
};

const sendOTPController = async (req, res) => {
  try {
    let { phoneNumber, purpose } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không được để trống!' });
    }
    const normalizedPhone = await OtpService.sendOTP(phoneNumber, purpose || 'register');
    res.json({ success: true, message: 'OTP đã được gửi!', phoneNumber: normalizedPhone });
  } catch (error) {
    logger.error('[sendOTPController] Error', { error: error.message });
    res.status(400).json({ success: false, message: error.message });
  }
};

const registerController = async (req, res) => {
  try {
    const { phoneNumber, name, password, otp } = req.body;
    const missingFields = [];
    if (!phoneNumber) missingFields.push('phoneNumber');
    if (!name) missingFields.push('name');
    if (!password) missingFields.push('password');
    if (!otp) missingFields.push('otp');
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Thiếu thông tin: ${missingFields.join(', ')}!`,
      });
    }

    if (!phoneNumber || !name || !password || !otp) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin cần thiết! (phoneNumber, name, password, otp)' });
    }
    const phoneRegex = /^(0\d{9}|84\d{9}|\+84\d{9})$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ!' });
    }
    if (password.length < 10) {
      return res.status(400).json({ success: false, message: 'Mật khẩu phải dài ít nhất 10 ký tự!' });
    }

    const hasNumber = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);

    if (!hasNumber || !hasSpecialChar || !hasUpperCase || !hasLowerCase) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu phải chứa ít nhất một số, một ký tự đặc biệt, một chữ hoa và một chữ thường!',
      });
    }

    const newUser = await AuthService.createUser(phoneNumber, password, name, otp);
    const token = jwt.sign(
      { id: newUser.userId, name: newUser.name, phoneNumber: newUser.phoneNumber },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Phát sự kiện user:login cho user mới
    if (req.io) {
      req.io.of('/auth').to(newUser.userId).emit('user:status', { userId: newUser.userId, status: 'online' });
      logger.info(`[registerController] Emitted user:login for user ${newUser.userId}`);
    } else {
      logger.warn('[registerController] req.io not available, skipping socket emission');
    }

    res.status(201).json({
      success: true,
      message: 'Đăng ký thành công!',
      token,
      user: { id: newUser.userId, name: newUser.name, phoneNumber: newUser.phoneNumber },
    });
  } catch (error) {
    logger.error('[registerController] Error', { error: error.message });
    res.status(400).json({ success: false, message: error.message });
  }
};

const resetPasswordController = async (req, res) => {
  try {
    let { phoneNumber, otp, newPassword } = req.body;
    if (!phoneNumber || !otp || !newPassword) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin cần thiết!' });
    }

    await OtpService.verifyOTP(phoneNumber, otp);
    const user = await OtpService.getUserByPhoneNumber(phoneNumber);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Người dùng không tồn tại!' });
    }

    await AuthService.updateUserPassword(user.userId, newPassword, phoneNumber);
    await OtpService.deleteOTP(phoneNumber);

    res.json({ success: true, message: 'Đặt lại mật khẩu thành công!' });
  } catch (error) {
    logger.error('[resetPasswordController] Error', { error: error.message });
    res.status(400).json({ success: false, message: error.message });
  }
};

const changePasswordController = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ message: 'Thiếu mật khẩu cũ hoặc mật khẩu mới!' });
    }

    const result = await AuthService.changeUserPassword(userId, oldPassword, newPassword);
    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    logger.error('[changePasswordController] Error', { error: error.message });
    return res.status(400).json({ success: false, message: error.message });
  }
};

const verifyOTPController = async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không được để trống!' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP không được để trống!' });
    }
    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'Mã OTP phải là 6 chữ số!' });
    }

    await OtpService.verifyOTP(phoneNumber, otp);
    res.json({ success: true, message: 'Xác nhận OTP thành công!' });
  } catch (error) {
    logger.error('[verifyOTPController] Error', { error: error.message });
    res.status(400).json({ success: false, message: error.message });
  }
};

const updateUserProfileController = async (req, res) => {
  try {
    console.log('🔍 req.body:', req.body);
    console.log('🔍 req.files:', req.files);

    const { dateOfBirth, gender, phoneNumber, name, bio } = req.body;
    const userId = req.user.id;

    const avatarFile = req.files?.avatar ? req.files.avatar[0] : null;
    const coverPhotoFile = req.files?.coverPhoto ? req.files.coverPhoto[0] : null;

    if (avatarFile) {
      console.log('🔍 Avatar file details:', avatarFile);
    } else {
      console.log('🔍 No avatar file received');
    }
    if (coverPhotoFile) {
      console.log('🔍 Cover photo file details:', coverPhotoFile);
    } else {
      console.log('🔍 No cover photo file received');
    }

    const updates = {
      dateOfBirth,
      gender,
      phoneNumber,
      name,
      bio,
    };

    const files = {
      avatar: avatarFile,
      coverPhoto: coverPhotoFile,
    };

    const updatedProfile = await AuthService.updateUserProfile(userId, updates, files);

    // Phát sự kiện qua namespace /auth để thông báo bạn bè
    if (req.io) {
      const friends = await dynamoDB.scan({
        TableName: 'Friends',
        FilterExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise();
      const friendIds = friends.Items.map(item => item.friendId);

      // Phát sự kiện profile:update tới bạn bè
      req.io.of('/auth').to(friendIds).emit('profile:update', {
        userId,
        updatedFields: {
          name: updatedProfile.name,
          avatar: updatedProfile.avatar,
          coverPhoto: updatedProfile.coverPhoto,
          bio: updatedProfile.bio,
        },
      });
      logger.info(`[updateUserProfileController] Emitted profile:update for user ${userId} to ${friendIds.length} friends`);
    } else {
      logger.warn('[updateUserProfileController] req.io not available, skipping socket emission');
    }

    return res.status(200).json({ success: true, data: updatedProfile });
  } catch (error) {
    logger.error('[updateUserProfileController] Error', { error: error.message });
    return res.status(400).json({ success: false, message: error.message });
  }
};

const updateOnlineStatusController = async (req, res) => {
  const { status } = req.body;
  const userId = req.user.id;
  try {
    const result = await AuthService.updateOnlineStatus(userId, status);
    // Phát sự kiện qua namespace /auth
    if (req.io) {
      req.io.of('/auth').to(userId).emit('user:status', { userId, status: status ? 'online' : 'offline' });
      logger.info(`[updateOnlineStatusController] Emitted user:status for user ${userId}`);
    } else {
      logger.warn('[updateOnlineStatusController] req.io not available, skipping socket emission');
    }
    res.status(200).json(result);
  } catch (error) {
    logger.error('[updateOnlineStatusController] Error', { error: error.message });
    res.status(500).json({ message: 'Error updating online status', error: error.message });
  }
};

const updatePrivacySettingsController = async (req, res) => {
  const { showOnline } = req.body;
  const userId = req.user.id;
  try {
    if (!showOnline) {
      return res.status(400).json({ success: false, message: 'showOnline là bắt buộc!' });
    }
    const result = await AuthService.updatePrivacySettings(userId, showOnline);
    // Phát sự kiện qua namespace /auth
    if (req.io) {
      const friends = await dynamoDB.scan({
        TableName: 'Friends',
        FilterExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }).promise();
      const friendIds = friends.Items.map(item => item.friendId);
      req.io.of('/auth').to(friendIds).emit('user:status', {
        userId,
        status: showOnline === 'none' ? 'hidden' : 'online',
      });
      logger.info(`[updatePrivacySettingsController] Emitted user:status for user ${userId} to friends`);
    } else {
      logger.warn('[updatePrivacySettingsController] req.io not available, skipping socket emission');
    }
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('[updatePrivacySettingsController] Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateRestrictStrangerMessagesController = async (req, res) => {
  const { restrict } = req.body;
  const userId = req.user.id;
  try {
    if (typeof restrict !== 'boolean') {
      throw new AppError('restrict phải là boolean', 400);
    }
    const result = await AuthService.updateRestrictStrangerMessages(userId, restrict);
    if (req.io) {
      req.io.of('/auth').to(userId).emit('restrictStrangerMessages:update', {
        success: true,
        message: `Hạn chế tin nhắn từ người lạ được đặt thành ${restrict}`,
      });
      logger.info(`[updateRestrictStrangerMessagesController] Emitted restrictStrangerMessages:update for user ${userId}`);
    }
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    logger.error('[updateRestrictStrangerMessagesController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi cập nhật cài đặt hạn chế tin nhắn', error.statusCode || 500);
  }
};

const updateReadReceiptsSettingController = async (req, res) => {
  try {
    const userId = req.user.id;
    const { showReadReceipts } = req.body;
    if (typeof showReadReceipts !== 'boolean') {
      throw new AppError('showReadReceipts phải là boolean', 400);
    }
    const result = await AuthService.updateReadReceiptsSetting(userId, showReadReceipts);
    if (req.io) {
      req.io.of('/auth').to(userId).emit('readReceipts:update', {
        success: true,
        message: `Cài đặt biên nhận đọc được đặt thành ${showReadReceipts}`,
      });
      logger.info(`[updateReadReceiptsSettingController] Emitted readReceipts:update for user ${userId}`);
    }
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    logger.error('[updateReadReceiptsSettingController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi cập nhật cài đặt biên nhận đọc', error.statusCode || 500);
  }
};

const getUserActivityStatusController = async (req, res) => {
  try {
    const { userId } = req.params;
    const requesterId = req.user.id;
    if (!isValidUUID(userId)) {
      throw new AppError('userId không hợp lệ', 400);
    }
    const activityStatus = await AuthService.getUserActivityStatus(userId, requesterId);
    res.status(200).json({ success: true, data: activityStatus });
  } catch (error) {
    logger.error('[getUserActivityStatusController] Error', { error: error.message });
    throw new AppError(error.message || 'Lỗi khi lấy trạng thái hoạt động', error.statusCode || 500);
  }
};
module.exports = {
  loginController,
  logoutController,
  updateUserProfileController,
  changePasswordController,
  resetPasswordController,
  getProfileController,
  sendOTPController,
  registerController,
  verifyOTPController,
  updateOnlineStatusController,
  updatePrivacySettingsController,
  updateRestrictStrangerMessagesController,
  updateReadReceiptsSettingController,
  getUserActivityStatusController,
};