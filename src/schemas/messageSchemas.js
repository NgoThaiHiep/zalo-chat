const Joi = require('joi');

const messageSchema = Joi.object({
  senderId: Joi.string().required(),
  receiverId: Joi.string().required(),
  type: Joi.string().required(),
  content: Joi.string().allow(null, ''),
  file: Joi.any().optional(),
  fileName: Joi.string().optional(),
  mimeType: Joi.string().optional(),
  metadata: Joi.object().optional(),
  isAnonymous: Joi.boolean().default(false),
  isSecret: Joi.boolean().default(false),
  quality: Joi.string().default('original'),
  expiresAfter: Joi.number().optional(),
  replyToMessageId: Joi.string().allow(null).optional(),
});


module.exports = { messageSchema };