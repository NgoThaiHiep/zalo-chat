const { dynamoDB } = require('../config/aws.config');
const FriendService = require('./friend.service');
const MessageService = require('./message.service');
const logger = require('../config/logger');
const { AppError } = require('../utils/errorHandler');
const { getUserByPhoneNumber } = require('./otp.services');
const conversation = require('./conversation.service');

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

// Helper function to get user relationships
const getUserRelationships = async (currentUserId) => {
  const friendsResult = await dynamoDB.query({
    TableName: 'Friends',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': currentUserId },
  }).promise();
  const friendIds = friendsResult.Items?.map(item => item.friendId) || [];

  const conversationResult = await conversation.getConversationSummary(currentUserId, { minimal: true });
  const conversationUserIds = conversationResult.success
    ? conversationResult.data.conversations.map(conv => conv.otherUserId)
    : [];

  return { friendIds, conversationUserIds, uniqueUserIds: [...new Set([...friendIds, ...conversationUserIds])] };
};

// 1. Search users by name (friends or past conversations only)
const searchUsersByName = async (currentUserId, keyword) => {
  try {
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
      return { success: false, error: 'Tên tìm kiếm phải có ít nhất 2 ký tự' };
    }

    const normalizedKeyword = keyword.toLowerCase().trim();
    const { friendIds, conversationUserIds, uniqueUserIds } = await getUserRelationships(currentUserId);
    const users = [];

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

    return { success: true, data: users };
  } catch (error) {
    logger.error('Lỗi trong searchUsersByName:', error);
    return { success: false, error: error.message || 'Lỗi khi tìm kiếm người dùng theo tên' };
  }
};

// 2. Search users by phone number (friends only)
const searchFriendsByPhoneNumber = async (currentUserId, phoneNumber) => {
  try {
    if (!phoneNumber || !phoneNumber.match(/^\+?\d+$|^0\d+$/)) {
      return { success: false, error: 'Số điện thoại không hợp lệ' };
    }

    const { friendIds } = await getUserRelationships(currentUserId);
    const user = await getUserByPhoneNumber(phoneNumber);
    const users = [];

    if (user && friendIds.includes(user.userId)) {
      const nickname = await FriendService.getConversationNickname(currentUserId, user.userId);
      const displayName = nickname || user.name || user.userId;

      users.push({
        userId: user.userId,
        name: user.name || user.userId,
        phoneNumber: user.phoneNumber || null,
        displayName,
        isFriend: true,
        hasConversation: false,
      });
    }

    return { success: true, data: users };
  } catch (error) {
    logger.error('Lỗi trong searchFriendsByPhoneNumber:', error);
    return { success: false, error: error.message || 'Lỗi khi tìm kiếm bạn bè theo số điện thoại' };
  }
};

// 3. Search users by phone number (all users in database)
const searchAllUsersByPhoneNumber = async (currentUserId, phoneNumber) => {
  try {
    if (!phoneNumber || !phoneNumber.match(/^\+?\d+$|^0\d+$/)) {
      return { success: false, error: 'Số điện thoại không hợp lệ' };
    }

    const { friendIds, conversationUserIds } = await getUserRelationships(currentUserId);
    const user = await getUserByPhoneNumber(phoneNumber);
    const users = [];

    if (user) {
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

    return { success: true, data: users };
  } catch (error) {
    logger.error('Lỗi trong searchAllUsersByPhoneNumber:', error);
    return { success: false, error: error.message || 'Lỗi khi tìm kiếm tất cả người dùng theo số điện thoại' };
  }
};

// 4. Search messages in 1-1 conversation
const searchMessagesBetweenUsers = async (userId, otherUserId, keyword) => {
  logger.info('Tìm kiếm tin nhắn 1-1:', { userId, otherUserId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  const normalizedKeyword = keyword.toLowerCase().trim();

  try {
    const deletedMessagesResult = await dynamoDB.query({
      TableName: 'UserDeletedMessages',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();
    const deletedMessageIds = new Set(deletedMessagesResult.Items?.map(item => item.messageId) || []);

    const sentMessages = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :userId AND receiverId = :otherUserId',
      FilterExpression: 'contains(#content, :keyword) AND #type = :text AND #status <> :recalled',
      ExpressionAttributeNames: { '#content': 'content', '#type': 'type', '#status': 'status' },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':otherUserId': otherUserId,
        ':keyword': normalizedKeyword,
        ':text': 'text',
        ':recalled': MESSAGE_STATUSES.RECALLED,
      },
    }).promise();

    const receivedMessages = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'SenderReceiverIndex',
      KeyConditionExpression: 'senderId = :otherUserId AND receiverId = :userId',
      FilterExpression: 'contains(#content, :keyword) AND #type = :text AND #status <> :recalled AND #status <> :restricted',
      ExpressionAttributeNames: { '#content': 'content', '#type': 'type', '#status': 'status' },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':otherUserId': otherUserId,
        ':keyword': normalizedKeyword,
        ':text': 'text',
        ':recalled': MESSAGE_STATUSES.RECALLED,
        ':restricted': MESSAGE_STATUSES.RESTRICTED,
      },
    }).promise();

    const messages = [...(sentMessages.Items || []), ...(receivedMessages.Items || [])]
      .filter(msg => !deletedMessageIds.has(msg.messageId));

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
    throw new AppError('Lỗi khi tìm kiếm tin nhắn 1-1', 500);
  }
};

