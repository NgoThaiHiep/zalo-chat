const { Server } = require("socket.io");
const {dynamoDB} = require("../config/aws.config");
const {redisClient} = require("../config/redis");


module.exports = function (io) {
  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Lắng nghe yêu cầu kết bạn
    socket.on("sendFriendRequest", async ({ senderId, receiverId }) => {
      try {
        if (senderId === receiverId) {
          socket.emit("error", { message: "Cannot send friend request to yourself" });
          return;
        }

        // Kiểm tra xem đã là bạn bè hay chưa
        const isAlreadyFriends = await dynamoDB.checkFriendStatus(senderId, receiverId);
        if (isAlreadyFriends) {
          socket.emit("error", { message: "Already friends" });
          return;
        }

        // Kiểm tra xem đã gửi yêu cầu chưa
        const isRequestSent = await dynamoDB.checkRequestStatus(senderId, receiverId);
        if (isRequestSent) {
          socket.emit("error", { message: "Friend request already sent" });
          return;
        }

        // Gửi yêu cầu kết bạn
        await dynamoDB.sendFriendRequest(senderId, receiverId);
        socket.emit("friendRequestSent", { message: "Friend request sent" });

        // Thông báo cho người nhận
        socket.to(receiverId).emit("friendRequestReceived", { senderId, message: "You have a new friend request" });

      } catch (error) {
        console.error("Error in sendFriendRequest:", error);
        socket.emit("error", { message: "An error occurred while sending friend request" });
      }
    });

    // Lắng nghe chấp nhận yêu cầu kết bạn
    socket.on("acceptFriendRequest", async ({ senderId, receiverId }) => {
      try {
        const requestStatus = await dynamoDB.checkRequestStatus(senderId, receiverId);
        if (!requestStatus) {
          socket.emit("error", { message: "No pending friend request" });
          return;
        }

        // Chấp nhận yêu cầu
        await dynamoDB.acceptFriendRequest(senderId, receiverId);
        socket.emit("friendRequestAccepted", { message: "Friend request accepted" });

        // Cập nhật thông báo cho cả hai người
        socket.to(senderId).emit("friendRequestAccepted", { receiverId, message: "Your friend request was accepted" });

        // Cập nhật thêm trong Redis hoặc thông báo theo nhu cầu
        redisClient.set(`${senderId}:${receiverId}:friends`, true);

      } catch (error) {
        console.error("Error in acceptFriendRequest:", error);
        socket.emit("error", { message: "An error occurred while accepting friend request" });
      }
    });

    // Lắng nghe từ chối yêu cầu kết bạn
    socket.on("rejectFriendRequest", async ({ senderId, receiverId }) => {
      try {
        const requestStatus = await dynamoDB.checkRequestStatus(senderId, receiverId);
        if (!requestStatus) {
          socket.emit("error", { message: "No pending friend request" });
          return;
        }

        // Từ chối yêu cầu
        await dynamoDB.rejectFriendRequest(senderId, receiverId);
        socket.emit("friendRequestRejected", { message: "Friend request rejected" });

        // Cập nhật thông báo cho người gửi
        socket.to(senderId).emit("friendRequestRejected", { receiverId, message: "Your friend request was rejected" });

      } catch (error) {
        console.error("Error in rejectFriendRequest:", error);
        socket.emit("error", { message: "An error occurred while rejecting friend request" });
      }
    });

    // Lắng nghe hủy yêu cầu kết bạn
    socket.on("cancelFriendRequest", async ({ senderId, receiverId }) => {
      try {
        const isRequestSent = await dynamoDB.checkRequestStatus(senderId, receiverId);
        if (!isRequestSent) {
          socket.emit("error", { message: "No pending request to cancel" });
          return;
        }

        // Hủy yêu cầu kết bạn
        await dynamoDB.cancelFriendRequest(senderId, receiverId);
        socket.emit("friendRequestCancelled", { message: "Friend request cancelled" });

        // Thông báo cho người nhận
        socket.to(receiverId).emit("friendRequestCancelled", { senderId, message: "Your friend request was cancelled" });

      } catch (error) {
        console.error("Error in cancelFriendRequest:", error);
        socket.emit("error", { message: "An error occurred while canceling friend request" });
      }
    });

    // Lắng nghe chặn người dùng
    socket.on("blockUser", async ({ userId, blockUserId }) => {
      try {
        if (userId === blockUserId) {
          socket.emit("error", { message: "Cannot block yourself" });
          return;
        }

        const isBlocked = await dynamoDB.isBlocked(userId, blockUserId);
        if (isBlocked) {
          socket.emit("error", { message: "User is already blocked" });
          return;
        }

        // Chặn người dùng
        await dynamoDB.blockUser(userId, blockUserId);
        socket.emit("userBlocked", { message: "User has been blocked" });

        // Thông báo cho người bị chặn
        socket.to(blockUserId).emit("userBlocked", { userId, message: "You have been blocked" });

      } catch (error) {
        console.error("Error in blockUser:", error);
        socket.emit("error", { message: "An error occurred while blocking the user" });
      }
    });

    // Lắng nghe bỏ chặn người dùng
    socket.on("unblockUser", async ({ userId, unblockUserId }) => {
      try {
        const isBlocked = await dynamoDB.isBlocked(userId, unblockUserId);
        if (!isBlocked) {
          socket.emit("error", { message: "User is not blocked" });
          return;
        }

        // Bỏ chặn người dùng
        await dynamoDB.unblockUser(userId, unblockUserId);
        socket.emit("userUnblocked", { message: "User has been unblocked" });

      } catch (error) {
        console.error("Error in unblockUser:", error);
        socket.emit("error", { message: "An error occurred while unblocking the user" });
      }
    });

    // Lắng nghe gợi ý bạn bè
    socket.on("suggestFriends", async (userId) => {
      try {
        const suggestions = await dynamoDB.getFriendSuggestions(userId);
        socket.emit("friendSuggestions", { suggestions });
      } catch (error) {
        console.error("Error in suggestFriends:", error);
        socket.emit("error", { message: "An error occurred while fetching friend suggestions" });
      }
    });

    // Ngắt kết nối
    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
    });
  });
};