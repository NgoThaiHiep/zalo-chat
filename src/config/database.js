const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
const { dynamoDB, sns } = require("../config/aws.config");
require('dotenv').config();

// Khởi tạo DynamoDB client
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-southeast-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Khởi tạo S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Hàm tắt Block Public Access
const disableBlockPublicAccess = async (bucketName) => {
  try {
    const publicAccessBlockParams = {
      Bucket: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        IgnorePublicAcls: false,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    };
    await s3Client.send(new PutPublicAccessBlockCommand(publicAccessBlockParams));
    console.log(`Block Public Access disabled for bucket ${bucketName}`);
  } catch (error) {
    console.error(`Error disabling Block Public Access for ${bucketName}:`, error);
    throw error;
  }
};

// Hàm kiểm tra và tạo S3 bucket nếu chưa tồn tại, sau đó thêm bucket policy và tắt Block Public Access
const createBucketIfNotExists = async (bucketName, bucketPolicy) => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`Bucket ${bucketName} already exists`);
    // Nếu bucket đã tồn tại, vẫn tắt Block Public Access và áp dụng policy
    await disableBlockPublicAccess(bucketName);
    if (bucketPolicy) {
      await applyBucketPolicy(bucketName, bucketPolicy);
    }
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      try {
        await s3Client.send(new CreateBucketCommand({
          Bucket: bucketName,
          CreateBucketConfiguration: {
            LocationConstraint: process.env.AWS_REGION || "ap-southeast-1",
          },
        }));
        console.log(`Bucket ${bucketName} created successfully`);

        // Tắt Block Public Access
        await disableBlockPublicAccess(bucketName);

        // Áp dụng bucket policy sau khi tạo bucket
        if (bucketPolicy) {
          await applyBucketPolicy(bucketName, bucketPolicy);
        }
      } catch (createError) {
        console.error(`Error creating bucket ${bucketName}:`, createError);
        throw createError;
      }
    } else {
      console.error(`Error checking bucket ${bucketName}:`, error);
      throw error;
    }
  }
};

// Hàm thêm bucket policy
const applyBucketPolicy = async (bucketName, policy) => {
  try {
    const policyCommand = new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy), // Chuyển policy thành chuỗi JSON
    });
    await s3Client.send(policyCommand);
    console.log(`Bucket policy applied successfully to ${bucketName}`);
  } catch (error) {
    console.error(`Error applying bucket policy to ${bucketName}:`, error);
    throw error;
  }
};

// Hàm kiểm tra và tạo bảng nếu chưa tồn tại
const createTableIfNotExists = async (tableName, params) => {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`Table ${tableName} already exists`);
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      try {
        await client.send(new CreateTableCommand(params));
        console.log(`Table ${tableName} created successfully`);
        await waitForTable(tableName);
      } catch (createError) {
        console.error(`Error creating table ${tableName}:`, createError);
        throw createError;
      }
    } else {
      console.error(`Error checking table ${tableName}:`, error);
      throw error;
    }
  }
};

// Hàm đợi bảng sẵn sàng
const waitForTable = async (tableName) => {
  let tableReady = false;
  while (!tableReady) {
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (Table.TableStatus === 'ACTIVE') {
      tableReady = true;
    } else {
      console.log(`Waiting for table ${tableName} to become active...`);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Đợi 2 giây
    }
  }
};