// 5. Search messages in group conversation
const searchMessagesInGroup = async (userId, groupId, keyword) => {
  logger.info('Tìm kiếm tin nhắn nhóm:', { userId, groupId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  const normalizedKeyword = keyword.toLowerCase().trim();

  try {
    const deletedMessagesResult = await dynamoDB.query({
      TableName: 'UserDeletedMessages',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }).promise();
    const deletedMessageIds = new Set(deletedMessagesResult.Items?.map(item => item.messageId) || []);

    const messagesResult = await dynamoDB.query({
      TableName: 'Messages',
      IndexName: 'GroupIndex', // Assuming you have an index for group messages
      KeyConditionExpression: 'groupId = :groupId',
      FilterExpression: 'contains(#content, :keyword) AND #type = :text AND #status <> :recalled',
      ExpressionAttributeNames: { '#content': 'content', '#type': 'type', '#status': 'status' },
      ExpressionAttributeValues: {
        ':groupId': groupId,
        ':keyword': normalizedKeyword,
        ':text': 'text',
        ':recalled': MESSAGE_STATUSES.RECALLED,
      },
    }).promise();

    const messages = (messagesResult.Items || [])
      .filter(msg => !deletedMessageIds.has(msg.messageId));

    const formattedMessages = messages.map(msg => ({
      messageId: msg.messageId,
      senderId: msg.senderId,
      groupId,
      content: msg.content,
      timestamp: msg.timestamp,
    }));

    return {
      success: true,
      data: formattedMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    };
  } catch (error) {
    logger.error('Lỗi trong searchMessagesInGroup:', error);
    throw new AppError('Lỗi khi tìm kiếm tin nhắn nhóm', 500);
  }
};

// 6. Search all (users and messages)
const searchAll = async (currentUserId, keyword) => {
  logger.info('Tìm kiếm toàn bộ:', { currentUserId, keyword });

  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    throw new AppError('Từ khóa tìm kiếm không hợp lệ!', 400);
  }

  const normalizedKeyword = keyword.toLowerCase().trim();
  let results = { users: [], messages: [], groupMessages: [] };

  try {
    // Search users by name
    const userSearchResult = await searchUsersByName(currentUserId, normalizedKeyword);
    if (userSearchResult.success) {
      results.users = userSearchResult.data;
    }

    // Search users by phone (both friends and all users)
    if (normalizedKeyword.match(/^\+?\d+$|^0\d+$/)) {
      const friendPhoneSearch = await searchFriendsByPhoneNumber(currentUserId, normalizedKeyword);
      const allPhoneSearch = await searchAllUsersByPhoneNumber(currentUserId, normalizedKeyword);
      results.users = [...new Set([...results.users, ...friendPhoneSearch.data, ...allPhoneSearch.data])];
    }

    // If no users found, search messages
    if (results.users.length === 0) {
      const conversationResult = await conversation.getConversationSummary(currentUserId, { minimal: true });
      const conversationUserIds = conversationResult.success
        ? conversationResult.data.conversations.map(conv => conv.otherUserId)
        : [];

      // Search 1-1 messages
      const messagePromises = conversationUserIds.map(async otherUserId => {
        const messageResult = await searchMessagesBetweenUsers(currentUserId, otherUserId, normalizedKeyword);
        return messageResult.success ? messageResult.data : [];
      });

      // Search group messages (assuming you have a way to get group IDs)
      const groupIds = []; // You'll need to implement a way to get group IDs for the user
      const groupMessagePromises = groupIds.map(async groupId => {
        const groupMessageResult = await searchMessagesInGroup(currentUserId, groupId, normalizedKeyword);
        return groupMessageResult.success ? groupMessageResult.data : [];
      });

      const [messageResults, groupMessageResults] = await Promise.all([
        Promise.all(messagePromises),
        Promise.all(groupMessagePromises),
      ]);

      results.messages = messageResults.flat()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      results.groupMessages = groupMessageResults.flat()
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    return {
      success: true,
      data: {
        users: results.users,
        messages: results.messages,
        groupMessages: results.groupMessages,
      },
    };
  } catch (error) {
    logger.error('Lỗi trong searchAll:', error);
    throw new AppError('Lỗi khi tìm kiếm', 500);
  }
};

module.exports = {
  searchUsersByName,
  searchFriendsByPhoneNumber,
  searchAllUsersByPhoneNumber,
  searchMessagesBetweenUsers,
  searchMessagesInGroup,
  searchAll,
};
