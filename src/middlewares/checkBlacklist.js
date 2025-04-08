const redisClient = require("../config/redis");

const checkBlacklist = async (req, res, next) => {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ message: "Không có token!" });

    const isBlacklisted = await redisClient.get(token);
    if (isBlacklisted) {
        return res.status(401).json({ message: "Token đã bị thu hồi!" });
    }

    next();
};

module.exports = checkBlacklist;
