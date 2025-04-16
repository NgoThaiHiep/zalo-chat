const { dynamoDB } = require('../config/aws.config');
const FriendService = require('./friend.service');
const MessageService = require('./message.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');
const { getUserByPhoneNumber } = require('./otp.services');

const MESSAGE_STATUSES = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  SEEN: 'seen',
  FAILED: 'failed',
  RECALLED: 'recalled',
  RESTRICTED: 'restricted',
};

// Tìm kiếm người dùng theo tên (khớp một phần) hoặc số điện thoại (chuẩn hóa)
const searchUsersByNameAndPhone = async (currentUserId, keyword) => {
  try {
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return {
        success: false,
        error: 'Từ khóa tìm kiếm không hợp lệ',
      };
    }

    const normalizedKeyword = keyword.toLowerCase().trim();
    const users = [];

    // Lấy danh sách bạn bè
    const friendsResult = await dynamoDB.query({
      TableName: 'Friends',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': currentUserId,
      },
    }).promise();
    const friendIds = friendsResult.Items?.map(item => item.friendId) || [];

    // Lấy danh sách người đã trò chuyện
    const conversationResult = await MessageService.getConversationSummary(currentUserId, { minimal: true });
    const conversationUserIds = conversationResult.success
      ? conversationResult.data.conversations.map(conv => conv.otherUserId)
      : [];

    const uniqueUserIds = [...new Set([...friendIds, ...conversationUserIds])];

    // Tìm theo số điện thoại
    if (normalizedKeyword.match(/^\+?\d+$|^0\d+$/)) {
      const user = await getUserByPhoneNumber(normalizedKeyword);
      if (user && uniqueUserIds.includes(user.userId)) {
        const isFriend = friendIds.includes(user.userId);
        const hasConversation = conversationUserIds.includes(user.userId);
        const nickname = await FriendService.getConversationNickname(currentUserId, user.userId);
        const displayName = nickname || user.name || user.userId;

        users.push({
          userId: user.userId,
          name: user.name || user.userId,
          phoneNumber: user.phoneNumber || null,
          displayName,
          isFriend,
          hasConversation,
        });
      }
    }

    // Tìm theo tên (nếu từ khóa không chỉ là số)
    if (!normalizedKeyword.match(/^\+?\d+$|^0\d+$/) || users.length === 0) {
      if (normalizedKeyword.length < 2) {
        return {
          success: false,
          error: 'Tên tìm kiếm phải có ít nhất 2 ký tự',
        };
      }

      for (const userId of uniqueUserIds) {
        try {
          const userResult = await dynamoDB.get({
            TableName: 'Users',
            Key: { userId },
          }).promise();

          if (!userResult.Item) continue;

          const userName = userResult.Item.name?.toLowerCase() || '';
          if (!userName.includes(normalizedKeyword)) continue;

          const isFriend = friendIds.includes(userId);
          const hasConversation = conversationUserIds.includes(userId);
          const nickname = await FriendService.getConversationNickname(currentUserId, userId);
          const displayName = nickname || userResult.Item.name || userId;

          users.push({
            userId,
            name: userResult.Item.name || userId,
            phoneNumber: userResult.Item.phoneNumber || null,
            displayName,
            isFriend,
            hasConversation,
          });
        } catch (error) {
          logger.error(`Lỗi khi lấy thông tin người dùng ${userId}:`, error);
          continue;
        }
      }
    }

    return {
      success: true,
      data: users,
    };
  } catch (error) {
    logger.error('Lỗi trong searchUsersByNameAndPhone:', error);
    return {
      success: false,
      error: error.message || 'Lỗi khi tìm kiếm người dùng',
    };
  }
};

