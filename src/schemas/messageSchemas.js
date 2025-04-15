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

const reminderSchema = Joi.object({
  messageId: Joi.string().required(),
  reminder: Joi.string().isoDate().required(),
  scope: Joi.string().valid('onlyMe', 'both').default('both'),
  reminderContent: Joi.string().allow('').optional(),
  repeat: Joi.string().valid('none', 'daily', 'weekly', 'multipleDaysWeekly', 'monthly', 'yearly').default('none'),
  daysOfWeek: Joi.array().items(Joi.number().integer().min(1).max(7)).when('repeat', {
    is: 'multipleDaysWeekly',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
});

module.exports = { messageSchema, reminderSchema };