const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const cryptoModule = require('../crypto');
const config = require('../config');
const storageManager = require('../storage/StorageManager');

const router = express.Router();

function persistEnvFile() {
  const lines = [
    `PORT=${process.env.PORT || config.PORT || 3000}`,
    `HOST=${process.env.HOST || config.HOST || '0.0.0.0'}`,
    `NODE_ENV=${process.env.NODE_ENV || 'production'}`,
    `JWT_SECRET=${config.JWT_SECRET}`,
    `ENCRYPTION_KEY=${config.ENCRYPTION_KEY}`,
    `DEFAULT_STORAGE_MODE=${process.env.DEFAULT_STORAGE_MODE || 'dual'}`,
    `UPLOAD_STRATEGY=${process.env.UPLOAD_STRATEGY || 'primary_first'}`,
    `PRIMARY_PROVIDER=${process.env.PRIMARY_PROVIDER || 'telegram'}`,
    `DISCORD_BOT_TOKEN=${process.env.DISCORD_BOT_TOKEN || ''}`,
    `DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID || ''}`,
    `DISCORD_GUILD_ID=${process.env.DISCORD_GUILD_ID || ''}`,
    `TELEGRAM_API_ID=${process.env.TELEGRAM_API_ID || ''}`,
    `TELEGRAM_API_HASH=${process.env.TELEGRAM_API_HASH || ''}`,
    `TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN || ''}`,
    `TELEGRAM_CHANNEL_ID=${process.env.TELEGRAM_CHANNEL_ID || ''}`,
    `SESSION_STRING=${process.env.SESSION_STRING || ''}`
  ];

  try {
    const dataDir = path.dirname(config.CONFIG_ENV_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(config.CONFIG_ENV_PATH, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(config.CONFIG_ENV_PATH, 0o600); } catch (_) {}
    console.log('[Setup] Persisted configuration to', config.CONFIG_ENV_PATH);
  } catch (err) {
    console.warn('[Setup] Warning: Could not write to config.env:', err.message);
  }
}

// Check setup status
router.get('/status', (req, res) => {
  try {
    const users = db.getAllUsers();
    const needsSetup = users.length === 0;
    res.json({
      success: true,
      needsSetup,
      isComplete: !needsSetup,
      userCount: users.length,
      hasDiscord: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID),
      hasTelegram: !!(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_BOT_TOKEN),
      defaultStorageMode: process.env.DEFAULT_STORAGE_MODE || config.DEFAULT_STORAGE_MODE || 'dual',
      port: process.env.PORT || config.PORT || 3000
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve setup status: ' + err.message });
  }
});

function requireSetupOrAdmin(req, res, next) {
  const users = db.getAllUsers();
  if (users.length === 0) {
    // 1st time setup in progress - allow unauthenticated wizard testing
    return next();
  }

  // Setup already complete - require admin authentication
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(403).json({ success: false, error: 'Setup has already been completed. Admin authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const user = db.getUserById(decoded.id || decoded.userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin privileges required' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, error: 'Invalid or expired authentication token' });
  }
}

// Test Discord connection during setup wizard
router.post('/test-discord', requireSetupOrAdmin, async (req, res) => {
  const { botToken, channelId, guildId } = req.body;
  const tokenToTest = botToken || process.env.DISCORD_BOT_TOKEN;
  const channelToTest = channelId || process.env.DISCORD_CHANNEL_ID;

  if (!tokenToTest || !channelToTest) {
    return res.status(400).json({ success: false, error: 'Discord Bot Token and Channel ID are required' });
  }

  try {
    const result = await storageManager.testConnection('discord', {
      botToken: tokenToTest.trim(),
      channelId: channelToTest.trim(),
      guildId: guildId ? guildId.trim() : ''
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test Telegram connection during setup wizard
router.post('/test-telegram', requireSetupOrAdmin, async (req, res) => {
  const { apiId, apiHash, botToken, channelId } = req.body;
  const idToTest = apiId || process.env.TELEGRAM_API_ID;
  const hashToTest = apiHash || process.env.TELEGRAM_API_HASH;
  const tokenToTest = botToken || process.env.TELEGRAM_BOT_TOKEN;
  const channelToTest = channelId || process.env.TELEGRAM_CHANNEL_ID;

  if (!idToTest || !hashToTest || !tokenToTest) {
    return res.status(400).json({ success: false, error: 'Telegram API ID, API Hash, and Bot Token are required' });
  }

  try {
    const result = await storageManager.testConnection('telegram', {
      apiId: String(idToTest).trim(),
      apiHash: String(hashToTest).trim(),
      botToken: String(tokenToTest).trim(),
      channelId: channelToTest ? String(channelToTest).trim() : ''
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run First-Time Setup Wizard
router.post('/init', async (req, res) => {
  if (global.__cloudDriveSetupInProgress) return res.status(409).json({ error: 'Setup is already in progress' });
  const users = db.getAllUsers();
  if (users.length > 0) {
    return res.status(400).json({ error: 'Setup has already been completed' });
  }

  global.__cloudDriveSetupInProgress = true;
  try {
  const {
    adminEmail,
    adminPassword,
    masterPassword,
    adminName,
    discordBotToken,
    discordChannelId,
    discordGuildId,
    telegramApiId,
    telegramApiHash,
    telegramBotToken,
    telegramChannelId,
    defaultStorageMode,
    uploadStrategy,
    primaryProvider
  } = req.body;

  const effectivePassword = adminPassword || masterPassword;
  const effectiveEmail = (adminEmail || 'admin@clouddrive.local').toLowerCase().trim();
  const effectiveName = (adminName || 'Admin').trim();

  if (!effectivePassword) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const complexity = cryptoModule.validatePasswordComplexity(effectivePassword);
  if (!complexity.valid) {
    return res.status(400).json({ error: complexity.error });
  }

  // Create initial admin user
  const passwordHash = await bcrypt.hash(effectivePassword, 10);
  const encryptionKey = cryptoModule.generateUserEncryptionKey();

  const admin = {
    id: uuidv4(),
    email: effectiveEmail,
    password_hash: passwordHash,
    name: effectiveName,
    role: 'admin',
    status: 'active',
    encryption_key: encryptionKey,
    storage_limit: 0,
    storage_used: 0,
    default_storage_mode: defaultStorageMode || 'dual'
  };

  db.createUser(admin);

  // Update in-memory environment variables
  if (discordBotToken) process.env.DISCORD_BOT_TOKEN = discordBotToken.trim();
  if (discordChannelId) process.env.DISCORD_CHANNEL_ID = discordChannelId.trim();
  if (discordGuildId) process.env.DISCORD_GUILD_ID = discordGuildId.trim();

  if (telegramApiId) process.env.TELEGRAM_API_ID = String(telegramApiId).trim();
  if (telegramApiHash) process.env.TELEGRAM_API_HASH = String(telegramApiHash).trim();
  if (telegramBotToken) process.env.TELEGRAM_BOT_TOKEN = String(telegramBotToken).trim();
  if (telegramChannelId) process.env.TELEGRAM_CHANNEL_ID = String(telegramChannelId).trim();

  const effectiveStorageMode = defaultStorageMode || 'dual';
  process.env.DEFAULT_STORAGE_MODE = effectiveStorageMode;
  db.setSetting('default_storage_mode', effectiveStorageMode);

  const effectiveUploadStrategy = uploadStrategy || 'primary_first';
  process.env.UPLOAD_STRATEGY = effectiveUploadStrategy;
  db.setSetting('upload_strategy', effectiveUploadStrategy);

  const effectivePrimary = primaryProvider || 'telegram';
  process.env.PRIMARY_PROVIDER = effectivePrimary;
  db.setSetting('primary_provider', effectivePrimary);

  // Persist into data/config.env
  persistEnvFile();

  // Initialize storage providers in background
  storageManager.initializeAll().catch(err => {
    console.warn('[Setup] Background storage initialization warning:', err.message);
  });

  // Generate JWT token for auto-login
  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role, tokenVersion: 1 },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    message: 'Setup completed successfully!',
    user: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      default_storage_mode: admin.default_storage_mode
    }
  });
  } finally {
    global.__cloudDriveSetupInProgress = false;
  }
});

module.exports = router;
