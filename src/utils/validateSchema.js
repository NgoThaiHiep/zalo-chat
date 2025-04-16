const { AppError } = require('./errorHandler');

const validateSchema = (schema) => (data) => {
  const { error, value } = schema.validate(data, { abortEarly: false });
  if (error) {
    throw new AppError(`Validation error: ${error.details.map(d => d.message).join(', ')}`, 400);
  }
  return value;
};

module.exports = { validateSchema };