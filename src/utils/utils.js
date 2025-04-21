const normalizePhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;

  // Xóa khoảng trắng và ký tự không cần thiết, chỉ giữ lại số
  let cleaned = phoneNumber.replace(/\D/g, '');

  // Nếu số bắt đầu bằng 0, thay bằng 84 (cho số Việt Nam)
  if (cleaned.startsWith('0')) {
    cleaned = '84' + cleaned.slice(1);
  }
  // Nếu số bắt đầu bằng +84, loại bỏ + và giữ 84
  else if (cleaned.startsWith('84')) {
    cleaned = '84' + cleaned.slice(2);
  }
  // Nếu số không bắt đầu bằng 84, trả về null (hoặc xử lý theo logic khác nếu cần)
  else {
    return null; // Hoặc có thể ném lỗi tùy yêu cầu
  }

  return cleaned;
};

module.exports = { normalizePhoneNumber };