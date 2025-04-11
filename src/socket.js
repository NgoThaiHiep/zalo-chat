const { Server } = require('socket.io');
const Queue = require('bull');
const { redisClient, redisSubscriber } = require('./config/redis');
const { transcribe, s3 } = require('./config/aws.config');
const { dynamoDB } = require('./config/aws.config');

let ioInstance;
let transcribeQueue;

const initializeSocket = (server) => {
  ioInstance = new Server(server, {
    
    cors: {
      origin: 'http://localhost:3001',
      methods: ['GET', 'POST'],
    },
  });
  console.log('[SOCKET] ioInstance initialized');
  
  transcribeQueue = new Queue('transcribe-queue', {
    redis: { client: redisClient },
  });

  // Xử lý job trong queue
  transcribeQueue.process(async (job) => {
    const { messageId, senderId, receiverId, tableName, bucketName } = job.data;
    const status = await updateTranscribeStatus(messageId, tableName, senderId, receiverId, bucketName);

    if (status === 'IN_PROGRESS') {
      throw new Error('Job vẫn đang xử lý, thử lại sau'); // Bull sẽ retry tự động
    }

    // Nếu job hoàn thành hoặc thất bại, xóa khỏi queue
    await job.remove();
  });

  // Xử lý retry logic
  transcribeQueue.on('failed', (job, err) => {
    console.log(`Job ${job.id} failed with error: ${err.message}`);
  });

  transcribeQueue.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  return ioInstance;
};

const checkTranscribeStatus = async (jobName) => {
  try {
    const response = await transcribe
      .getTranscriptionJob({ TranscriptionJobName: jobName })
      .promise();
    return response.TranscriptionJob.TranscriptionJobStatus;
  } catch (error) {
    console.error(`Error checking transcribe job ${jobName}:`, error);
    throw error;
  }
};

const updateTranscribeStatus = async (messageId, tableName, senderId, receiverId, bucketName) => {
  const jobName = `voice-${messageId}`;
  const status = await checkTranscribeStatus(jobName);

  let transcriptText = null;

  if (status === 'COMPLETED') {
    // Lấy file JSON từ S3
    const transcriptKey = `${jobName}.json`;
    try {
      const transcriptData = await s3
        .getObject({
          Bucket: bucketName,
          Key: transcriptKey,
        })
        .promise();
      transcriptText = JSON.parse(transcriptData.Body.toString()).results.transcripts[0].transcript;
    } catch (s3Error) {
      console.error(`Error fetching transcript from S3 for ${transcriptKey}:`, s3Error);
      throw new Error('Failed to fetch transcript from S3');
    }
  }

  // Cập nhật DynamoDB
  const updateParams = {
    TableName: tableName,
    Key: { messageId },
    UpdateExpression: 'SET #metadata.transcribeStatus = :status' + (transcriptText ? ', #metadata.transcript = :transcript' : ''),
    ExpressionAttributeNames: { '#metadata': 'metadata' },
    ExpressionAttributeValues: {
      ':status': status,
      ...(transcriptText && { ':transcript': transcriptText }),
    },
    ReturnValues: 'ALL_NEW',
  };

  const updatedMessage = await dynamoDB.update(updateParams).promise();

  // Phát sự kiện socket
  if (status === 'COMPLETED') {
    const messageData = {
      messageId,
      transcript: transcriptText,
      transcribeStatus: 'COMPLETED',
    };
    ioInstance.to(senderId).emit('transcribeCompleted', messageData);
    ioInstance.to(receiverId).emit('transcribeCompleted', messageData);
  } else if (status === 'FAILED') {
    ioInstance.to(senderId).emit('transcribeFailed', { messageId, error: 'Transcription failed' });
    ioInstance.to(receiverId).emit('transcribeFailed', { messageId, error: 'Transcription failed' });
  }

  return status;
};

module.exports = {
  initializeSocket,
  io: () => ioInstance,
  transcribeQueue: () => transcribeQueue,
  updateTranscribeStatus,
};