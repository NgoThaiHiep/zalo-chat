const { transcribe, s3, dynamoDB } = require('../config/aws.config');
const logger = require('../config/logger');

const checkTranscribeStatus = async (jobName) => {
  try {
    const response = await transcribe.getTranscriptionJob({ TranscriptionJobName: jobName }).promise();
    return response.TranscriptionJob.TranscriptionJobStatus;
  } catch (error) {
    logger.error(`[TRANSCRIBE] Error checking job ${jobName}`, { error: error.message });
    throw error;
  }
};

const processTranscribeJob = async ({ messageId, senderId, receiverId, tableName, bucketName, io }) => {
  const jobName = `voice-${messageId}`;
  const status = await checkTranscribeStatus(jobName);
  let transcriptText = null;

  if (status === 'COMPLETED') {
    const transcriptKey = `${jobName}.json`;
    try {
      const transcriptData = await s3.getObject({ Bucket: bucketName, Key: transcriptKey }).promise();
      transcriptText = JSON.parse(transcriptData.Body.toString()).results.transcripts[0].transcript;
    } catch (s3Error) {
      logger.error(`[TRANSCRIBE] Error fetching transcript from S3 for ${transcriptKey}`, { error: s3Error.message });
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

  await dynamoDB.update(updateParams).promise();
  logger.info('[TRANSCRIBE] Updated message status in DynamoDB', { messageId, status });

  // Phát sự kiện socket
  if (status === 'COMPLETED') {
    const messageData = { messageId, transcript: transcriptText, transcribeStatus: 'COMPLETED' };
    io.to(senderId).emit('transcribeCompleted', messageData);
    io.to(receiverId).emit('transcribeCompleted', messageData);
  } else if (status === 'FAILED') {
    const errorData = { messageId, error: 'Transcription failed' };
    io.to(senderId).emit('transcribeFailed', errorData);
    io.to(receiverId).emit('transcribeFailed', errorData);
  }

  return status;
};

module.exports = { processTranscribeJob };