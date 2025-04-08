const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

const authMiddleware = (req, res, next) => {
    try {
        console.log("📌 Authorization header:", req.header("Authorization")); // Debug header
        const token = req.header("Authorization");
        if (!token) {
            console.log("⚠️ Không tìm thấy token");
            return res.status(401).json({ message: "Không có token, từ chối truy cập!" });
        }

        const tokenValue = token.replace("Bearer ", "").trim();
        console.log("📌 Token sau khi xử lý:", tokenValue); // Debug token

        const decoded = jwt.verify(tokenValue, JWT_SECRET);
        console.log("📌 Decoded token:", decoded); // Debug decoded

        req.user = decoded;
        console.log("📌 req.user được gán:", req.user); // Debug req.user
        next();
    } catch (error) {
        console.error("❌ Lỗi xác thực token:", error.message);
        return res.status(401).json({ success: false, message: "Token không hợp lệ!" });
    }
};

module.exports = authMiddleware;