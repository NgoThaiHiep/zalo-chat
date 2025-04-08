const { v4: uuidv4 } = require("uuid");
const {dynamoDB ,s3}= require("../config/aws.config");
const bucketName = process.env.BUCKET_NAME_GroupChat_Send ;
const TABLE_NAME = "GroupMessages";
const {sendMessageCore} = require('./messageCore');
const GROUP_TABLE = 'Groups';
const USER_DELETED_TABLE = 'UserDeletedMessages';


const createGroup = async (name, createdBy, members = []) => {
    try {
        // Kiểm tra xem người tạo đã tạo nhóm nào có tên giống tên nhóm đang muốn tạo hay chưa
        const existingGroups = await dynamoDB.scan({
            TableName: "Groups",
            FilterExpression: "createdBy = :createdBy AND #groupName = :name",
            ExpressionAttributeNames: {
                "#groupName": "name"
            },
            ExpressionAttributeValues: {
                ":createdBy": createdBy,
                ":name": name
            }
        }).promise();

        if (existingGroups.Items && existingGroups.Items.length > 0) {
            throw new Error("Bạn đã tạo nhóm với tên này trước đó. Vui lòng đặt tên khác.");
        }

        // Lấy danh sách memberIds và thêm createdBy nếu chưa có
        const memberIds = await getUserIds(members, createdBy);
        if (!memberIds.includes(createdBy)) {
            memberIds.unshift(createdBy);
        }

        if (memberIds.length < 3) {
            throw new Error("Nhóm phải có ít nhất 3 thành viên!");
        }

        // Gán quyền cho thành viên nhóm
        const roles = {};
        roles[createdBy] = "admin"; // Người tạo là admin
        memberIds.forEach((memberId) => {
            if (!roles[memberId]) {
                roles[memberId] = "member"; // Các thành viên khác là member
            }
        });

        // Tạo nhóm mới
        const groupId = uuidv4();
        const newGroup = {
            groupId,
            name,
            createdBy,
            members: memberIds,
            roles,
            createdAt: new Date().toISOString()
        };

        // Lưu vào bảng Groups
        await dynamoDB.put({
            TableName: "Groups",
            Item: newGroup
        }).promise();

        // Thêm từng thành viên vào bảng GroupMembers
        const groupMemberPromises = memberIds.map((memberId) => {
            return dynamoDB.put({
                TableName: "GroupMembers",
                Item: {
                    groupId: groupId,
                    userId: memberId,
                    role: roles[memberId], // Lưu vai trò (admin/member)
                    createdAt: new Date().toISOString()
                }
            }).promise();
        });

        // Thực thi tất cả các lệnh put cho bảng GroupMembers
        await Promise.all(groupMemberPromises);

        return newGroup;
    } catch (error) {
        console.error("Lỗi khi tạo nhóm:", error);
        throw new Error(error.message);
    }
};

