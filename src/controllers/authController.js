const jwt = require('jsonwebtoken');
const AuthService = require('../services/auth.service');
const OtpService = require('../services/otp.services');
const redisClient = require('../config/redis');


const loginController = async (req, res) => {
  try {
    let { phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
      return res.status(400).json({ success: false, message: 'Thiếu số điện thoại hoặc mật khẩu!' });
    }
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.startsWith('0')) phoneNumber = '84' + phoneNumber.substring(1);

    const { user, token } = await AuthService.loginUser(phoneNumber, password);
    res.json({
      success: true,
      message: 'Đăng nhập thành công!',
      token,
      user: { id: user.userId, name: user.name, phoneNumber: user.phoneNumber },
    });
  } catch (error) {
    res.status(500).json({ message: 'Lỗi server', error: error.message });
  }
};

const logoutController = async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Không tìm thấy token xác thực' });
    }

    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
    }

    await redisClient.setEx(token, 604800, 'blacklisted');
    res.json({ success: true, message: 'Đăng xuất thành công' });
  } catch (error) {
    console.error('Lỗi trong quá trình đăng xuất:', error);
    res.status(500).json({ success: false, message: 'Lỗi server khi xử lý đăng xuất' });
  }
};

const getProfileController = async (req, res) => {
  try {
      const userId = req.user.id; // Lấy từ JWT token qua authMiddleware
      if (!userId) {
          return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
      }

      const userData = await AuthService.getProfile(userId);
      res.json({
          success: true,
          data: userData
      });
  } catch (error) {
      console.error("❌ Lỗi trong controller lấy profile:", error.message);
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

    // Kiểm tra các trường bắt buộc
    if (!phoneNumber || !name || !password || !otp) {
       return res.status(400).json({ success: false, message: 'Thiếu thông tin cần thiết! (phoneNumber, name, password, otp)' });
    }
     // Kiểm tra định dạng số điện thoại hợp lệ
     const phoneRegex = /^(0\d{9}|84\d{9}|\+84\d{9})$/;
     if (!phoneRegex.test(phoneNumber)) {
       return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ!' });
     }   
    // Kiểm tra độ dài mật khẩu
    if (password.length < 10) {
      return res.status(400).json({ success: false, message: 'Mật khẩu phải dài ít nhất 10 ký tự!' });
    }

    // Kiểm tra mật khẩu có chứa số, ký tự đặc biệt, chữ hoa, chữ thường
    const hasNumber = /[0-9]/.test(password);
    const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);

    if (!hasNumber || !hasSpecialChar || !hasUpperCase || !hasLowerCase) {
      return res.status(400).json({
        success: false,
        message: 'Mật khẩu phải chứa ít nhất một số, một ký tự đặc biệt, một chữ hoa và một chữ thường!'
      });
    }
    // Tạo user với OTP
    const newUser = await AuthService.createUser(phoneNumber, password, name, otp);

    // Tạo JWT token
    const token = jwt.sign(
      { id: newUser.userId, name: newUser.name, phoneNumber: newUser.phoneNumber },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Đăng ký thành công!',
      token,
      user: { id: newUser.userId, name: newUser.name, phoneNumber: newUser.phoneNumber },
    });
  } catch (error) {
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
    // Xóa OTP sau khi cập nhật mật khẩu thành công
    await OtpService.deleteOTP(phoneNumber);

    res.json({ success: true, message: 'Đặt lại mật khẩu thành công!' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};



const changePasswordController = async (req, res) => {
  try {
      const { oldPassword, newPassword } = req.body;
      const userId = req.user.id; // Lấy từ JWT token qua middleware

      if (!oldPassword || !newPassword) {
          return res.status(400).json({ message: "Thiếu mật khẩu cũ hoặc mật khẩu mới!" });
      }

      const result = await AuthService.changeUserPassword(userId, oldPassword, newPassword);
      return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
      console.error("❌ Lỗi đổi mật khẩu:", error.message);
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
    res.status(400).json({ success: false, message: error.message });
  }
};

const updateUserProfileController = async (req, res) => {
  try {
    console.log("🔍 req.body:", req.body);
    console.log("🔍 req.files:", req.files);

    // Lấy dữ liệu từ req.body
    const { dateOfBirth, gender, phoneNumber, name, bio } = req.body;
    const userId = req.user.id;

    // Xử lý file từ req.files
    const avatarFile = req.files?.avatar ? req.files.avatar[0] : null;
    const coverPhotoFile = req.files?.coverPhoto ? req.files.coverPhoto[0] : null;

    if (avatarFile) {
      console.log("🔍 Avatar file details:", avatarFile);
    } else {
      console.log("🔍 No avatar file received");
    }
    if (coverPhotoFile) {
      console.log("🔍 Cover photo file details:", coverPhotoFile);
    } else {
      console.log("🔍 No cover photo file received");
    }

    // Tạo object updates
    const updates = {
      dateOfBirth,
      gender,
      phoneNumber,
      name,
      bio
    };

    // Tạo object files chứa cả avatar và coverPhoto
    const files = {
      avatar: avatarFile,
      coverPhoto: coverPhotoFile
    };

    // Gọi service với userId, updates, và files
    const updatedProfile = await AuthService.updateUserProfile(userId, updates, files);

    return res.status(200).json({ success: true, data: updatedProfile });
  } catch (error) {
    console.error("❌ Lỗi cập nhật profile:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

module.exports = {
  loginController,
  logoutController,
  getProfileController,
  sendOTPController,
  registerController,
  resetPasswordController,
  verifyOTPController,
  updateUserProfileController,
  changePasswordController
  // sendMessage: [upload.single('file'), sendMessage],
};