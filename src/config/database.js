const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTableCommand, UpdateTimeToLiveCommand, DescribeTimeToLiveCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketPolicyCommand, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

// Khởi tạo DynamoDB client
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Khởi tạo S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-southeast-1',
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

// Hàm kiểm tra và tạo S3 bucket nếu chưa tồn tại
const createBucketIfNotExists = async (bucketName, bucketPolicy) => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`Bucket ${bucketName} already exists`);
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
            LocationConstraint: process.env.AWS_REGION || 'ap-southeast-1',
          },
        }));
        console.log(`Bucket ${bucketName} created successfully`);
        await disableBlockPublicAccess(bucketName);
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
      Policy: JSON.stringify(policy),
    });
    await s3Client.send(policyCommand);
    console.log(`Bucket policy applied successfully to ${bucketName}`);
  } catch (error) {
    console.error(`Error applying bucket policy to ${bucketName}:`, error);
    throw error;
  }
};

// Hàm cập nhật GSI tự động
const updateTableWithNewGSI = async (tableName, desiredParams) => {
  try {
    const describeTable = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const currentGSIs = describeTable.Table.GlobalSecondaryIndexes || [];
    const desiredGSIs = desiredParams.GlobalSecondaryIndexes || [];

    const newGSIs = desiredGSIs.filter((desiredGSI) => {
      return !currentGSIs.some((currentGSI) => currentGSI.IndexName === desiredGSI.IndexName);
    });

    if (newGSIs.length === 0) {
      console.log(`No new GSIs to update for table ${tableName}`);
      return;
    }

    for (const newGSI of newGSIs) {
      console.log(`Adding new GSI ${newGSI.IndexName} to table ${tableName}`);
      await client.send(
        new UpdateTableCommand({
          TableName: tableName,
          AttributeDefinitions: desiredParams.AttributeDefinitions,
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName: newGSI.IndexName,
                KeySchema: newGSI.KeySchema,
                Projection: newGSI.Projection,
                ProvisionedThroughput: newGSI.ProvisionedThroughput || undefined,
              },
            },
          ],
        })
      );
      console.log(`Waiting for GSI ${newGSI.IndexName} to become ACTIVE...`);
      await waitForTable(tableName);
    }

    console.log(`Table ${tableName} updated successfully with new GSIs`);
  } catch (error) {
    console.error(`Error updating table ${tableName}:`, error);
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
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

// Hàm kích hoạt TTL cho bảng
const enableTTL = async (tableName, ttlAttributeName) => {
  try {
    const ttlStatus = await client.send(new DescribeTimeToLiveCommand({
      TableName: tableName,
    }));

    if (ttlStatus.TimeToLiveDescription?.TimeToLiveStatus === 'ENABLED') {
      console.log(`TTL already enabled for table ${tableName} with attribute ${ttlStatus.TimeToLiveDescription.AttributeName}`);
      return;
    }

    await client.send(new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: ttlAttributeName,
      },
    }));
    console.log(`TTL enabled for table ${tableName} with attribute ${ttlAttributeName}`);
  } catch (error) {
    if (error.name === 'ValidationException' && error.message.includes('TimeToLive is already enabled')) {
      console.log(`TTL already enabled for ${tableName}`);
    } else {
      console.error(`Error enabling TTL for ${tableName}:`, error);
      throw error;
    }
  }
};

// Hàm bật DynamoDB Streams
const enableDynamoDBStreams = async (tableName) => {
  try {
    const describeTable = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (describeTable.Table.StreamSpecification?.StreamEnabled) {
      console.log(`DynamoDB Streams already enabled for table ${tableName}`);
      return describeTable.Table.LatestStreamArn;
    }

    await client.send(new UpdateTableCommand({
      TableName: tableName,
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: 'OLD_IMAGE',
      },
    }));

    console.log(`Enabling DynamoDB Streams for table ${tableName}...`);
    await waitForTable(tableName);

    const updatedTable = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const streamArn = updatedTable.Table.LatestStreamArn;
    console.log(`DynamoDB Streams enabled for table ${tableName} with ARN: ${streamArn}`);
    return streamArn;
  } catch (error) {
    console.error(`Error enabling DynamoDB Streams for ${tableName}:`, error);
    throw error;
  }
};