/**
 *  Thêm thành viên vào nhóm
*/
const joinGroup = async (groupId, userId) => {
    // 🔹 Kiểm tra nhóm có tồn tại không
    const groupResult = await dynamoDB.get({
        TableName: "Groups",
        Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
        throw new Error("Nhóm không tồn tại!");
    }

    const group = groupResult.Item;

    // 🔹 Kiểm tra user có tồn tại không
    const userResult = await dynamoDB.get({
        TableName: "Users",
        Key: { userId }
    }).promise();

    if (!userResult.Item) {
        throw new Error("Người dùng không tồn tại!");
    }

    // 🔹 Kiểm tra người dùng đã tham gia nhóm chưa
    const membershipResult = await dynamoDB.get({
        TableName: "GroupMembers",
        Key: { groupId, userId }
    }).promise();

    if (membershipResult.Item) {
        throw new Error("Bạn đã tham gia nhóm!");
    }

    // 🔹 Kiểm tra số lượng thành viên
    if (group.members.length >= 100) {
        throw new Error("Nhóm đã đầy, không thể tham gia!");
    }

    // ✅ Cập nhật cả members và roles trong bảng Groups
    await dynamoDB.update({
        TableName: "Groups",
        Key: { groupId },
        UpdateExpression: "SET members = list_append(members, :newMember), #roles = :roles",
        ExpressionAttributeNames: {
            "#roles": "roles" // Thoát từ khóa dự trữ "roles"
        },
        ExpressionAttributeValues: {
            ":newMember": [userId],
            ":roles": {
                ...group.roles, // Giữ các roles hiện tại
                [userId]: "member" // Thêm userId mới với vai trò "member"
            }
        }
    }).promise();

    // ✅ Thêm thành viên vào bảng GroupMembers
    await dynamoDB.put({
        TableName: "GroupMembers",
        Item: {
            groupId,
            userId,
            role: "member",
            createdAt: new Date().toISOString()
        }
    }).promise();

    return { message: "Tham gia nhóm thành công!", groupId };
};

/**
 * 
 * Thành viên rời nhóm
 */

const leaveGroup = async (groupId, userId) => {
        if (!userId) {
            throw new Error("userId không hợp lệ!");
        }
    
        userId = String(userId).trim();
    
        const groupResult = await dynamoDB.get({
            TableName: "Groups",
            Key: { groupId }
        }).promise();
    
        if (!groupResult.Item) {
            throw new Error("Nhóm không tồn tại!");
        }
    
        const group = groupResult.Item;
    
        if (!group.members || !group.members.includes(userId)) {
            throw new Error("Bạn không phải là thành viên của nhóm này!");
        }
    
        const memberCount = group.members.length;
    
        if (memberCount === 1) {
            await dynamoDB.delete({
                TableName: "GroupMembers",
                Key: { groupId, userId }
            }).promise();
    
            await dynamoDB.delete({
                TableName: "Groups",
                Key: { groupId }
            }).promise();
    
            return { message: "Nhóm đã bị xóa vì không còn thành viên!", groupId };
        } else if (memberCount === 2) {
            const remainingMemberId = group.members.find(member => member !== userId);
    
            await dynamoDB.delete({
                TableName: "GroupMembers",
                Key: { groupId, userId }
            }).promise();
    
            const newMembers = group.members.filter(member => member !== userId);
            await dynamoDB.update({
                TableName: "Groups",
                Key: { groupId },
                UpdateExpression: "SET members = :newMembers, #roles.#remainingId = :adminRole REMOVE #roles.#userId",
                ExpressionAttributeNames: {
                    "#roles": "roles",
                    "#remainingId": remainingMemberId,
                    "#userId": userId
                },
                ExpressionAttributeValues: {
                    ":newMembers": newMembers,
                    ":adminRole": "admin"
                }
            }).promise();
    
            await dynamoDB.update({
                TableName: "GroupMembers",
                Key: { groupId, userId: remainingMemberId },
                UpdateExpression: "SET #role = :adminRole",
                ExpressionAttributeNames: {
                    "#role": "role"
                },
                ExpressionAttributeValues: {
                    ":adminRole": "admin"
                }
            }).promise();
    
            return { 
                message: "Rời nhóm thành công! Người còn lại được chỉ định làm admin.",
                groupId,
                newAdmin: remainingMemberId
            };
        } else {
            const isAdmin = group.roles[userId] === "admin";
            let newAdminId = null;
    
            if (isAdmin) {
                const memberRecords = await dynamoDB.query({
                    TableName: "GroupMembers",
                    KeyConditionExpression: "groupId = :groupId",
                    ExpressionAttributeValues: {
                        ":groupId": groupId
                    }
                }).promise();
    
                const otherMembers = memberRecords.Items
                    .filter(member => member.userId !== userId)
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    
                if (otherMembers.length > 0) {
                    newAdminId = otherMembers[0].userId;
                }
            }
    
            const newMembers = group.members.filter(member => member !== userId);
            let updateExpression = isAdmin && newAdminId
                ? "SET members = :newMembers, #roles.#newAdminId = :adminRole REMOVE #roles.#userId"
                : "SET members = :newMembers REMOVE #roles.#userId";
            let expressionAttributeNames = {
                "#roles": "roles",
                "#userId": userId
            };
            let expressionAttributeValues = {
                ":newMembers": newMembers
            };
    
            if (isAdmin && newAdminId) {
                expressionAttributeNames["#newAdminId"] = newAdminId;
                expressionAttributeValues[":adminRole"] = "admin";
            }
    
            await dynamoDB.update({
                TableName: "Groups",
                Key: { groupId },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues
            }).promise();
    
            if (isAdmin && newAdminId) {
                await dynamoDB.update({
                    TableName: "GroupMembers",
                    Key: { groupId, userId: newAdminId },
                    UpdateExpression: "SET #role = :adminRole",
                    ExpressionAttributeNames: {
                        "#role": "role"
                    },
                    ExpressionAttributeValues: {
                        ":adminRole": "admin"
                    }
                }).promise();
            }
    
            await dynamoDB.delete({
                TableName: "GroupMembers",
                Key: { groupId, userId }
            }).promise();
    
            return { 
                message: "Rời nhóm thành công!",
                groupId,
                newAdmin: isAdmin && newAdminId ? newAdminId : null
            };
        }
};
    
const deleteGroup = async (groupId, adminUserId) => {
    if (!adminUserId || !groupId) {
        throw new Error("adminUserId hoặc groupId không hợp lệ!");
    }

    adminUserId = String(adminUserId).trim();

    // Lấy thông tin nhóm
    const groupResult = await dynamoDB.get({
        TableName: "Groups",
        Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
        throw new Error("Nhóm không tồn tại!");
    }

    const group = groupResult.Item;

    console.log("group.members (raw):", group.members);
    console.log("adminUserId:", adminUserId);

    // Kiểm tra xem người dùng có phải là thành viên và là admin không
    if (!group.members || !group.members.includes(adminUserId)) {
        throw new Error("Bạn không phải là thành viên của nhóm này!");
    }

    if (!group.roles[adminUserId] || group.roles[adminUserId] !== "admin") {
        throw new Error("Bạn không có quyền xóa nhóm!");
    }

    // Lấy danh sách thành viên
    const members = group.members;

    // 1. Xóa tất cả thành viên thường (trừ admin)
    const nonAdminMembers = members.filter(member => member !== adminUserId);
    if (nonAdminMembers.length > 0) {
        const deleteRequests = nonAdminMembers.map(userId => ({
            DeleteRequest: {
                Key: {
                    groupId,
                    userId
                }
            }
        }));

        // Chia thành từng batch 25 mục (giới hạn của BatchWriteItem)
        const batches = [];
        for (let i = 0; i < deleteRequests.length; i += 25) {
            batches.push(deleteRequests.slice(i, i + 25));
        }

        for (const batch of batches) {
            await dynamoDB.batchWrite({
                RequestItems: {
                    "GroupMembers": batch
                }
            }).promise();
        }

        console.log("Đã xóa tất cả thành viên thường:", nonAdminMembers);
    }

    // 2. Xóa admin
    await dynamoDB.delete({
        TableName: "GroupMembers",
        Key: { groupId, userId: adminUserId }
    }).promise();

    console.log("Đã xóa admin:", adminUserId);

    // 3. Xóa nhóm
    await dynamoDB.delete({
        TableName: "Groups",
        Key: { groupId }
    }).promise();

    console.log("Đã xóa nhóm:", groupId);

    return {
        message: "Xóa nhóm thành công!",
        groupId
    };
};

/**
 * 
 * @param {*} groupId 
 * @param {*} adminUserId 
 * @param {*} targetUserId 
 * @returns 
 * 
 * kích thành viên ra khỏi nhóm do admin
 */
const kickMember = async (groupId, adminUserId, targetUserId) => {
    if (!adminUserId || !targetUserId) {
        throw new Error("adminUserId hoặc targetUserId không hợp lệ!");
    }

    adminUserId = String(adminUserId).trim();
    targetUserId = String(targetUserId).trim();

    if (adminUserId === targetUserId) {
        throw new Error("Bạn không thể tự (kick) chính mình! Hãy dùng chức năng rời nhóm.");
    }

    const groupResult = await dynamoDB.get({
        TableName: "Groups",
        Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
        throw new Error("Nhóm không tồn tại!");
    }

    const group = groupResult.Item;

    console.log("group.members (raw):", group.members);
    console.log("adminUserId:", adminUserId);
    console.log("targetUserId:", targetUserId);

    if (!group.members || !group.members.includes(adminUserId)) {
        throw new Error("Bạn không phải là thành viên của nhóm này!");
    }

    if (!group.roles[adminUserId] || group.roles[adminUserId] !== "admin") {
        throw new Error("Bạn không có quyền (kick) thành viên khác!");
    }

    if (!group.members.includes(targetUserId)) {
        throw new Error("Thành viên cần (kick) không có trong nhóm!");
    }

    console.log("Passed admin and membership check");

    const memberCount = group.members.length;

    if (memberCount === 1) {
        // Trường hợp này không xảy ra vì admin không thể kick chính mình
        throw new Error("Không thể (kick) khi nhóm chỉ có một thành viên!");
    } else if (memberCount === 2) {
        const remainingMemberId = group.members.find(member => member !== targetUserId); // Phải là adminUserId

        await dynamoDB.delete({
            TableName: "GroupMembers",
            Key: { groupId, userId: targetUserId }
        }).promise();

        const newMembers = group.members.filter(member => member !== targetUserId);
        await dynamoDB.update({
            TableName: "Groups",
            Key: { groupId },
            UpdateExpression: "SET members = :newMembers, #roles.#remainingId = :adminRole REMOVE #roles.#targetUserId",
            ExpressionAttributeNames: {
                "#roles": "roles",
                "#remainingId": remainingMemberId,
                "#targetUserId": targetUserId
            },
            ExpressionAttributeValues: {
                ":newMembers": newMembers,
                ":adminRole": "admin"
            }
        }).promise();

        await dynamoDB.update({
            TableName: "GroupMembers",
            Key: { groupId, userId: remainingMemberId },
            UpdateExpression: "SET #role = :adminRole",
            ExpressionAttributeNames: {
                "#role": "role"
            },
            ExpressionAttributeValues: {
                ":adminRole": "admin"
            }
        }).promise();

        return { 
            message: `Đã (kick) thành viên ${targetUserId} thành công! Người còn lại được chỉ định làm admin.`,
            groupId,
            newAdmin: remainingMemberId
        };
    } else {
        const isTargetAdmin = group.roles[targetUserId] === "admin";
        let newAdminId = null;

        if (isTargetAdmin) {
            const memberRecords = await dynamoDB.query({
                TableName: "GroupMembers",
                KeyConditionExpression: "groupId = :groupId",
                ExpressionAttributeValues: {
                    ":groupId": groupId
                }
            }).promise();

            const otherMembers = memberRecords.Items
                .filter(member => member.userId !== targetUserId)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

            if (otherMembers.length > 0) {
                newAdminId = otherMembers[0].userId;
            }
        }

        const newMembers = group.members.filter(member => member !== targetUserId);
        let updateExpression = "SET members = :newMembers REMOVE #roles.#targetUserId";
        let expressionAttributeNames = {
            "#roles": "roles",
            "#targetUserId": targetUserId
        };
        let expressionAttributeValues = {
            ":newMembers": newMembers
        };

        if (isTargetAdmin && newAdminId) {
            updateExpression += " SET #roles.#newAdminId = :adminRole";
            expressionAttributeNames["#newAdminId"] = newAdminId;
            expressionAttributeValues[":adminRole"] = "admin";
        }

        await dynamoDB.update({
            TableName: "Groups",
            Key: { groupId },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }).promise();

        if (isTargetAdmin && newAdminId) {
            await dynamoDB.update({
                TableName: "GroupMembers",
                Key: { groupId, userId: newAdminId },
                UpdateExpression: "SET #role = :adminRole",
                ExpressionAttributeNames: {
                    "#role": "role"
                },
                ExpressionAttributeValues: {
                    ":adminRole": "admin"
                }
            }).promise();
        }

        await dynamoDB.delete({
            TableName: "GroupMembers",
            Key: { groupId, userId: targetUserId }
        }).promise();

        return { 
            message: `Đã (kick) thành viên ${targetUserId} thành công!`,
            groupId,
            newAdmin: isTargetAdmin && newAdminId ? newAdminId : null
        };
    }
};

/*
*Lấy danh sách thành viên trong nhóm
*/
const getUserGroups = async (userId) => {
    try {
        if (!userId) {
            throw new Error("userId không hợp lệ");
        }

        const groupMemberResult = await dynamoDB.query({
            TableName: "GroupMembers",
            IndexName: "userId-index",
            KeyConditionExpression: "userId = :userId",
            ExpressionAttributeValues: {
                ":userId": userId
            }
        }).promise();

        if (!groupMemberResult.Items || groupMemberResult.Items.length === 0) {
            return [];
        }

        const groupIds = groupMemberResult.Items.map(item => item.groupId);

        const groupPromises = groupIds.map(async (groupId) => {
            const groupResult = await dynamoDB.get({
                TableName: "Groups",
                Key: { groupId }
            }).promise();
            return groupResult.Item;
        });

        const groups = await Promise.all(groupPromises);
        return groups.filter(group => group); // Lọc nhóm hợp lệ
    } catch (error) {
        console.error("❌ Lỗi khi lấy danh sách nhóm:", error);
        throw error; // Ném lỗi để controller xử lý
    }
};


/**
 * Gửi tin nhắn trong nhóm
 */
const sendGroupMessage = async (groupId, senderId, messageData) => {
    if (!groupId || !senderId || !messageData || !messageData.type) {
        throw new Error("groupId, senderId hoặc messageData không hợp lệ!");
    }

    groupId = String(groupId).trim();
    senderId = String(senderId).trim();
    const { type, content, file, fileName, mimeType, metadata, isAnonymous = false, isSecret = false, quality, replyToMessageId } = messageData;

    console.log("Service - type:", type);
    console.log("Service - content:", content);

    const groupResult = await dynamoDB.get({
        TableName: GROUP_TABLE,
        Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
        throw new Error("Nhóm không tồn tại!");
    }

    const group = groupResult.Item;
    if (!group.members || !group.members.includes(senderId)) {
        throw new Error("Bạn không phải thành viên nhóm!");
    }

    // Kiểm tra replyToMessageId bằng query với index
    if (replyToMessageId) {
        console.log("Checking replyToMessageId:", replyToMessageId);
        const result = await dynamoDB.query({
            TableName: TABLE_NAME,
            IndexName: "groupId-messageId-index",
            KeyConditionExpression: "groupId = :gId AND messageId = :mId",
            ExpressionAttributeValues: {
                ":gId": groupId,
                ":mId": replyToMessageId
            }
        }).promise();
        console.log("Query result:", result);
        if (!result.Items || result.Items.length === 0) {
            throw new Error("Tin nhắn trả lời không tồn tại!");
        }
    }

    const newMessage = {
        groupId,
        messageId: uuidv4(),
        senderId: isAnonymous ? null : senderId,
        type,
        content: content ? content.trim() : null,
        mediaUrl: null,
        fileName,
        mimeType,
        metadata: metadata || null,
        isAnonymous,
        isSecret,
        quality,
        replyToMessageId: replyToMessageId || null,
        file: file || null,
        timestamp: new Date().toISOString()
    };

    return await sendMessageCore(newMessage, TABLE_NAME, bucketName);
};
const forwardGroupMessage = async (groupId, senderId, { messageId, targetGroupId }) => {
    const originalMessage = await dynamoDB.get({
        TableName: TABLE_NAME,
        Key: { groupId, messageId }
    }).promise();

    if (!originalMessage.Item) {
        throw new Error("Tin nhắn gốc không tồn tại!");
    }

    const targetGroup = await dynamoDB.get({
        TableName: GROUP_TABLE,
        Key: { groupId: targetGroupId }
    }).promise();

    if (!targetGroup.Item || !targetGroup.Item.members.includes(senderId)) {
        throw new Error("Nhóm đích không tồn tại hoặc bạn không phải thành viên!");
    }

    const newMessage = {
        groupId: targetGroupId,
        messageId: uuidv4(),
        senderId,
        type: originalMessage.Item.type,
        content: originalMessage.Item.content,
        mediaUrl: originalMessage.Item.mediaUrl,
        fileName: originalMessage.Item.fileName,
        mimeType: originalMessage.Item.mimeType,
        metadata: { ...originalMessage.Item.metadata, forwardedFrom: { groupId, messageId } },
        isAnonymous: false,
        isSecret: false,
        quality: originalMessage.Item.quality,
        timestamp: new Date().toISOString()
    };

    return await sendMessageCore(newMessage, TABLE_NAME, bucketName);
};

const recallGroupMessage = async (groupId, senderId, messageId, recallType = 'everyone') => {
    console.log("Recalling:", { groupId, messageId, recallType });
    const result = await dynamoDB.query({
        TableName: TABLE_NAME,
        IndexName: "groupId-messageId-index",
        KeyConditionExpression: "groupId = :gId AND messageId = :mId",
        ExpressionAttributeValues: {
            ":gId": groupId,
            ":mId": messageId
        }
    }).promise();
    console.log("Query result:", result);

    if (!result.Items || result.Items.length === 0) {
        throw new Error("Tin nhắn không tồn tại!");
    }

    const message = result.Items[0];
    console.log("Message:", message);
    if (message.senderId !== senderId) {
        throw new Error("Bạn không có quyền thu hồi tin nhắn này!");
    }

    const messageTimestamp = new Date(message.timestamp).getTime();
    const currentTimestamp = new Date().getTime();
    const timeDiffHours = (currentTimestamp - messageTimestamp) / (1000 * 60 * 60);
    console.log("Time difference (hours):", timeDiffHours);
    if (timeDiffHours > 24) {
        throw new Error("Không thể thu hồi tin nhắn sau 24 giờ!");
    }

    if (recallType === 'everyone') {
        console.log("Recalling for everyone");
        await dynamoDB.update({
            TableName: TABLE_NAME,
            Key: { groupId, timestamp: message.timestamp },
            UpdateExpression: "set isRecalled = :r",
            ExpressionAttributeValues: { ":r": true },
            ReturnValues: "UPDATED_NEW"
        }).promise();
        return { success: true, message: "Tin nhắn đã được thu hồi với mọi người!" };
    } else if (recallType === 'self') {
        // console.log("Recalling for self");
        // const recallData = {
        //     userId: senderId,
        //     messageId,
        //     groupId,
        //     timestamp: new Date().toISOString()
        // };
        // await dynamoDB.put({
        //     TableName: USER_RECALLS_TABLE,
        //     Item: recallData
        // }).promise();
        // return { success: true, message: "Tin nhắn đã được thu hồi chỉ với bạn!" };
    } else {
        throw new Error("Loại thu hồi không hợp lệ! Chọn 'everyone' hoặc 'self'.");
    }
};
const pinGroupMessage = async (groupId, senderId, messageId) => {
    const group = await dynamoDB.get({
        TableName: GROUP_TABLE,
        Key: { groupId }
    }).promise();

    if (!group.Item || !group.Item.members.includes(senderId)) {
        throw new Error("Nhóm không tồn tại hoặc bạn không có quyền!");
    }

    const pinnedMessages = group.Item.pinnedMessages || [];
    if (!pinnedMessages.includes(messageId)) {
        pinnedMessages.push(messageId);
        await dynamoDB.update({
            TableName: GROUP_TABLE,
            Key: { groupId },
            UpdateExpression: "set pinnedMessages = :p",
            ExpressionAttributeValues: { ":p": pinnedMessages },
            ReturnValues: "UPDATED_NEW"
        }).promise();
    }

    return { success: true, message: "Tin nhắn đã được ghim!" };
};

const setReminder = async (groupId, senderId, messageId, reminder) => {
    const message = await dynamoDB.get({
        TableName: TABLE_NAME,
        Key: { groupId, messageId }
    }).promise();

    if (!message.Item || message.Item.senderId !== senderId) {
        throw new Error("Tin nhắn không tồn tại hoặc bạn không có quyền!");
    }

    await dynamoDB.update({
        TableName: TABLE_NAME,
        Key: { groupId, messageId },
        UpdateExpression: "set reminder = :r",
        ExpressionAttributeValues: { ":r": reminder },
        ReturnValues: "UPDATED_NEW"
    }).promise();

    return { success: true, message: "Đã đặt nhắc hẹn!" };
};

const deleteGroupMessage = async (groupId, senderId, messageId, deleteType = 'everyone') => {
    // Truy vấn tin nhắn từ index
    const result = await dynamoDB.query({
        TableName: TABLE_NAME,
        IndexName: "groupId-messageId-index",
        KeyConditionExpression: "groupId = :gId AND messageId = :mId",
        ExpressionAttributeValues: {
            ":gId": groupId,
            ":mId": messageId
        }
    }).promise();

    if (!result.Items || result.Items.length === 0) {
        throw new Error("Tin nhắn không tồn tại!");
    }

    const message = result.Items[0];
    if (message.senderId !== senderId) {
        throw new Error("Bạn không có quyền xóa tin nhắn này!");
    }

    if (deleteType === 'everyone') {
        // Xóa hoàn toàn khỏi GroupMessages
        await dynamoDB.delete({
            TableName: TABLE_NAME,
            Key: { groupId, timestamp: message.timestamp }
        }).promise();

        if (message.mediaUrl) {
            const key = message.mediaUrl.split('/').slice(3).join('/');
            await s3.deleteObject({
                Bucket: bucketName,
                Key: key
            }).promise();
        }

        return { success: true, message: "Tin nhắn đã được xóa hoàn toàn!" };
    } else if (deleteType === 'self') {
        // Xóa chỉ cho riêng bạn
        const deleteData = {
            userId: senderId,
            messageId,
            groupId,
            timestamp: new Date().toISOString()
        };

        await dynamoDB.put({
            TableName: USER_DELETED_TABLE,
            Item: deleteData
        }).promise();
        return { success: true, message: "Tin nhắn đã được xóa chỉ với bạn!" };
    } else {
        throw new Error("Loại xóa không hợp lệ! Chọn 'everyone' hoặc 'self'.");
    }
};
const restoreGroupMessage = async (groupId, senderId, messageId) => {
    // Kiểm tra tin nhắn gốc còn tồn tại không
    const result = await dynamoDB.query({
        TableName: TABLE_NAME,
        IndexName: "groupId-messageId-index",
        KeyConditionExpression: "groupId = :gId AND messageId = :mId",
        ExpressionAttributeValues: {
            ":gId": groupId,
            ":mId": messageId
        }
    }).promise();

    if (!result.Items || result.Items.length === 0) {
        throw new Error("Tin nhắn không tồn tại hoặc đã bị xóa hoàn toàn!");
    }

    const message = result.Items[0];
    if (message.senderId !== senderId) {
        throw new Error("Bạn không có quyền khôi phục tin nhắn này!");
    }

    // Xóa bản ghi trong UserDeletedMessages để khôi phục
    await dynamoDB.delete({
        TableName: USER_DELETED_TABLE,
        Key: { userId: senderId, messageId }
    }).promise();

    return { success: true, message: "Tin nhắn đã được khôi phục!" };
};
/**
 * 📌 Lấy danh sách tin nhắn của nhóm
 * @param {string} groupId - ID của nhóm
 * @param {string} userId - ID của người dùng
 * @param {number} [limit] - Số lượng tin nhắn tối đa trả về (tùy chọn)
 * @param {string} [lastEvaluatedKey] - Khóa cuối cùng từ lần truy vấn trước để phân trang (tùy chọn)
 * @returns {object} - Danh sách tin nhắn và thông tin phân trang
 */
const getGroupMessages = async (groupId, userId, limit = 50, lastEvaluatedKey = null) => {
    // Kiểm tra đầu vào
    if (!groupId || !userId) {
        throw new Error("groupId hoặc userId không hợp lệ!");
    }

    groupId = String(groupId).trim();
    userId = String(userId).trim();
    limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100); // Giới hạn từ 1-100

    // Kiểm tra nhóm có tồn tại và user có trong nhóm không
    const groupResult = await dynamoDB.get({
        TableName: "Groups",
        Key: { groupId }
    }).promise();

    if (!groupResult.Item) {
        throw new Error("Nhóm không tồn tại!");
    }

    const group = groupResult.Item;

    if (!group.members || !group.members.includes(userId)) {
        throw new Error("Bạn không phải thành viên nhóm!");
    }

    // Lấy tin nhắn từ bảng GroupMessages bằng GSI
    const params = {
        TableName: "GroupMessages",
        IndexName: "GroupMessagesIndex",
        KeyConditionExpression: "groupId = :groupId",
        ExpressionAttributeValues: { ":groupId": groupId },
        ScanIndexForward: true, // Sắp xếp theo thời gian tăng dần
        Limit: limit
    };

    if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey; // Hỗ trợ phân trang
    }

    const messages = await dynamoDB.query(params).promise();

    console.log("Danh sách tin nhắn:", messages.Items);

    return {
        messages: messages.Items || [], // Trả về mảng rỗng nếu không có tin nhắn
        lastEvaluatedKey: messages.LastEvaluatedKey || null // Dùng cho phân trang
    };
};

module.exports = {
    createGroup,
    joinGroup,
    leaveGroup,
    kickMember,
    deleteGroup,
    getUserGroups,
    sendGroupMessage,
    getGroupMessages,
    forwardGroupMessage,
    recallGroupMessage,
    pinGroupMessage,
    setReminder,
    deleteGroupMessage,
    restoreGroupMessage
};
