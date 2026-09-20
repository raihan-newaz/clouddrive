const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load .env and config.env robustly
const envPath = path.join(dataDir, 'config.env');
const rootEnvPath = path.join(__dirname, '../.env');

if (fs.existsSync(rootEnvPath)) {
  require('dotenv').config({ path: rootEnvPath });
}
if (fs.existsSync(envPath)) {
  try {
    const parsed = require('dotenv').parse(fs.readFileSync(envPath));
    for (const k in parsed) {
      if (parsed[k] && parsed[k].trim() !== '') {
        process.env[k] = parsed[k].trim();
      }
    }
  } catch (e) {
    console.warn('[Config] Could not parse config.env:', e.message);
  }
}

function secureSecret(name) {
  const supplied = (process.env[name] || '').trim();
  if (supplied && supplied.length >= 32 && !/(change|replace|default|super[-_ ]?secret)/i.test(supplied)) return supplied;
  const generated = crypto.randomBytes(48).toString('base64url');
  process.env[name] = generated;
  console.warn(`[Config] ${name} was missing or insecure; generated a strong secret. Complete setup to persist it.`);
  return generated;
}

module.exports = {
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  JWT_SECRET: secureSecret('JWT_SECRET'),
  ENCRYPTION_KEY: secureSecret('ENCRYPTION_KEY'),
  
  // Storage Providers Defaults & Settings
  DEFAULT_STORAGE_MODE: process.env.DEFAULT_STORAGE_MODE || 'dual', // 'discord', 'telegram', 'dual'
  UPLOAD_STRATEGY: process.env.UPLOAD_STRATEGY || 'primary_first', // 'primary_first', 'simultaneous', 'auto'
  PRIMARY_PROVIDER: process.env.PRIMARY_PROVIDER || 'telegram', // 'discord', 'telegram'
  
  // Discord Provider Config
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '',
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || '',
  
  // Telegram Provider Config
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID || '',
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || '',
  TELEGRAM_SESSION_STRING: process.env.SESSION_STRING || process.env.TELEGRAM_SESSION_STRING || '',
  
  // Chunking and Performance
  CHUNK_SIZE_MB: parseFloat(process.env.CHUNK_SIZE_MB || '9.5'),
  DISCORD_CHUNK_SIZE_MB: parseFloat(process.env.DISCORD_CHUNK_SIZE_MB || process.env.CHUNK_SIZE_MB || '9.5'),
  TELEGRAM_CHUNK_SIZE_MB: parseFloat(process.env.TELEGRAM_CHUNK_SIZE_MB || '20'),
  MAX_CONCURRENT_UPLOADS: parseInt(process.env.MAX_CONCURRENT_UPLOADS || '3', 10),
  MAX_REPLICATION_WORKERS: parseInt(process.env.MAX_REPLICATION_WORKERS || '2', 10),
  
  // WebDAV
  WEBDAV_ENABLED: process.env.WEBDAV_ENABLED !== 'false',
  WEBDAV_PORT: process.env.WEBDAV_PORT || 3000,
  
  // Paths
  DATA_DIR: dataDir,
  CACHE_DIR: path.join(dataDir, 'cache'),
  THUMBNAILS_DIR: path.join(dataDir, 'thumbnails'),
  TMP_DIR: path.join(dataDir, 'tmp'),
  CONFIG_ENV_PATH: envPath
};
