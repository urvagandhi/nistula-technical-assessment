require('dotenv').config();

const config = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PORT: process.env.PORT || 3000,
  MODEL: 'claude-sonnet-4-20250514',
};

if (!config.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set in .env');
  process.exit(1);
}

module.exports = config;