// Hàm khởi tạo tất cả các bảng và bucket
const initializeDatabase = async () => {
  try {
    // 1. Tạo bảng Users
    const usersTableParams = {
      TableName: 'Users',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' }, // Partition Key
        { AttributeName: 'phoneNumber', AttributeType: 'S' }, // GSI Partition Key
      ],
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'phoneNumber-index',
          KeySchema: [{ AttributeName: 'phoneNumber', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Users', usersTableParams);

    // 2. Tạo bảng Messages
    const messagesTableParams = {
      TableName: 'Messages',
      AttributeDefinitions: [
        { AttributeName: 'messageId', AttributeType: 'S' }, // Partition Key
        { AttributeName: 'groupId', AttributeType: 'S' }, // GSI GroupMessagesIndex
        { AttributeName: 'timestamp', AttributeType: 'S' }, // GSI GroupMessagesIndex Sort Key
        { AttributeName: 'senderId', AttributeType: 'S' }, // GSI senderId-messageId-index & SenderReceiverIndex & ReceiverStatusIndex
        { AttributeName: 'receiverId', AttributeType: 'S' }, // GSI SenderReceiverIndex
        { AttributeName: 'status', AttributeType: 'S'}, //GSI ReceiverStatusIndex
      ],
      KeySchema: [{ AttributeName: 'messageId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GroupMessagesIndex',
          KeySchema: [
            { AttributeName: 'groupId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'SenderIdMessageIdIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'messageId', KeyType: 'RANGE' },
            
          ],
          Projection: { ProjectionType: 'ALL' },
          BillingMode: 'PAY_PER_REQUEST',
        },
        {
          IndexName: 'SenderReceiverIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'receiverId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          BillingMode: 'PAY_PER_REQUEST',
        },
        {
          IndexName: 'ReceiverSenderIndex',
          KeySchema: [
            { AttributeName: 'receiverId', KeyType: 'HASH' },
            { AttributeName: 'senderId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          BillingMode: 'PAY_PER_REQUEST',
        },
        {
          IndexName: 'ReceiverStatusIndex',
          KeySchema: [
            { AttributeName: 'receiverId', KeyType: 'HASH' },  // Partition Key
            { AttributeName: 'status', KeyType: 'RANGE' },     // Sort Key
          ],
          Projection: { ProjectionType: 'ALL' },
          BillingMode: 'PAY_PER_REQUEST',
        },
        
      ],
      
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Messages', messagesTableParams);

    // 3. Tạo bảng Groups
    const groupsTableParams = {
      TableName: 'Groups',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' }, // Partition Key & GSI GroupIndex
        { AttributeName: 'createdBy', AttributeType: 'S' }, // GSI CreatedByIndex
      ],
      KeySchema: [{ AttributeName: 'groupId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GroupIndex',
          KeySchema: [{ AttributeName: 'groupId', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'CreatedByIndex',
          KeySchema: [
            { AttributeName: 'createdBy', KeyType: 'HASH' },
            { AttributeName: 'groupId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Groups', groupsTableParams);

    // 4. Tạo bảng UserDeletedMessages
    const userDeletedMessagesTableParams = {
      TableName: 'UserDeletedMessages',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' }, // Partition Key
        { AttributeName: 'messageId', AttributeType: 'S' }, // Sort Key
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'messageId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('UserDeletedMessages', userDeletedMessagesTableParams);

    // 5. Tạo bảng GroupMembers
    const groupMembersTableParams = {
      TableName: 'GroupMembers',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' }, // Partition Key
        { AttributeName: 'userId', AttributeType: 'S' }, // Sort Key & GSI userId-index
      ],
      KeySchema: [
        { AttributeName: 'groupId', KeyType: 'HASH' },
        { AttributeName: 'userId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'UserIdIndex',
          KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('GroupMembers', groupMembersTableParams);

    // 6. Tạo bảng GroupMessages
    const groupMessagesTableParams = {
      TableName: 'GroupMessages',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' }, // Partition Key & GSI
        { AttributeName: 'timestamp', AttributeType: 'S' }, // Sort Key & GSI GroupMessagesIndex
        { AttributeName: 'messageId', AttributeType: 'S' }, // GSI groupId-messageId-index
      ],
      KeySchema: [
        { AttributeName: 'groupId', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GroupIdMessageIdIndex',
          KeySchema: [
            { AttributeName: 'groupId', KeyType: 'HASH' },
            { AttributeName: 'messageId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GroupMessagesIndex',
          KeySchema: [
            { AttributeName: 'groupId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('GroupMessages', groupMessagesTableParams);
    //7. tạo bảng FriendRequests
    const friendRequestsTableParams = {
      TableName: 'FriendRequests',
        AttributeDefinitions: [
          { AttributeName: 'userId', AttributeType: 'S' },
          { AttributeName: 'requestId', AttributeType: 'S' },
          { AttributeName: 'senderId', AttributeType: 'S' }, // Thêm cho GSI
        ],
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'requestId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'SenderIdIndex',
            KeySchema: [{ AttributeName: 'senderId', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
            BillingMode: 'PAY_PER_REQUEST',
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      };
    await createTableIfNotExists('FriendRequests',friendRequestsTableParams);

    // 8. Tạo bảng Friends
    const friendsTableParams = {
      TableName: 'Friends',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'friendId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'friendId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Friends', friendsTableParams);
    //9. tạo bảng BlockedUsers
    const blockedUsersTableParams = {
      TableName: 'BlockedUsers',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'blockedUserId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'blockedUserId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('BlockedUsers', blockedUsersTableParams);

    //10.Tạo bảng Conversations
    const conversationsTableParams = {
      TableName: 'Conversations',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'targetUserId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'targetUserId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Conversations', conversationsTableParams);
    
    // Bucket policy mẫu
    const defaultBucketPolicy = {
      Version: "2012-10-17",
      Id: "Policy1740013275097",
      Statement: [
        {
          Sid: "Stmt1740013273746",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: [
            "arn:aws:s3:::BUCKET_NAME", // Sẽ được thay thế động
            "arn:aws:s3:::BUCKET_NAME/*",
          ],
        },
      ],
    };

    // Hàm tạo policy với bucket name cụ thể
    const getBucketPolicy = (bucketName) => {
      const policy = JSON.parse(JSON.stringify(defaultBucketPolicy)); // Sao chép policy
      policy.Statement[0].Resource = [
        `arn:aws:s3:::${bucketName}`,
        `arn:aws:s3:::${bucketName}/*`,
      ];
      return policy;
    };

    // Tạo hoặc cập nhật S3 Buckets với bucket policy và tắt Block Public Access
    await createBucketIfNotExists(
      process.env.BUCKET_NAME_Chat_Send,
      getBucketPolicy(process.env.BUCKET_NAME_Chat_Send)
    );
    await createBucketIfNotExists(
      process.env.BUCKET_NAME_GroupChat_Send,
      getBucketPolicy(process.env.BUCKET_NAME_GroupChat_Send)
    );
    await createBucketIfNotExists(
      process.env.BUCKET_AVATA_PROFILE,
      getBucketPolicy(process.env.BUCKET_AVATA_PROFILE)
    );

    console.log('Database and S3 buckets initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

module.exports = { initializeDatabase, client };