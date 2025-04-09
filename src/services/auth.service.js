// Chứa các hàm liên quan đến đăng nhập và đăng ký
const { s3,dynamoDB } = require('../config/aws.config');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { verifyOTP, deleteOTP,getUserByPhoneNumber } = require('./otp.services');
require('dotenv').config();

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


// Cập nhật profile
const updateUserProfile = async (userId, updates, file) => {
    try {
        const { dateOfBirth, gender, phoneNumber, name } = updates;
        let avatarUrl = null;

        // Xử lý upload ảnh nếu có file
        if (file) {
            console.log("🔍 File MIME type:", file.mimetype);
            const mimeType = file.mimetype;
            const allowedTypes = ["image/jpeg", "image/png", "image/gif",];
            if (!allowedTypes.includes(mimeType)) {
                throw new Error(`Định dạng ảnh không hỗ trợ! MIME type nhận được: ${file.mimetype}`);
            }
            const s3Key = `avatars/${userId}/${uuidv4()}.${mimeType.split('/')[1]}`;
            console.log(process.env.BUCKET_AVATA_PROFILE);
            
            await s3.upload({
                Bucket: process.env.BUCKET_AVATA_PROFILE,
                Key: s3Key,
                Body: file.buffer,
                ContentType: mimeType,
            }).promise();
            avatarUrl = `s3://${process.env.BUCKET_AVATA_PROFILE}/${s3Key}`;

        }

        // Lấy bản ghi hiện tại để kiểm tra các trường đã tồn tại chưa
        const currentUser = await dynamoDB.get({
            TableName: "Users",
            Key: { userId }
        }).promise();

        if (!currentUser.Item) {
            throw new Error("Người dùng không tồn tại!");
        }

        // Chuẩn bị UpdateExpression và ExpressionAttributeValues động
        let updateExpression = "set";
        const expressionAttributeValues = {};
        const expressionAttributeNames = {};

        // Các trường mặc định sẽ được thêm nếu chưa tồn tại
        const defaultFields = {
            dateOfBirth: null,
            gender: null,
            avatar: null
        };

        // Thêm các trường mặc định nếu chưa có trong bản ghi hiện tại
        if (!currentUser.Item.dateOfBirth && !dateOfBirth) {
            updateExpression += " dateOfBirth = :dobDefault,";
            expressionAttributeValues[":dobDefault"] = defaultFields.dateOfBirth;
        }
        if (!currentUser.Item.gender && !gender) {
            updateExpression += " gender = :genderDefault,";
            expressionAttributeValues[":genderDefault"] = defaultFields.gender;
        }
        if (!currentUser.Item.avatar && !avatarUrl) {
            updateExpression += " avatar = :avatarDefault,";
            expressionAttributeValues[":avatarDefault"] = defaultFields.avatar;
        }

        // Thêm các trường từ updates hoặc file nếu có
        if (dateOfBirth) {
            updateExpression += " dateOfBirth = :dob,";
            expressionAttributeValues[":dob"] = dateOfBirth;
        }
        if (gender) {
            updateExpression += " gender = :gender,";
            expressionAttributeValues[":gender"] = gender;
        }
        if (avatarUrl) {
            updateExpression += " avatar = :avatar,";
            expressionAttributeValues[":avatar"] = avatarUrl;
        }
        if (phoneNumber) {
            const normalizedPhone = normalizePhoneNumber(phoneNumber);
            updateExpression += " phoneNumber = :phone,";
            expressionAttributeValues[":phone"] = normalizedPhone;
        }
        if (name) {
            updateExpression += " #name = :name,";
            expressionAttributeValues[":name"] = name;
            expressionAttributeNames["#name"] = "name";
        }

        // Xóa dấu phẩy cuối cùng
        updateExpression = updateExpression.slice(0, -1);
        if (updateExpression === "set") {
            throw new Error("Không có thông tin nào để cập nhật!");
        }

        const params = {
            TableName: "Users",
            Key: { userId },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ReturnValues: "ALL_NEW"
        };

        const result = await dynamoDB.update(params).promise();
        return result.Attributes;
    } catch (error) {
        console.error("❌ Lỗi cập nhật profile:", error);
        throw new Error(error.message || "Không thể cập nhật profile!");
    }
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

// Cập nhật mật khẩu khi đang đăng nhập
const changeUserPassword = async (userId, oldPassword, newPassword) => {
    try {
        // Lấy thông tin user từ DynamoDB
        const userData = await dynamoDB.get({
            TableName: "Users",
            Key: { userId }
        }).promise();

        if (!userData.Item) {
            throw new Error("Người dùng không tồn tại!");
        }

        // Kiểm tra mật khẩu cũ
        const isMatch = await bcrypt.compare(oldPassword, userData.Item.password);
        if (!isMatch) {
            throw new Error("Mật khẩu cũ không đúng!");
        }

        // Mã hóa mật khẩu mới
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Cập nhật mật khẩu trong DynamoDB
        await dynamoDB.update({
            TableName: "Users",
            Key: { userId },
            UpdateExpression: "set password = :password",
            ExpressionAttributeValues: {
                ":password": hashedPassword
            }
        }).promise();

        return { message: "Đổi mật khẩu thành công!" };
    } catch (error) {
        console.error("❌ Lỗi cập nhật mật khẩu:", error);
        throw new Error(error.message || "Không thể cập nhật mật khẩu!");
    }
};

// Thêm hàm getProfileService
const getProfile = async (userId) => {
    try {
        const result = await dynamoDB.get({
            TableName: 'Users',
            Key: { userId }
        }).promise();

        if (!result.Item) {
            throw new Error('Không tìm thấy người dùng trong cơ sở dữ liệu!');
        }

        // Loại bỏ trường password để bảo mật
        const { password, ...userData } = result.Item;
        return userData;
    } catch (error) {
        console.error("❌ Lỗi lấy profile từ service:", error.message);
        throw new Error(error.message || 'Lỗi khi lấy thông tin profile!');
    }
};
module.exports = { createUser, loginUser, updateUserPassword,updateUserProfile ,changeUserPassword,getProfile};