// Tìm kiếm tin nhắn giữa hai người dùng
const searchMessagesBetweenUsers = async (userId, otherUserId, keyword) => {
  logger.info('Tìm kiếm tin nhắn:', { userId, otherUserId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  const normalizedKeyword = keyword.toLowerCase().trim();

  try {
    // Lấy danh sách tin nhắn đã xóa
    const deletedMessagesResult = await dynamoDB.query({
      TableName: 'UserDeletedMessages',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();
    const deletedMessageIds = new Set(
      deletedMessagesResult.Items?.map(item => item.messageId) || []
    );

    // Truy vấn tin nhắn gửi từ userId đến otherUserId
    const sentMessages = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :userId AND receiverId = :otherUserId',
      FilterExpression:
        'contains(#content, :keyword) AND #type = :text AND #status <> :recalled',
      ExpressionAttributeNames: {
        '#content': 'content',
        '#type': 'type',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':otherUserId': otherUserId,
        ':keyword': normalizedKeyword,
        ':text': 'text',
        ':recalled': MESSAGE_STATUSES.RECALLED,
      },
    }).promise();

    // Truy vấn tin nhắn nhận từ otherUserId
    const receivedMessages = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :otherUserId AND receiverId = :userId',
      FilterExpression:
      'contains(#content, :keyword) AND #type = :text AND #status <> :recalled AND #status <> :restricted',
      ExpressionAttributeNames: {
        '#content': 'content',
        '#type': 'type',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':otherUserId': otherUserId,
        ':keyword': normalizedKeyword,
        ':text': 'text',
        ':recalled': MESSAGE_STATUSES.RECALLED,
        ':restricted': MESSAGE_STATUSES.RESTRICTED,
      },
    }).promise();

    const messages = [
      ...(sentMessages.Items || []),
      ...(receivedMessages.Items || []),
    ].filter(msg => !deletedMessageIds.has(msg.messageId));

    const formattedMessages = messages.map(msg => ({
      messageId: msg.messageId,
      senderId: msg.senderId,
      receiverId: msg.receiverId,
      content: msg.content,
      timestamp: msg.timestamp,
      otherUserId,
    }));

    return {
      success: true,
      data: formattedMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    };
  } catch (error) {
    logger.error('Lỗi trong searchMessagesBetweenUsers:', error);
    throw new AppError('Lỗi khi tìm kiếm tin nhắn', 500);
  }
};

// Tìm kiếm toàn bộ (người dùng và tin nhắn)
const searchAll = async (currentUserId, keyword) => {
  logger.info('Tìm kiếm toàn bộ:', { currentUserId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  const normalizedKeyword = keyword.toLowerCase().trim();
  let results = { users: [], messages: [] };

  try {
    // Bước 1: Tìm kiếm người dùng theo tên hoặc số điện thoại
    const userSearchResult = await searchUsersByNameAndPhone(currentUserId, normalizedKeyword);
    if (userSearchResult.success) {
      results.users = userSearchResult.data;
    }

    // Bước 2: Nếu không tìm thấy người dùng, tìm kiếm tin nhắn
    if (results.users.length === 0) {
      const conversationResult = await MessageService.getConversationSummary(currentUserId, { minimal: true });
      const conversationUserIds = conversationResult.success
        ? conversationResult.data.conversations.map(conv => conv.otherUserId)
        : [];

      // Lấy danh sách tin nhắn đã xóa
      const deletedMessagesResult = await dynamoDB.query({
        TableName: 'UserDeletedMessages',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': currentUserId },
      }).promise();
      const deletedMessageIds = new Set(
        deletedMessagesResult.Items?.map(item => item.messageId) || []
      );

      // Tìm kiếm tin nhắn trong từng cuộc trò chuyện
      const messagePromises = conversationUserIds.map(async otherUserId => {
        const messageResult = await searchMessagesBetweenUsers(currentUserId, otherUserId, normalizedKeyword);
        return messageResult.success ? messageResult.data : [];
      });

      const messageResults = await Promise.all(messagePromises);
      results.messages = messageResults
        .flat()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    return {
      success: true,
      data: {
        users: results.users,
        messages: results.messages,
      },
    };
  } catch (error) {
    logger.error('Lỗi trong searchAll:', error);
    throw new AppError('Lỗi khi tìm kiếm', 500);
  }
};

module.exports = {
  searchAll,
  searchMessagesBetweenUsers,
  searchUsersByNameAndPhone,
};