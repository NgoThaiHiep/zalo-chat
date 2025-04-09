const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const {dynamoDB, sns } = require("../config/aws.config");
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

// Hàm kiểm tra và tạo S3 bucket nếu chưa tồn tại
const createBucketIfNotExists = async (bucketName) => {
  try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
      console.log(`Bucket ${bucketName} already exists`);
  } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
          try {
              await s3Client.send(new CreateBucketCommand({
                  Bucket: bucketName,
                  CreateBucketConfiguration: {
                      LocationConstraint: process.env.AWS_REGION || "ap-southeast-1"
                  }
              }));
              console.log(`Bucket ${bucketName} created successfully`);
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

// Hàm khởi tạo tất cả các bảng
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
        { AttributeName: 'senderId', AttributeType: 'S' }, // GSI senderId-messageId-index & SenderReceiverIndex
        { AttributeName: 'receiverId', AttributeType: 'S' }, // GSI SenderReceiverIndex
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
        },
        {
          IndexName: 'SenderReceiverIndex',
          KeySchema: [
            { AttributeName: 'senderId', KeyType: 'HASH' },
            { AttributeName: 'receiverId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
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

    // Tạo S3 Buckets    
    await createBucketIfNotExists(process.env.BUCKET_NAME_Chat_Send);
    await createBucketIfNotExists(process.env.BUCKET_NAME_GroupChat_Send);
    await createBucketIfNotExists(process.env.BUCKET_AVATA_PROFILE);

    console.log('Database and S3 buckets initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
};

module.exports = { initializeDatabase, client };