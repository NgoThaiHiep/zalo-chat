const { dynamoDB } = require('../config/aws.config');
const conversation = require('./conversation.service');
const {redisClient} = require('../config/redis')
const MessageService = require('./message.service');
const { getOwnProfile} = require('./auth.service');
const {createConversation} = require('./conversation.service');
// Hàm kiểm tra chặn
const checkBlockStatus = async (senderId, receiverId) => {
  const [isSenderBlocked, isReceiverBlocked] = await Promise.all([
    dynamoDB.get({
      TableName: 'BlockedUsers',
      Key: { userId: receiverId, blockedUserId: senderId },
    }).promise(),
    dynamoDB.get({
      TableName: 'BlockedUsers',
      Key: { userId: senderId, blockedUserId: receiverId },
    }).promise(),
  ]);

  if (isSenderBlocked.Item) throw new AppError('Bạn đã bị người này chặn', 403);
  if (isReceiverBlocked.Item) throw new AppError('Bạn đã chặn người này', 403);
};


const sendFriendRequest = async (senderId, receiverId, message) => {
  if (senderId === receiverId) {
    throw new Error('Bạn không thể gửi yêu cầu kết bạn cho chính mình!');
  }

  if (!message || message.trim() === '') {
    throw new Error('Lời nhắn không được để trống!');
  }

  // 0. Kiểm tra trạng thái block
  await checkBlockStatus(senderId, receiverId);

  // 1. Kiểm tra xem đã là bạn bè chưa
  const friendCheckParams = {
    TableName: 'Friends',
    Key: { userId: senderId, friendId: receiverId },
  };
  const friendCheckResult = await dynamoDB.get(friendCheckParams).promise();
  if (friendCheckResult.Item) {
    throw new Error('Bạn đã là bạn bè với người này');
  }

  // 2. Kiểm tra xem đã có yêu cầu kết bạn nào từ senderId đến receiverId chưa
  const checkParams = {
    TableName: 'FriendRequests',
    KeyConditionExpression: 'userId = :receiverId',
    FilterExpression: 'senderId = :senderId',
    ExpressionAttributeValues: {
      ':receiverId': receiverId,
      ':senderId': senderId,
    },
  };
  const checkResult = await dynamoDB.query(checkParams).promise();
  if (checkResult.Items.length > 0) {
    const existingRequest = checkResult.Items[0];
    if (existingRequest.status === 'pending') {
      throw new Error('Yêu cầu kết bạn đang chờ xử lý');
    } else if (existingRequest.status === 'accepted') {
      throw new Error('Yêu cầu đã được chấp nhận trước đó');
    } else {
      throw new Error('Yêu cầu kết bạn đã tồn tại');
    }
  }

  // 3. Tạo yêu cầu mới
  const requestId = `${senderId}#${Date.now()}`;
  const params = {
    TableName: 'FriendRequests',
    Item: {
      userId: receiverId,
      requestId,
      senderId,
      status: 'pending',
      message: message.trim(),
      createdAt: new Date().toISOString(),
    },
  };
  await dynamoDB.put(params).promise();
  return { message: 'Đã gửi yêu cầu kết bạn', requestId };
};

    // Lấy danh sách yêu cầu kết bạn đã nhận (pending, gửi đến userId)
const getReceivedFriendRequests = async (userId) => {
  const params = {
    TableName: 'FriendRequests',
    KeyConditionExpression: 'userId = :userId',
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':status': 'pending',
    },
  };

  const result = await dynamoDB.query(params).promise();

  const requestsWithSenderInfo = await Promise.all(
    result.Items.map(async (request) => {
      const senderInfo = await getOwnProfile(request.senderId);
      return {
        ...request,
        senderInfo,
      };
    })
  );

  return requestsWithSenderInfo;
};

// Lấy danh sách yêu cầu kết bạn đã gửi (pending, từ userId gửi đi)

