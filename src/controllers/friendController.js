const { get } = require('../routes/authRoutes');
const FriendService = require('../services/friend.service');
const {getUserByPhoneNumber}=  require('../services/otp.services')

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


const sendFriendRequestController =  async (req, res) => {
  const { receiverId, message } = req.body;
        const senderId = req.user.id;
        try {
          const result = await FriendService.sendFriendRequest(senderId, receiverId,message);
          res.status(200).json(result);
        } catch (error) {
       
          res.status(500).json({  error: error.message });
        }
}
 
    // 1. Lấy danh sách yêu cầu kết bạn đã nhận
    const  getReceivedFriendRequestsController = async(req, res) => {
        const userId = req.user.id;
        try {
        const requests = await FriendService.getReceivedFriendRequests(userId);
        res.status(200).json(requests);
        } catch (error) {
        res.status(500).json({ message: 'Error fetching received friend requests', error: error.message });
        }
    }

    // Lấy danh sách yêu cầu kết bạn đã gửi
    const getSentFriendRequestsController = async (req, res) =>{
        const userId = req.user.id;
        try {
        const requests = await FriendService.getSentFriendRequests(userId);
        res.status(200).json(requests);
        } catch (error) {
        res.status(500).json({ message: 'Error fetching sent friend requests', error: error.message });
        }
    }

    const acceptFriendRequestController = async (req, res) => {
        const { requestId } = req.body;
        const userId = req.user.id;
    
        console.log("userId: " + userId);
        console.log("requestId: " + requestId);
    
        try {
          const result = await FriendService.acceptFriendRequest(userId, requestId);
          res.status(200).json(result);
        } catch (error) {
          if (error.message === 'Không tìm thấy yêu cầu kết bạn') {
            return res.status(404).json({ message: 'Không tìm thấy yêu cầu kết bạn' });
          }
          if (error.message === 'Yêu cầu kết bạn không phải padding') {
            return res.status(400).json({ message: 'Yêu cầu kết bạn không phải padding' });
          }
          res.status(500).json({ message: 'Lỗi khi chấp nhận yêu cầu', error: error.message });
        }
    }

    const rejectFriendRequestController = async (req, res) => {
        const { requestId } = req.body;
        const userId = req.user.id;
        try {
        const result = await FriendService.rejectFriendRequest(userId, requestId);
        res.status(200).json(result);
        } catch (error) {
        res.status(500).json({ message: 'Error rejecting request', error: error.message });
        }
    }

    const getFriendsController = async (req, res) => {
        const userId = req.user.id;
        try {
        const friends = await FriendService.getFriends(userId);
        res.status(200).json(friends);
        } catch (error) {
        res.status(500).json({ message: 'Error fetching friends', error: error.message });
        }
    }
    // hủy yêu cầu kết bạn
    const cancelFriendRequestController = async (req, res) => {
        const { requestId } = req.body;
        const senderId = req.user.id;
        try {
        const result = await FriendService.cancelFriendRequest(senderId, requestId);
        res.status(200).json(result);
        } catch (error) {
        res.status(500).json({ message: 'Error canceling friend request', error: error.message });
        }
    }

    //  Chặn người dùng
    const blockUserController = async (req, res) => {
        const { blockedUserId } = req.body;
        const userId = req.user.id;
        try {
        const result = await FriendService.blockUser(userId, blockedUserId);
        res.status(200).json(result);
        } catch (error) {
            if (error.message === 'Bạn không thể chặn chính mình!') {
                return res.status(400).json({ message: 'Bạn không thể chặn chính mình!' });
              }
              if (error.message === 'User is already blocked') {
                return res.status(400).json({ message: 'User is already blocked' });
              }
              res.status(500).json({ message: 'Error blocking user', error: error.message });
            }
    }

    // 3. Lấy danh sách người dùng đã chặn
    const getBlockedUsersController = async  (req, res) =>  {
        const userId = req.user.id;
        try {
        const blockedUsers = await FriendService.getBlockedUsers(userId);
        res.status(200).json(blockedUsers);
        } catch (error) {
        res.status(500).json({ message: 'Error fetching blocked users', error: error.message });
        }
    }

    // Xóa chặn
    const unblockUserController = async (req, res) =>{
        const { blockedUserId } = req.body;
        const userId = req.user.id;
        try {
        const result = await FriendService.unblockUser(userId, blockedUserId);
        res.status(200).json(result);
        } catch (error) {
        res.status(500).json({ message: 'Error unblocking user', error: error.message });
        }
    }

    //  Xóa kết bạn
    const  removeFriendController =  async(req, res) => {
        const { friendId } = req.body;
        const userId = req.user.id;
        try {
        const result = await FriendService.removeFriend(userId, friendId);
        res.status(200).json(result);
        } catch (error) {
        res.status(500).json({ message: 'Error removing friend', error: error.message });
        }
    }
   

    // Gợi ý kết bạn
    const getFriendSuggestionsController = async (req, res)=> {
        const userId = req.user.id;
        try {
        const suggestions = await FriendService.getFriendSuggestions(userId);
        res.status(200).json(suggestions);
        } catch (error) {
        res.status(500).json({ message: 'Error fetching friend suggestions', error: error.message });
        }
    }
    //Kiểm tra trạng thái bạn bè/người lạ
    const getUserStatusController =async (req,res) =>{
        const { targetUserId } = req.params;
        const currentUserId = req.user.id;
        try {
          const status = await FriendService.getUserStatus(currentUserId, targetUserId);
          res.status(200).json(status);
        } catch (error) {
          res.status(500).json({ message: 'Error checking user status', error: error.message });
        }
    }
    //Lấy thông tin bạn bè trạng thái
    const getUserProfileController =  async (req, res) =>{
        const { targetUserId } = req.params;
        const currentUserId = req.user.id;
        try {
            const profile = await FriendService.getUserProfile(currentUserId, targetUserId);
            res.status(200).json(profile);
        } catch (error) {
            res.status(500).json({ message: 'Error fetching user profile', error: error.message });
        }
    }
    //Thêm bạn vào yêu thích
    const  markFavoriteController =  async(req, res) =>{
        const { friendId } = req.body;
        const userId = req.user.id;
        try {
          const result = await FriendService.markFavorite(userId, friendId);
          res.status(200).json(result);
        } catch (error) {
          res.status(500).json({ message: 'Error marking favorite', error: error.message });
        }
    }
    //Xóa bạn ra khỏi yêu thích
    const  unmarkFavoriteController = async(req, res) => {
        const { friendId } = req.body;
        const userId = req.user.id;
        try {
          const result = await FriendService.unmarkFavorite(userId, friendId);
          res.status(200).json(result);
        } catch (error) {
          res.status(500).json({ message: 'Error unmarking favorite', error: error.message });
        }
    }
    //Danh sách yêu thích
    const getFavoriteFriendsController =  async (req, res) => {
        const userId = req.user.id;
        try {
          const favorites = await FriendService.getFavoriteFriends(userId);
          res.status(200).json(favorites);
        } catch (error) {
          res.status(500).json({ message: 'Error fetching favorites', error: error.message });
        }
    }
    //Nhóm bạn chung
    const getMutualFriends =  async (req, res) => {
        const { targetUserId } = req.params;
        const userId = req.user.id;
        try {
          const mutualFriends = await FriendService.getMutualFriends(userId, targetUserId);
          res.status(200).json(mutualFriends);
        } catch (error) {
          res.status(500).json({ message: 'Error fetching mutual friends', error: error.message });
        }
      }
    const getUserNameController = async (req, res) => {
        try {
          const currentUserId = req.user.id;
          const { targetUserId } = req.query;
      
          if (!targetUserId) {
            return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
          }
      
          const result = await FriendService.getUserName(currentUserId, targetUserId);
          res.status(200).json(result);
        } catch (error) {
          console.error('Lỗi trong getUserNameController:', error);
          res.status(403).json({ success: false, message: error.message || 'Lỗi khi lấy tên người dùng' });
        }
      };  

    const setConversationNicknameController = async (req, res) => {
        try {
          const userId = req.user.id;
          const { targetUserId, nickname } = req.body;
          if (!targetUserId || !nickname) {
            return res.status(400).json({ success: false, message: 'targetUserId và nickname là bắt buộc!' });
          }
          const result = await FriendService.setConversationNickname(userId, targetUserId, nickname);
          res.status(200).json(result);
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      };


      const getConversationNicknameController = async (req, res) => {
        try {
          const userId = req.user.id;
          const { targetUserId } = req.query; // Hoặc req.body, tùy thuộc vào thiết kế API
      
          if (!targetUserId) {
            return res.status(400).json({ success: false, message: 'targetUserId là bắt buộc!' });
          }
      
          const nickname = await FriendService.getConversationNickname(userId, targetUserId);
          res.status(200).json({
            success: true,
            message: nickname ? 'Lấy tên gợi nhớ thành công!' : 'Không có tên gợi nhớ được đặt!',
            data: { nickname: nickname || null },
          });
        } catch (error) {
          console.error('Lỗi trong getConversationNicknameController:', error);
          res.status(500).json({ success: false, message: error.message || 'Lỗi khi lấy tên gợi nhớ' });
        }
      };
    
module.exports = {
    acceptFriendRequestController,
    getReceivedFriendRequestsController,
    getSentFriendRequestsController,
    getFriendsController,
    rejectFriendRequestController,
    sendFriendRequestController,
    cancelFriendRequestController,
    blockUserController,
    getBlockedUsersController,
    unblockUserController,
    removeFriendController,
    
    getFriendSuggestionsController,
    getUserStatusController,

    getUserProfileController,
    getUserNameController,

    markFavoriteController,
    unmarkFavoriteController,
    getFavoriteFriendsController,
    getMutualFriends,

    setConversationNicknameController,
    getConversationNicknameController,
}