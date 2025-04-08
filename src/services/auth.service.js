// Chứa các hàm liên quan đến đăng nhập và đăng ký
const { dynamoDB } = require('../config/aws.config');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { verifyOTP, deleteOTP,getUserByPhoneNumber } = require('./otp.services');

const normalizePhoneNumber = (phoneNumber) => {
    console.log(`Chuẩn hóa số điện thoại: ${phoneNumber} -> ${phoneNumber.replace(/^(\+84|0)/, '84')}`);
    return phoneNumber.replace(/^(\+84|0)/, '84');
  };


const createUser = async (phoneNumber, password, name, otp) => {
    // Kiểm tra OTP trước khi tạo user
    const normalizedPhone = await verifyOTP(phoneNumber, otp);
  
    // Tạo user
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
      userId,
      phoneNumber: normalizedPhone,
      password: hashedPassword,
      name,
      createdAt: new Date().toISOString(),
    };
  
    await dynamoDB.put({ TableName: 'Users', Item: user }).promise();
  
    // Xóa OTP sau khi tạo user thành công
    await deleteOTP(phoneNumber);
  
    return user;
  };

const loginUser = async (phoneNumber, password) => {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const user = await getUserByPhoneNumber(normalizedPhone);

    if (!user) {
        throw new Error("Sai số điện thoại hoặc mật khẩu!");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        throw new Error("Sai số điện thoại hoặc mật khẩu!");
    }

    const token = jwt.sign(
        { id: user.userId, name: user.name, phoneNumber: user.phoneNumber },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

    return { user, token };
};

const updateUserPassword = async (userId, newPassword,phoneNumber) => {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    try {
        await dynamoDB.update({
            TableName: "Users",
            Key: { userId },
            UpdateExpression: "set password = :password",
            ExpressionAttributeValues: {
                ":password": hashedPassword
            }
        }).promise();
          // Xóa OTP sau khi update mật khẩu
          await deleteOTP(phoneNumber);
    } catch (error) {
        console.error("❌ Lỗi cập nhật mật khẩu:", error);
        throw new Error("Không thể cập nhật mật khẩu!");
    }
};

module.exports = { createUser, loginUser, updateUserPassword };