const getSentFriendRequests = async (userId) => {
  const params = {
    TableName: 'FriendRequests',
    IndexName: 'SenderIdIndex', // Đảm bảo đã tạo GSI với senderId là partition key
    KeyConditionExpression: 'senderId = :senderId',
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':senderId': userId,
      ':status': 'pending',
    },
  };

  const result = await dynamoDB.query(params).promise();

  const requestsWithReceiverInfo = await Promise.all(
    result.Items.map(async (request) => {
      const receiverInfo = await getOwnProfile(request.userId); // userId là người nhận
      return {
        ...request,
        receiverInfo,
      };
    })
  );

  return requestsWithReceiverInfo;
};

    
const acceptFriendRequest = async (userId, requestId) =>  {
  try {
    // 1. Kiểm tra yêu cầu kết bạn
    const checkParams = {
      TableName: 'FriendRequests',
      Key: { userId, requestId },
    };

    const checkResult = await dynamoDB.get(checkParams).promise();

    if (!checkResult.Item) {
      logger.error('Friend request not found', { userId, requestId });
      throw new AppError('Không tìm thấy yêu cầu kết bạn', 404);
    }

    if (checkResult.Item.status !== 'pending') {
      logger.error('Friend request is not pending', { userId, requestId });
      throw new AppError('Yêu cầu kết bạn không phải đang chờ xử lý', 400);
    }

    // 2. Lấy senderId từ requestId (định dạng: senderId#timestamp)
    const senderId = requestId.split('#')[0];

    // 3. Thêm bạn bè 2 chiều
    const now = new Date().toISOString();
    const friendParams1 = {
      TableName: 'Friends',
      Item: { userId, friendId: senderId, addedAt: now },
    };
    const friendParams2 = {
      TableName: 'Friends',
      Item: { userId: senderId, friendId: userId, addedAt: now },
    };

    // 4. Xoá yêu cầu kết bạn
    const deleteParams = checkParams;

    await Promise.all([
      dynamoDB.put(friendParams1).promise(),
      dynamoDB.put(friendParams2).promise(),
      dynamoDB.delete(deleteParams).promise(),
    ]);

    // 5. Tạo hội thoại 2 chiều bằng cách tái sử dụng createConversation
    const result1 = await createConversation(userId, senderId);
    const result2 = await createConversation(senderId, userId);

    // 6. Trả kết quả
    return {
      success: true,
      message: 'Đã chấp nhận yêu cầu kết bạn và tạo hội thoại',
      conversationIds: {
        [userId]: result1.conversationId,
        [senderId]: result2.conversationId,
      },
    };
  } catch (error) {
    logger.error('Error in acceptFriendRequestAndCreateConversation', {
      userId,
      requestId,
      error: error.message,
    });
    throw new AppError(`Lỗi khi chấp nhận yêu cầu kết bạn và tạo hội thoại: ${error.message}`, error.statusCode || 500);
  }
}

    const rejectFriendRequest = async (userId, requestId) =>{
        const checkParams = {
            TableName: 'FriendRequests',
            Key: { userId, requestId },
          };
          const checkResult = await dynamoDB.get(checkParams).promise();
      
          if (!checkResult.Item) {
            throw new Error('Không tìm thấy yêu cầu kết bạn');
          }
          if (checkResult.Item.status !== 'pending') {
            throw new Error('Yêu cầu kết bạn không phải pending');
          }
      
          await dynamoDB.delete(checkParams).promise(); // Xóa bản ghi FriendRequests
          return { message: 'Từ chối kết bạn' };
        }

    const getFriends = async (userId) => {
      if (!userId || typeof userId !== 'string') {
        throw new AppError('userId không hợp lệ!', 400);
      }
    
      try {
        // Bước 1: Lấy danh sách bạn bè
        const friendResult = await dynamoDB.query({
          TableName: 'Friends',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
        }).promise();
    
        const friends = friendResult.Items || [];
        if (friends.length === 0) return [];
    
        // Bước 2: Truy vấn chi tiết từng người bạn
        const friendIds = friends.map(f => f.friendId);
    
        const keys = friendIds.map(friendId => ({
          userId: friendId,
        }));
    
        const userData = await dynamoDB.batchGet({
          RequestItems: {
            Users: {
              Keys: keys,
            },
          },
        }).promise();
    
        const userMap = {};
        for (const user of userData.Responses.Users) {
          const { password, ...safeUser } = user;
          userMap[user.userId] = safeUser;
        }
    
        // Bước 3: Ghép thông tin friend + user info
        return friends.map(friend => ({
          ...friend,
          user: userMap[friend.friendId] || null,
        }));
      } catch (error) {
        logger.error('Lỗi khi lấy thông tin bạn bè', { userId, error: error.message });
        throw new AppError('Không thể lấy thông tin bạn bè!', 500);
      }
    }

    const cancelFriendRequest = async (senderId, requestId) => {
    // Tìm receiverId từ requestId
    const checkParams = {
        TableName: 'FriendRequests',
        IndexName: 'SenderIdIndex', // Dùng GSI để tìm theo senderId
        KeyConditionExpression: 'senderId = :senderId',
        FilterExpression: 'requestId = :requestId',
        ExpressionAttributeValues: {
        ':senderId': senderId,
        ':requestId': requestId,
        },
    };
    const checkResult = await dynamoDB.query(checkParams).promise();

    if (!checkResult.Items.length) {
        throw new Error('Không tìm thấy yêu cầu kết bạn');
    }
    const { userId: receiverId } = checkResult.Items[0];

    const deleteParams = {
        TableName: 'FriendRequests',
        Key: { userId: receiverId, requestId },
        ConditionExpression: '#status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'pending' },
    };

    await dynamoDB.delete(deleteParams).promise();
    return { message: 'Hủy lời mời kết bạn' };
    }

    // Chặn người dùng
    const blockUser = async (userId, blockedUserId) => {
       // Kiểm tra xem có tự chặn chính mình không
        if (userId === blockedUserId) {
            throw new Error('Bạn không thể chặn chính mình!');
        }
        const params = {
        TableName: 'BlockedUsers',
        Item: {
            userId,
            blockedUserId,
            blockedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(blockedUserId)', // Ngăn chặn trùng lặp
        };

        try {
        await dynamoDB.put(params).promise();
        return { message: 'User blocked successfully' };
        } catch (error) {
        if (error.code === 'ConditionalCheckFailedException') {
            throw new Error('User is already blocked');
        }
        throw error;
        }
    }
    // Lấy danh sách người dùng đã chặn
    const  getBlockedUsers = async (userId) => {
        const params = {
        TableName: 'BlockedUsers',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
            ':userId': userId,
        },
        };

        const result = await dynamoDB.query(params).promise();
        return result.Items;
    }
    // Xóa chặn (bỏ chặn)
    const unblockUser = async (userId, blockedUserId) => {
        const params = {
        TableName: 'BlockedUsers',
        Key: {
            userId,
            blockedUserId,
        },
        };

        await dynamoDB.delete(params).promise();
        return { message: 'User unblocked successfully' };
    }

    //  Xóa kết bạn
    const removeFriend = async (userId, friendId) =>{
        const params1 = {
        TableName: 'Friends',
        Key: { userId, friendId },
        };
        const params2 = {
        TableName: 'Friends',
        Key: { userId: friendId, friendId: userId },
        };

        await Promise.all([
        dynamoDB.delete(params1).promise(),
        dynamoDB.delete(params2).promise(),
        ]);
        return { message: 'Friend removed successfully' };
    }
    //  Gợi ý kết bạn
    const  getFriendSuggestions = async(userId) =>{
            const friends = await getFriends(userId);
            const friendIds = friends.map(f => f.friendId);
            let suggestions = [];
        
            for (const friendId of friendIds) {
            const mutualFriends = await getFriends(friendId);
            suggestions = suggestions.concat(
                mutualFriends.filter(f => f.friendId !== userId && !friendIds.includes(f.friendId))
            );
            }
        
            return [...new Set(suggestions.map(f => f.friendId))].slice(0, 10); // Loại trùng, giới hạn 10
    }
    //Kiểm tra trạng thái bạn bè/người lạ
    const getUserStatus = async (currentUserId, targetUserId)=> {
    const friendCheck = await dynamoDB.get({ TableName: 'Friends', Key: { userId: currentUserId, friendId: targetUserId } }).promise();
    if (friendCheck.Item) return { status: 'friend' };

    const sentRequest = await dynamoDB.query({
        TableName: 'FriendRequests',
        IndexName: 'SenderIdIndex',
        KeyConditionExpression: 'senderId = :senderId',
        FilterExpression: 'userId = :targetUserId AND #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':senderId': currentUserId, ':targetUserId': targetUserId, ':status': 'pending' },
    }).promise();
    if (sentRequest.Items.length > 0) return { status: 'pending_sent' };

    const receivedRequest = await getReceivedFriendRequests(currentUserId);
    if (receivedRequest.some(req => req.senderId === targetUserId)) return { status: 'pending_received' };

    const blockedCheck = await dynamoDB.get({ TableName: 'BlockedUsers', Key: { userId: currentUserId, blockedUserId: targetUserId } }).promise();
    if (blockedCheck.Item) return { status: 'blocked' };

    return { status: 'stranger' };
    }

    // Hàm kiểm tra xem có phải bạn bè không
    const isFriendCheck = async (userId, targetUserId) => {
        const result = await dynamoDB.get({
            TableName: 'Friends',
            Key: { userId, friendId: targetUserId },
          }).promise();
          return !!result.Item;
    }
    const getUserName = async (currentUserId, targetUserId) => {
        console.log('Lấy tên người dùng:', { currentUserId, targetUserId });
      
        const user = await dynamoDB.get({
          TableName: 'Users',
          Key: { userId: targetUserId },
        }).promise();
      
        if (!user.Item) {
          throw new Error('Người dùng không tồn tại!');
        }
      
        const nickname = await getConversationNickname(currentUserId, targetUserId);
        const name = nickname || user.Item.name || targetUserId;
      
        // Ghi log nếu fallback về userId
        if (name === targetUserId) {
          console.warn(`Không tìm thấy nickname hoặc name cho userId: ${targetUserId}, fallback về userId`);
        }
      
        return {
          success: true,
          name,
          phoneNumber: user.Item.phoneNumber || null,
        };
      
    };

    // Lấy thông tin người dùng, ẩn trạng thái nếu cần
    const getUserProfile = async (currentUserId, targetUserId) =>{
    const user = await dynamoDB.get({
        TableName: 'Users',
        Key: { userId: targetUserId },
    }).promise();

    if (!user.Item) throw new Error('User not found');

    const profile = user.Item;
    const isFriend = await isFriendCheck(currentUserId, targetUserId);

    // Ẩn trạng thái online nếu không phải bạn bè và cài đặt là 'friends_only'
    if (profile.privacySettings?.showOnline === 'friends_only' && !isFriend) {
        delete profile.onlineStatus;
    }

    // Ẩn thông tin riêng tư nếu không phải bạn bè
    if (!isFriend) {
        delete profile.phoneNumber; // Ví dụ: ẩn số điện thoại
        delete profile.name;        // Ẩn tên nếu không phải bạn bè
    }

    delete profile.password; // Luôn ẩn mật khẩu
    return profile;
    }
    //Thêm vào yêu thích
    const markFavorite =async (userId, friendId) =>{
        
        await dynamoDB.update({
          TableName: 'Friends',
          Key: { userId, friendId },
          UpdateExpression: 'SET isFavorite = :value',
          ExpressionAttributeValues: { ':value': true },
          ConditionExpression: 'attribute_exists(friendId)', // Đảm bảo là bạn bè
        }).promise();
        return { message: 'Friend marked as favorite' };
      }
    // Xóa bạn ra khỏi yêu thích
    const unmarkFavorite = async (userId, friendId) => {
        await dynamoDB.update({
          TableName: 'Friends',
          Key: { userId, friendId },
          UpdateExpression: 'SET isFavorite = :value',
          ExpressionAttributeValues: { ':value': false },
        }).promise();
        return { message: 'Friend unmarked as favorite' };
      }
      //Danh sách bạn bè yêu thích (Favorites)
    const getFavoriteFriends = async (userId)=> {
        const params = {
          TableName: 'Friends',
          KeyConditionExpression: 'userId = :userId',
          FilterExpression: 'isFavorite = :value',
          ExpressionAttributeValues: { ':userId': userId, ':value': true },
        };
        const result = await dynamoDB.query(params).promise();
        return result.Items;
    }
    //Nhóm bạn chung
    const getMutualFriends =async (userId, targetUserId) => {
        const userFriends = (await getFriends(userId)).map(f => f.friendId);
        const targetFriends = (await getFriends(targetUserId)).map(f => f.friendId);
        const mutualFriends = userFriends.filter(f => targetFriends.includes(f));
        return mutualFriends;
    }

    // Hàm đặt tên gợi nhớ
const setConversationNickname = async (userId, targetUserId, nickname) => {
    await redisClient.set(`nickname:${userId}:${targetUserId}`, nickname);
    return { success: true, message: 'Đã đặt tên gợi nhớ!' };
  };
  
  // Hàm lấy tên gợi nhớ
  const getConversationNickname = async (userId, targetUserId) => {
    return await redisClient.get(`nickname:${userId}:${targetUserId}`);
  };




  
module.exports = {
    sendFriendRequest,
    acceptFriendRequest,
    getReceivedFriendRequests,
    getSentFriendRequests,
    getFriends,
    rejectFriendRequest,
    cancelFriendRequest,
    blockUser,
    getBlockedUsers,
    unblockUser,
    removeFriend,
    getFriendSuggestions,
    getUserStatus,
    getUserProfile,
    markFavorite,
    unmarkFavorite,
    getFavoriteFriends,
    getMutualFriends,
    getUserName,
    setConversationNickname,
    getConversationNickname,
    
  
}