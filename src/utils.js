const { v4: uuidv4 } = require('uuid');

function generateMessageId() {
  return uuidv4();
}

module.exports = { generateMessageId };
