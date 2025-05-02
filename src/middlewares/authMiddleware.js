const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

const authMiddleware = (req, res, next) => {
    const authHeader = req.header("Authorization");
  
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.warn("⚠️ Token không hợp lệ hoặc không tồn tại.");
      return res.status(401).json({ message: "Không có token, từ chối truy cập!" });
    }
  
    const token = authHeader.replace("Bearer ", "").trim();
  
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (error) {
      console.error("❌ Token không hợp lệ:", error.message);
      return res.status(401).json({ message: "Token không hợp lệ!" });
    }
  };

const checkOwnership = (req, res, next) => {
    const userIdFromToken = req.user.id;
    const userIdFromRequest = req.body.userId || req.params.userId; // Nếu có userId trong body hoặc params

    if (userIdFromRequest && userIdFromToken !== userIdFromRequest) {
        return res.status(403).json({ success: false, message: "Bạn không có quyền cập nhật thông tin của người dùng khác!" });
    }
    next();
};
module.exports = {authMiddleware , checkOwnership }