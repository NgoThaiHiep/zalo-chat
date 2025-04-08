const AWS = require('aws-sdk');
require('dotenv').config();

AWS.config.update({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
console.log('AWS_REGION'+process.env.AWS_REGION)
console.log('process.env.AWS_ACCESS_KEY_ID'+process.env.AWS_ACCESS_KEY_ID)
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const sns = new AWS.SNS();
const transcribe = new AWS.TranscribeService();

module.exports = { dynamoDB, s3, sns, transcribe };