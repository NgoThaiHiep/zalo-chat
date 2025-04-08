const redis = require("redis");

// ✅ Tạo Redis client
const redisClient = redis.createClient({
    socket: {
        host: "127.0.0.1", // Địa chỉ Redis server (Localhost)
        port: 6379         // Cổng mặc định của Redis
    }
});

// ✅ Bắt sự kiện kết nối
redisClient.on("connect", () => {
    console.log("🔗 Kết nối Redis thành công!");
});

//  Xử lý lỗi Redis
redisClient.on("error", (err) => {
    console.error(" Lỗi kết nối Redis:", err);
});

//  Kết nối Redis
(async () => {
    try {
        await redisClient.connect();
    } catch (err) {
        console.error(" Lỗi khi kết nối Redis:", err);
    }
})();

module.exports = redisClient;
