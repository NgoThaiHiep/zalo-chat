const normalizePhoneNumber = (phoneNumber) => {
    console.log(`Chuẩn hóa số điện thoại: ${phoneNumber} -> ${phoneNumber.replace(/^(\+84|0)/, '84')}`);
    return phoneNumber.replace(/^(\+84|0)/, '84');
  };
  
  module.exports = { normalizePhoneNumber };