// Hàm khởi tạo tất cả các bảng và bucket
const initializeDatabase = async () => {
  try {
    // 1. Tạo bảng Users
    const usersTableParams = {
      TableName: 'Users',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'phoneNumber', AttributeType: 'S' },
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
        { AttributeName: 'messageId', AttributeType: 'S' },
        { AttributeName: 'groupId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' },
        { AttributeName: 'senderId', AttributeType: 'S' },
        { AttributeName: 'receiverId', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'ownerId', AttributeType: 'S' },
        { AttributeName: 'reminder', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'messageId', KeyType: 'HASH' },
        { AttributeName: 'ownerId', KeyType: 'RANGE' },
      ],
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
        },
        {
          IndexName: 'SenderReceiverIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'receiverId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'ReceiverSenderIndex',
          KeySchema: [
            { AttributeName: 'receiverId', KeyType: 'HASH' },
            { AttributeName: 'senderId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'ReceiverStatusIndex',
          KeySchema: [
            { AttributeName: 'receiverId', KeyType: 'HASH' },
            { AttributeName: 'status', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'ReminderIndex',
          KeySchema: [
            { AttributeName: 'reminder', KeyType: 'HASH' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'OwnerReminderIndex',
          KeySchema: [
            { AttributeName: 'ownerId', KeyType: 'HASH' },
            { AttributeName: 'reminder', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'ALL', 
          },
        },      
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: 'OLD_IMAGE',
      },
    };
    await createTableIfNotExists('Messages', messagesTableParams);
    await updateTableWithNewGSI('Messages', messagesTableParams);

    // 3. Tạo bảng Groups
    const groupsTableParams = {
      TableName: 'Groups',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' },
        { AttributeName: 'createdBy', AttributeType: 'S' },
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
    await updateTableWithNewGSI('Groups', groupsTableParams);

    // 4. Tạo bảng UserDeletedMessages
    const userDeletedMessagesTableParams = {
      TableName: 'UserDeletedMessages',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'messageId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'messageId', KeyType: 'RANGE' },
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
    await createTableIfNotExists('UserDeletedMessages', userDeletedMessagesTableParams);
    await updateTableWithNewGSI('UserDeletedMessages', userDeletedMessagesTableParams);

    // 5. Tạo bảng GroupMembers
    const groupMembersTableParams = {
      TableName: 'GroupMembers',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' },
        { AttributeName: 'userId', AttributeType: 'S' },
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
    await updateTableWithNewGSI('GroupMembers', groupMembersTableParams);

    // 6. Tạo bảng GroupMessages
    const groupMessagesTableParams = {
      TableName: 'GroupMessages',
      AttributeDefinitions: [
        { AttributeName: 'groupId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' },
        { AttributeName: 'messageId', AttributeType: 'S' },
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
    await updateTableWithNewGSI('GroupMessages', groupMessagesTableParams);
    await enableTTL('GroupMessages', 'ttl');

    // 7. Tạo bảng FriendRequests
    const friendRequestsTableParams = {
      TableName: 'FriendRequests',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'requestId', AttributeType: 'S' },
        { AttributeName: 'senderId', AttributeType: 'S' },
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
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('FriendRequests', friendRequestsTableParams);
    await updateTableWithNewGSI('FriendRequests', friendRequestsTableParams);

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
    await updateTableWithNewGSI('Friends', friendsTableParams);

    // 9. Tạo bảng BlockedUsers
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
    await updateTableWithNewGSI('BlockedUsers', blockedUsersTableParams);

    // 10. Tạo bảng Conversations
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
    await updateTableWithNewGSI('Conversations', conversationsTableParams);

    // 11. Tạo bảng ReminderLogs
    const reminderLogsTableParams = {
      TableName: 'ReminderLogs',
      AttributeDefinitions: [
        { AttributeName: 'logId', AttributeType: 'S' },
        { AttributeName: 'senderId', AttributeType: 'S' },
        { AttributeName: 'receiverId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'logId', KeyType: 'HASH' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'ReminderIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'receiverId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'UserIdTimestampIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('ReminderLogs', reminderLogsTableParams);
    await updateTableWithNewGSI('ReminderLogs', reminderLogsTableParams);
    await enableTTL('ReminderLogs', 'ttl');
    //12. Tạo bảng nicknames
    const NicknamesTableParams = {
      TableName: 'Nicknames',
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
    await createTableIfNotExists('Nicknames', NicknamesTableParams);
    await updateTableWithNewGSI('Nicknames', NicknamesTableParams);
    //13.Tạo bảng Notifications
    const NotificationsTableParams = {
      TableName: 'Notifications',
      AttributeDefinitions: [
        { AttributeName: 'notificationId', AttributeType: 'S' },
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'notificationId', KeyType: 'HASH' },
        { AttributeName: 'userId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'UserTimestampIndex',
          KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' }, 
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    };
    await createTableIfNotExists('Notifications', NotificationsTableParams);
    await updateTableWithNewGSI('Notifications', NotificationsTableParams);
    // Bucket policy mẫu
    const defaultBucketPolicy = {
      Version: '2012-10-17',
      Id: 'Policy1740013275097',
      Statement: [
        {
          Sid: 'Stmt1740013273746',
          Effect: 'Allow',
          Principal: '*',
          Action: 's3:GetObject',
          Resource: [
            'arn:aws:s3:::BUCKET_NAME',
            'arn:aws:s3:::BUCKET_NAME/*',
          ],
        },
      ],
    };

    // Hàm tạo policy với bucket name cụ thể
    const getBucketPolicy = (bucketName) => {
      const policy = JSON.parse(JSON.stringify(defaultBucketPolicy));
      policy.Statement[0].Resource = [
        `arn:aws:s3:::${bucketName}`,
        `arn:aws:s3:::${bucketName}/*`,
      ];
      return policy;
    };

    // Tạo hoặc cập nhật S3 Buckets
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