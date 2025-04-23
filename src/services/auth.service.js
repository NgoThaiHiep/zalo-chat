// Chứa các hàm liên quan đến đăng nhập và đăng ký
const { s3, dynamoDB } = require('../config/aws.config');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { verifyOTP, deleteOTP, getUserByPhoneNumber } = require('./otp.services');
require('dotenv').config();
const { normalizePhoneNumber } = require('../utils/utils');
const logger = require('../config/logger');
const { redisClient } = require('../config/redis'); // Import Redis client

// Kiểm tra người dùng online/offline
const isUserOnline = async (userId) => {
  try {
    const onlineStatus = await redisClient.get(`user:online:${userId}`);
    return !!onlineStatus; // True if user is online, false otherwise
  } catch (error) {
    logger.error('[isUserOnline] Error checking online status', { userId, error: error.message });
    return false; // Fallback to offline on error
  }
};

// Cập nhật trạng thái khi kết nối/ngắt kết nối
const updateUserOnlineStatus = async (userId, isOnline) => {
  try {
    await redisClient.set(`online:${userId}`, isOnline ? 'true' : 'false', 'EX', 60);
    logger.info(`[updateUserOnlineStatus] Updated status for ${userId}: ${isOnline}`);
  } catch (error) {
    logger.error('[updateUserOnlineStatus] Error updating status', { userId, error: error.message });
  }
};

// Lấy trạng thái hoạt động của người dùng
const getUserActivityStatus = async (userId, requesterId) => {
  const user = await dynamoDB.get({ TableName: 'Users', Key: { userId } }).promise();
  if (!user.Item) return { status: 'unknown', lastActive: null };

  const { privacySettings = {}, lastActive } = user.Item;
  const showOnline = privacySettings.showOnline || 'none';

  const isFriend = requesterId && await dynamoDB.get({
    TableName: 'Friends',
    Key: { userId, friendId: requesterId },
  }).promise().then(result => !!result.Item);

  if (showOnline === 'none' || (showOnline === 'friends_only' && !isFriend)) {
    return { status: 'hidden', lastActive: null };
  }

  const online = await isUserOnline(userId);
  if (online) {
    return { status: 'online', lastActive: new Date().toISOString(), display: 'Vừa mới truy cập' };
  } else {
    const timeDiffMinutes = lastActive ? (new Date() - new Date(lastActive)) / (1000 * 60) : null;
    return {
      status: 'offline',
      lastActive,
      display: timeDiffMinutes ? `Hoạt động ${Math.round(timeDiffMinutes)} phút trước` : 'Không xác định'
    };
  }
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
    privacySettings: { 
      showOnline: 'friends_only' ,
      showProfile: 'friends_only',
    }, // Mặc định chỉ bạn bè thấy trạng thái online
    restrictStrangerMessages: false, // Mặc định nhận tin nhắn từ người lạ
    showReadReceipts: true, // Mặc định bật "đã xem"
  };

  await dynamoDB.put({ TableName: 'Users', Item: user }).promise();

  // Xóa OTP sau khi tạo user thành công
  await deleteOTP(phoneNumber);

  return user;
};

// Hàm để bật tắt trạng thái đã xem
const updateReadReceiptsSetting = async (userId, showReadReceipts) => {
  await dynamoDB.update({
    TableName: 'Users',
    Key: { userId },
    UpdateExpression: 'SET showReadReceipts = :value',
    ExpressionAttributeValues: { ':value': showReadReceipts },
  }).promise();
  return { message: `Trạng thái hiển thị 'đã xem' đã được ${showReadReceipts ? 'bật' : 'tắt'}` };
};

// Hàm để bật/tắt nhận tin nhắn từ người lạ
const updateRestrictStrangerMessages = async (userId, restrict) => {
  const params = {
    TableName: 'Users',
    Key: { userId },
    UpdateExpression: 'SET restrictStrangerMessages = :restrict',
    ExpressionAttributeValues: { ':restrict': restrict },
  };
  await dynamoDB.update(params).promise();
  return { message: `Giới hạn tin nhắn của người lạ được đặt thành ${restrict}` };
};

// Hàm để bật/tắt trạng thái online
const updateOnlineStatus = async (userId, status) => {
  const params = {
    TableName: 'Users',
    Key: { userId },
    UpdateExpression: 'SET onlineStatus = :status, lastActive = :now',
    ExpressionAttributeValues: {
      ':status': status ? 'online' : 'offline',
      ':now': new Date().toISOString(),
    },
  };
  await dynamoDB.update(params).promise();
  return { message: `Trạng thái người dùng đã được cập nhật thành ${status ? 'online' : 'offline'}` };
};

