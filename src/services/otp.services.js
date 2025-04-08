const redisClient = require("../config/redis");
const {dynamoDB, sns } = require("../config/aws.config");


const normalizePhoneNumber = (phoneNumber) => {
  console.log(`Chuẩn hóa số điện thoại: ${phoneNumber} -> ${phoneNumber.replace(/^(\+84|0)/, '84')}`);
  return phoneNumber.replace(/^(\+84|0)/, '84');
};

// Gửi OTP
const sendOTP = async (phoneNumber, purpose = 'register') => {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const existingUser = await getUserByPhoneNumber(normalizedPhone);
    if (purpose === 'register' && existingUser) {
      throw new Error('Số điện thoại đã được đăng ký!');
    }
    if (purpose === 'reset-password' && !existingUser) {
      throw new Error('Số điện thoại không tồn tại!');
    }
    await deleteOTP(phoneNumber);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redisClient.setEx(`otp:${normalizedPhone}`, 180, otp);
    console.log(`📩 OTP gửi đến ${normalizedPhone}: ${otp}`);
    try {
    await sns.publish({
      Message: `Mã OTP của bạn là: ${otp}. Vui lòng không chia sẻ với ai. Mã OTP có hiệu lực trong 3 phút.`,
      PhoneNumber: `+${normalizedPhone}`,
      MessageAttributes: {
        'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: 'OTPService' },
        'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
      },
    }).promise();
  } catch (error) {
    console.error('❌ Lỗi khi gửi SMS qua AWS SNS:', error);
    throw new Error('Không thể gửi SMS OTP. Vui lòng thử lại sau!');
  }
    return normalizedPhone;
  };

const verifyOTP = async (phoneNumber, otp) => {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const storedOTP = await redisClient.get(`otp:${normalizedPhone}`);
  
    console.log(`🔍 Kiểm tra OTP cho ${normalizedPhone}: Lưu=${storedOTP}, Nhập=${otp}`);
  
    if (!storedOTP || storedOTP !== otp) {
      throw new Error('OTP không hợp lệ hoặc đã hết hạn!');
    }
    await redisClient.expire(`otp:${normalizedPhone}`, 600);
    console.log(`⏳ Đã tăng thời gian sống của OTP cho ${normalizedPhone} lên 10 phút`);
    return normalizedPhone;
  };
const deleteOTP = async (phoneNumber) => {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    await redisClient.del(`otp:${normalizedPhone}`);
  };

const getUserByPhoneNumber = async (phoneNumber) => {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const params = {
        TableName: "Users",
        IndexName: "phoneNumber-index",
        KeyConditionExpression: "phoneNumber = :phoneNumber",
        ExpressionAttributeValues: {
            ":phoneNumber": normalizedPhone
        }
    };

    try {
        const result = await dynamoDB.query(params).promise();
        return result.Items.length > 0 ? result.Items[0] : null;
    } catch (error) {
        console.error("❌ Lỗi truy vấn DynamoDB:", error);
        throw new Error("Không thể tìm người dùng.");
    }
};


module.exports = { sendOTP, verifyOTP,deleteOTP,getUserByPhoneNumber };