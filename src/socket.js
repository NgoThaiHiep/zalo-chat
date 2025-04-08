const { Server } = require('socket.io');
const Queue = require('bull');
const redisClient = require('./config/redis');
const { transcribe } = require('./config/aws.config');
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

  transcribeQueue = new Queue('transcribe-queue', {
    redis: { host: '127.0.0.1', port: 6379 },
  });

  transcribeQueue.process(async (job) => {
    const { messageId, senderId, receiverId, tableName } = job.data;
    const status = await updateTranscribeStatus(messageId, tableName, senderId, receiverId);
    if (status === 'IN_PROGRESS') {
      throw new Error('Job vẫn đang xử lý, thử lại sau');
    }
  });

  return ioInstance;
};

const checkTranscribeStatus = async (jobName) => {
  const response = await transcribe.getTranscriptionJob({ TranscriptionJobName: jobName }).promise();
  return response.TranscriptionJob.TranscriptionJobStatus;
};

const updateTranscribeStatus = async (messageId, tableName, senderId, receiverId) => {
  const jobName = `voice-${messageId}`;
  const status = await checkTranscribeStatus(jobName);

  await dynamoDB
    .update({
      TableName: tableName,
      Key: { messageId },
      UpdateExpression: 'SET metadata.transcribeStatus = :status',
      ExpressionAttributeValues: { ':status': status },
    })
    .promise();

  if (status === 'COMPLETED') {
    ioInstance.to(senderId).emit('transcribeCompleted', { messageId });
    ioInstance.to(receiverId).emit('transcribeCompleted', { messageId });
  } else if (status === 'FAILED') {
    ioInstance.to(senderId).emit('transcribeFailed', { messageId });
    ioInstance.to(receiverId).emit('transcribeFailed', { messageId });
  }

  return status;
};

module.exports = { 
  initializeSocket, 
  io: () => ioInstance, 
  transcribeQueue: () => transcribeQueue, 
  updateTranscribeStatus 
};