// Hàm để thay đổi cài đặt ẩn trạng thái hoạt động
const updatePrivacySettings = async (userId, showOnline) => {
  if (!['everyone', 'friends_only', 'none'].includes(showOnline)) {
    throw new Error('Giá trị showOnline không hợp lệ! Chấp nhận: everyone, friends_only, none');
  }
  const params = {
    TableName: 'Users',
    Key: { userId },
    UpdateExpression: 'SET privacySettings.showOnline = :showOnline',
    ExpressionAttributeValues: { ':showOnline': showOnline },
  };
  await dynamoDB.update(params).promise();
  return { success: true, message: 'Cài đặt bảo mật đã được cập nhật!' };
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
const updateUserProfile = async (userId, updates, files) => {
  try {
    const { dateOfBirth, gender, phoneNumber, name, bio } = updates;
    let avatarUrl = null;
    let coverPhotoUrl = null;

    // Xử lý upload ảnh nếu có file
    if (files) {
      if (files.avatar) {
        console.log("🔍 Avatar MIME type:", files.avatar.mimetype);
        const mimeType = files.avatar.mimetype;
        const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
        if (!allowedTypes.includes(mimeType)) {
          throw new Error(`Định dạng ảnh avatar không hỗ trợ! MIME type: ${mimeType}`);
        }
        const s3Key = `avatars/${userId}/${uuidv4()}.${mimeType.split('/')[1]}`;
        await s3.upload({
          Bucket: process.env.BUCKET_AVATA_PROFILE,
          Key: s3Key,
          Body: files.avatar.buffer,
          ContentType: mimeType,
        }).promise();
        avatarUrl = `https://${process.env.BUCKET_AVATA_PROFILE}.s3.amazonaws.com/${s3Key}`;
      }

      if (files.coverPhoto) {
        console.log("🔍 Cover photo MIME type:", files.coverPhoto.mimetype);
        const mimeType = files.coverPhoto.mimetype;
        const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
        if (!allowedTypes.includes(mimeType)) {
          throw new Error(`Định dạng ảnh bìa không hỗ trợ! MIME type: ${mimeType}`);
        }
        const s3Key = `coverPhotos/${userId}/${uuidv4()}.${mimeType.split('/')[1]}`;
        await s3.upload({
          Bucket: process.env.BUCKET_AVATA_PROFILE,
          Key: s3Key,
          Body: files.coverPhoto.buffer,
          ContentType: mimeType,
        }).promise();
        coverPhotoUrl = `https://${process.env.BUCKET_AVATA_PROFILE}.s3.amazonaws.com/${s3Key}`;
      }
    }

    // Lấy bản ghi hiện tại
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

    // Các trường mặc định (chỉ thêm nếu chưa tồn tại và không có giá trị mới)
    const defaultFields = {
      dateOfBirth: null,
      gender: null,
      avatar: null,
      bio: null,
      coverPhoto: null
    };

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
    if (!currentUser.Item.coverPhoto && !coverPhotoUrl) {
      updateExpression += " coverPhoto = :coverPhotoDefault,";
      expressionAttributeValues[":coverPhotoDefault"] = defaultFields.coverPhoto;
    }

    // Thêm các trường từ updates hoặc file
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
    if (typeof bio !== 'undefined') { // Xử lý bio kể cả khi là "" hoặc null
      updateExpression += " bio = :bio,";
      expressionAttributeValues[":bio"] = bio === "" ? null : bio; // Chuỗi rỗng -> null
    }
    if (coverPhotoUrl) {
      updateExpression += " coverPhoto = :coverPhoto,";
      expressionAttributeValues[":coverPhoto"] = coverPhotoUrl;
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

const updateUserPassword = async (userId, newPassword, phoneNumber) => {
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
const getOwnProfile = async (userId) => {
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

const verifyToken = async (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid token');
  }
};

const getActiveOwnerIds = async () => {
  try {
    const params = {
      TableName: 'Users',
      ProjectionExpression: 'userId, lastActive',
    };
    const { Items } = await dynamoDB.scan(params).promise();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const userIds = Items
      .filter(item => item.lastActive && item.lastActive >= oneDayAgo)
      .map(item => item.userId);
    logger.info(`Lấy danh sách ownerId active thành công`, { count: userIds.length });
    return userIds;
  } catch (error) {
    logger.error(`Lỗi khi lấy danh sách ownerId`, {
      error: error.message,
      code: error.code,
      requestId: error.requestId,
    });
    throw error;
  }
};

module.exports = { 
  createUser, 
  loginUser, 
  updateUserPassword,
  updateUserProfile,
  changeUserPassword,
  getOwnProfile,
  updateOnlineStatus,
  updatePrivacySettings,
  updateRestrictStrangerMessages,
  updateReadReceiptsSetting,
  isUserOnline,
  getUserActivityStatus,
  verifyToken,
  updateUserOnlineStatus,
  getActiveOwnerIds,
};