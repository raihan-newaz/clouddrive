const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cryptoModule = require('../crypto');
const db = require('../db');
const storageManager = require('../storage/StorageManager');
const cacheManager = require('../services/cacheManager');
const sessionTracker = require('../services/sessionTracker');
const backupService = require('../services/backup');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({ dest: config.TMP_DIR, limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
const PROVIDERS = new Set(['discord', 'telegram']);
const STORAGE_MODES = new Set(['discord', 'telegram', 'dual']);
const UPLOAD_STRATEGIES = new Set(['primary_first', 'simultaneous', 'parallel_both', 'auto']);
const clean = value => typeof value === 'string' ? value.trim() : '';
const isProviderEnabled = name => db.getSetting(`${name}_enabled`) !== 'false';
const isProviderConfigured = name => name === 'discord'
  ? Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID)
  : Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);

// Get App & Provider Settings
router.get('/', async (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const providersStatus = await storageManager.getProvidersStatus();

  const discordInfo = {
    configured: isProviderConfigured('discord'),
    enabled: isProviderEnabled('discord'),
    channelId: process.env.DISCORD_CHANNEL_ID || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    botToken: isAdmin ? (process.env.DISCORD_BOT_TOKEN || '') : (process.env.DISCORD_BOT_TOKEN ? '••••••••••••••••' : ''),
    connected: providersStatus.discord?.connected || false,
    botTag: providersStatus.discord?.botTag || null,
    botInfo: providersStatus.discord?.botInfo || null
  };

  const telegramInfo = {
    configured: isProviderConfigured('telegram'),
    enabled: isProviderEnabled('telegram'),
    apiId: isAdmin ? (process.env.TELEGRAM_API_ID || '') : (process.env.TELEGRAM_API_ID ? '••••••' : ''),
    apiHash: isAdmin ? (process.env.TELEGRAM_API_HASH || '') : (process.env.TELEGRAM_API_HASH ? '••••••••••••••••' : ''),
    botToken: isAdmin ? (process.env.TELEGRAM_BOT_TOKEN || '') : (process.env.TELEGRAM_BOT_TOKEN ? '••••••••••••••••' : ''),
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    connected: providersStatus.telegram?.connected || false
  };

  // Never send reusable provider secrets back to the browser.
  discordInfo.botToken = '';
  telegramInfo.apiHash = '';
  telegramInfo.botToken = '';
  const stats = db.getStorageStats(req.user ? req.user.id : null);

  res.json({
    success: true,
    stats,
    discord: discordInfo,
    telegram: telegramInfo,
    providers: {
      discord: discordInfo,
      telegram: telegramInfo
    },
    policy: {
      defaultStorageMode: db.getSetting('default_storage_mode', req.user ? req.user.id : null) || config.DEFAULT_STORAGE_MODE || 'dual',
      uploadStrategy: db.getSetting('upload_strategy', req.user ? req.user.id : null) || config.UPLOAD_STRATEGY || 'primary_first',
      primaryProvider: db.getSetting('primary_provider', req.user ? req.user.id : null) || config.PRIMARY_PROVIDER || 'telegram',
      encryptionEnabled: db.getSetting('encryption_enabled', req.user ? req.user.id : null) !== 'false'
    },
    cache: {
      totalBytes: cacheManager.getTotalCacheSize(),
      limitBytes: cacheManager.maxCacheBytes
    }
  });
});

// Live Cloud Storage Statistics
router.get('/storage-stats', (req, res) => {
  try {
    const stats = db.getStorageStats(req.user ? req.user.id : null);
    const detailed = req.user ? (db.getUserDetailedStorageStats(req.user.id) || {}) : {};
    res.json({
      success: true,
      stats: {
        ...detailed,
        ...stats,
        totalFiles: detailed.activeFileCount !== undefined ? detailed.activeFileCount : (stats.totalFiles || 0),
        totalBytes: detailed.activeFilesSize !== undefined ? detailed.activeFilesSize : (stats.totalBytes || 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch storage stats: ' + err.message });
  }
});

// Update Storage Policy Settings (Per-User)
router.post('/policy', (req, res) => {
  const { defaultStorageMode, uploadStrategy, primaryProvider, encryptionEnabled } = req.body;
  const userId = req.user ? req.user.id : null;

  if (defaultStorageMode && !STORAGE_MODES.has(defaultStorageMode)) return res.status(400).json({ error: 'Invalid storage mode' });
  if (uploadStrategy && !UPLOAD_STRATEGIES.has(uploadStrategy)) return res.status(400).json({ error: 'Invalid upload strategy' });
  if (primaryProvider && !PROVIDERS.has(primaryProvider)) return res.status(400).json({ error: 'Invalid primary provider' });
  const requested = defaultStorageMode === 'dual' ? ['discord', 'telegram'] : [defaultStorageMode || primaryProvider].filter(Boolean);
  if (requested.length && !requested.some(name => isProviderConfigured(name) && isProviderEnabled(name))) {
    return res.status(400).json({ error: 'The selected policy has no configured and enabled provider' });
  }

  if (defaultStorageMode) {
    db.setSetting('default_storage_mode', defaultStorageMode, userId);
    if (userId) {
      db.updateUser(userId, { default_storage_mode: defaultStorageMode });
    }
  }
  if (uploadStrategy) {
    db.setSetting('upload_strategy', uploadStrategy, userId);
  }
  if (primaryProvider) {
    db.setSetting('primary_provider', primaryProvider, userId);
  }
  if (encryptionEnabled !== undefined) {
    const isEnc = (encryptionEnabled === true || encryptionEnabled === 'true' || encryptionEnabled === 1 || encryptionEnabled === '1');
    db.setSetting('encryption_enabled', isEnc ? 'true' : 'false', userId);
  }

  res.json({
    success: true,
    message: 'Storage policy updated successfully',
    policy: {
      defaultStorageMode: db.getSetting('default_storage_mode', userId) || config.DEFAULT_STORAGE_MODE || 'dual',
      uploadStrategy: db.getSetting('upload_strategy', userId) || config.UPLOAD_STRATEGY || 'primary_first',
      primaryProvider: db.getSetting('primary_provider', userId) || config.PRIMARY_PROVIDER || 'telegram',
      encryptionEnabled: db.getSetting('encryption_enabled', userId) !== 'false'
    }
  });
});

// Real-Time Upload & Download Speed Benchmark for Telegram & Discord
router.post('/speedtest', adminOnly, async (req, res) => {
  const { provider, testSizeMb = 2 } = req.body;
  const targetProviders = (provider && provider !== 'all') ? [provider] : ['telegram', 'discord'];
  const testBytes = Math.min(10, Math.max(1, parseFloat(testSizeMb))) * 1024 * 1024;
  const dummyPayload = require('crypto').randomBytes(testBytes);
  const results = {};

  for (const prov of targetProviders) {
    try {
      const providerInst = storageManager.getProvider(prov);
      if (!providerInst.isInitialized) {
        await providerInst.initialize();
      }

      // 1. Upload Speed Test
      const testFileName = `speedtest_${Date.now()}_${prov}.tmp`;
      const upStart = Date.now();
      const uploadRes = await providerInst.uploadChunk(dummyPayload, testFileName);
      const upEnd = Date.now();
      const upDurationSec = (upEnd - upStart) / 1000;
      const upSpeedMBps = (testBytes / (1024 * 1024)) / (upDurationSec || 0.001);
      const upSpeedMbps = upSpeedMBps * 8;

      // 2. Download Speed Test
      const dlStart = Date.now();
      const downloadedBuf = await providerInst.downloadChunk(uploadRes.remoteId);
      const dlEnd = Date.now();
      const dlDurationSec = (dlEnd - dlStart) / 1000;
      const dlBytes = downloadedBuf ? downloadedBuf.length : testBytes;
      const dlSpeedMBps = (dlBytes / (1024 * 1024)) / (dlDurationSec || 0.001);
      const dlSpeedMbps = dlSpeedMBps * 8;

      // 3. Clean up test chunk
      providerInst.deleteChunk(uploadRes.remoteId).catch(() => {});

      results[prov] = {
        success: true,
        testSizeMB: (testBytes / (1024 * 1024)).toFixed(1),
        upload: {
          durationSec: parseFloat(upDurationSec.toFixed(2)),
          speedMBps: parseFloat(upSpeedMBps.toFixed(2)),
          speedMbps: parseFloat(upSpeedMbps.toFixed(2))
        },
        download: {
          durationSec: parseFloat(dlDurationSec.toFixed(2)),
          speedMBps: parseFloat(dlSpeedMBps.toFixed(2)),
          speedMbps: parseFloat(dlSpeedMbps.toFixed(2))
        }
      };
    } catch (err) {
      console.warn(`[Speedtest] Error testing provider ${prov}:`, err.message);
      results[prov] = {
        success: false,
        error: err.message
      };
    }
  }

  // Determine recommendation
  let recommendation = null;
  if (results.telegram?.success && results.discord?.success) {
    const tgScore = (results.telegram.upload.speedMBps + results.telegram.download.speedMBps) / 2;
    const dcScore = (results.discord.upload.speedMBps + results.discord.download.speedMBps) / 2;
    const diffPct = Math.abs(((tgScore - dcScore) / (dcScore || 1)) * 100).toFixed(1);

    if (tgScore >= dcScore) {
      recommendation = `Telegram is currently ~${diffPct}% faster on your ISP network. Recommended as Primary Provider.`;
    } else {
      recommendation = `Discord is currently ~${diffPct}% faster on your ISP network. Recommended as Primary Provider.`;
    }
  }

  res.json({
    success: true,
    results,
    telegram: results.telegram,
    discord: results.discord,
    recommendation,
    timestamp: new Date().toISOString()
  });
});

// Update Discord Credentials (Admin)
router.post('/discord', adminOnly, async (req, res) => {
  const { botToken, channelId, guildId } = req.body;
  const effectiveToken = clean(botToken) || process.env.DISCORD_BOT_TOKEN;
  const effectiveChannel = clean(channelId) || process.env.DISCORD_CHANNEL_ID;
  if (!effectiveToken || !effectiveChannel) {
    return res.status(400).json({ error: 'Bot Token and Channel ID are required' });
  }

  process.env.DISCORD_BOT_TOKEN = effectiveToken;
  process.env.DISCORD_CHANNEL_ID = effectiveChannel;
  if (guildId) process.env.DISCORD_GUILD_ID = guildId.trim();

  db.setSetting('discord_enabled', 'true');
  saveEnvFile();

  const provider = storageManager.getProvider('discord');
  const connected = await provider.initialize({
    botToken: process.env.DISCORD_BOT_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    forceConnect: true
  });

  res.json({
    success: true,
    connected,
    message: connected ? 'Discord connected successfully!' : 'Discord credentials saved, but connection failed.'
  });
});

// Test Discord Connection
router.post('/discord/test', adminOnly, async (req, res) => {
  const { botToken, channelId } = req.body;
  const result = await storageManager.testConnection('discord', {
    botToken: clean(botToken) || process.env.DISCORD_BOT_TOKEN,
    channelId: clean(channelId) || process.env.DISCORD_CHANNEL_ID
  });
  res.json(result);
});

// Disconnect Discord (Admin)
router.post('/discord/disconnect', adminOnly, async (req, res) => {
  db.setSetting('discord_enabled', 'false');
  const provider = storageManager.getProvider('discord');
  if (provider && provider.disconnect) {
    await provider.disconnect();
  }

  res.json({
    success: true,
    message: 'Discord storage provider disconnected. Saved credentials preserved.'
  });
});

// Update Telegram Credentials (Admin)
router.post('/telegram', adminOnly, async (req, res) => {
  const { apiId, apiHash, botToken, channelId } = req.body;
  const effective = {
    apiId: clean(apiId) || process.env.TELEGRAM_API_ID,
    apiHash: clean(apiHash) || process.env.TELEGRAM_API_HASH,
    botToken: clean(botToken) || process.env.TELEGRAM_BOT_TOKEN,
    channelId: clean(channelId) || process.env.TELEGRAM_CHANNEL_ID
  };
  if (!effective.apiId || !effective.apiHash || !effective.botToken || !effective.channelId) {
    return res.status(400).json({ error: 'API ID, API Hash, Bot Token, and Channel ID are required' });
  }

  process.env.TELEGRAM_API_ID = effective.apiId;
  process.env.TELEGRAM_API_HASH = effective.apiHash;
  process.env.TELEGRAM_BOT_TOKEN = effective.botToken;
  process.env.TELEGRAM_CHANNEL_ID = effective.channelId;

  db.setSetting('telegram_enabled', 'true');
  saveEnvFile();

  const provider = storageManager.getProvider('telegram');
  const connected = await provider.initialize({
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID,
    forceConnect: true
  });

  res.json({
    success: true,
    connected,
    message: connected ? 'Telegram connected successfully!' : 'Telegram credentials saved, but connection failed.'
  });
});

// Test Telegram Connection
router.post('/telegram/test', adminOnly, async (req, res) => {
  const { apiId, apiHash, botToken, channelId } = req.body;
  const result = await storageManager.testConnection('telegram', {
    apiId: clean(apiId) || process.env.TELEGRAM_API_ID,
    apiHash: clean(apiHash) || process.env.TELEGRAM_API_HASH,
    botToken: clean(botToken) || process.env.TELEGRAM_BOT_TOKEN,
    channelId: clean(channelId) || process.env.TELEGRAM_CHANNEL_ID
  });
  res.json(result);
});

// Disconnect Telegram (Admin)
router.post('/telegram/disconnect', adminOnly, async (req, res) => {
  db.setSetting('telegram_enabled', 'false');
  const provider = storageManager.getProvider('telegram');
  if (provider && provider.disconnect) {
    await provider.disconnect();
  }

  res.json({
    success: true,
    message: 'Telegram storage provider disconnected. Saved credentials preserved.'
  });
});

// Clear Cache
router.post('/clear-cache', adminOnly, (req, res) => {
  const ok = cacheManager.clear();
  res.json({ success: ok, message: ok ? 'Cache cleared' : 'Could not clear cache' });
});

// Export SQLite Database / User Data Package
router.get('/export-db', (req, res) => {
  const isAdmin = req.user && req.user.role === 'admin';
  const scope = req.query.scope || (isAdmin ? 'system' : 'user');

  if (isAdmin && scope === 'system') {
    const dbPath = path.join(config.DATA_DIR, 'clouddrive.db');
    if (!fs.existsSync(dbPath)) return res.status(404).send('Database not found');
    return res.download(dbPath, `clouddrive-${new Date().toISOString().split('T')[0]}.db`);
  }

  // Export personal user data package
  try {
    const userPackage = db.exportUserData(req.user.id);
    const userSlug = (req.user.name || req.user.email || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="clouddrive-backup-${userSlug}-${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify(userPackage, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export user data: ' + err.message });
  }
});

// Export Emergency Manifest JSON (Includes user encryption key, files, chunk IVs and Auth Tags)
router.get('/export-manifest', (req, res) => {
  try {
    const files = db.getFiles(req.user.id);
    const filesWithChunks = files.map(f => {
      const chunks = db.getFileChunks(f.id) || [];
      return {
        id: f.id,
        name: f.name,
        size: f.size,
        mime_type: f.mime_type,
        is_chunked: f.is_chunked,
        total_chunks: f.total_chunks,
        iv: f.iv,
        auth_tag: f.auth_tag,
        sha256: f.sha256,
        chunks: chunks.map(c => ({
          chunk_index: c.chunk_index,
          size: c.size,
          iv: c.iv,
          auth_tag: c.auth_tag,
          sha256: c.sha256
        }))
      };
    });

    const manifest = {
      exported_at: new Date().toISOString(),
      generator: 'CloudDrive Emergency Manifest Generator',
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        encryption_key: req.user.encryption_key,
        file_prefix: req.user.file_prefix
      },
      files: filesWithChunks
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="emergency_manifest_${req.user.name || 'user'}_${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify(manifest, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate emergency manifest: ' + err.message });
  }
});

// Admin-only offline recovery bundle. This intentionally contains the database,
// provider configuration, and encryption metadata needed for a disaster restore.
// The response is never persisted server-side; the browser downloads it directly.
router.get('/download-recovery-bundle', adminOnly, (req, res) => {
  return res.status(405).json({ error: 'Password required. Use the download button in Settings.' });
});

router.post('/download-recovery-bundle', adminOnly, async (req, res) => {
  try {
    const password = clean(req.body && req.body.password);
    if (!password || !(await bcrypt.compare(password, req.user.password_hash || req.user.password || ''))) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }
    const dbPath = path.join(config.DATA_DIR, 'clouddrive.db');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });
    const users = db.getAllUsers().map(userSummary => {
      const user = db.getUserById(userSummary.id) || userSummary;
      const files = db.getFiles(user.id) || [];
      return {
        id: user.id, email: user.email, name: user.name, role: user.role,
        encryption_key: user.encryption_key, file_prefix: user.file_prefix,
        files: files.map(file => ({
          ...file,
          chunks: (db.getFileChunks(file.id) || []).map(chunk => ({
            id: chunk.id, file_id: chunk.file_id, chunk_index: chunk.chunk_index,
            size: chunk.size, iv: chunk.iv, auth_tag: chunk.auth_tag,
            sha256: chunk.sha256, replicas: db.getChunkReplicas ? db.getChunkReplicas(chunk.id) : []
          }))
        }))
      };
    });
    const bundle = {
      format: 'clouddrive-disaster-recovery-v1',
      warning: 'Contains encryption keys and provider credentials. Store offline in an encrypted location.',
      exported_at: new Date().toISOString(),
      encryption: { database_algorithm: 'AES-256-GCM', database_key_env: 'ENCRYPTION_KEY' },
      env: Object.fromEntries(['JWT_SECRET', 'ENCRYPTION_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'DISCORD_GUILD_ID', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'SESSION_STRING'].map(key => [key, process.env[key] || ''])),
      database_base64: fs.readFileSync(dbPath).toString('base64'),
      users
    };
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="clouddrive-recovery-bundle-${stamp}.json"`);
    res.send(JSON.stringify(bundle));
  } catch (err) {
    res.status(500).json({ error: 'Failed to create recovery bundle: ' + err.message });
  }
});

// Admin-only cleanup of all Telegram messages known to CloudDrive. Telegram
// bots cannot enumerate arbitrary historical channel messages, so this safely
// deletes only stored replica IDs; the interactive user-session purge tool is
// required for messages outside CloudDrive.
router.post('/telegram/purge-known', adminOnly, async (req, res) => {
  try {
    const password = clean(req.body && req.body.password);
    const confirm = clean(req.body && req.body.confirmation);
    if (confirm !== 'DELETE_ALL_TELEGRAM_MESSAGES') return res.status(400).json({ error: 'Type DELETE_ALL_TELEGRAM_MESSAGES to confirm' });
    if (!password || !(await bcrypt.compare(password, req.user.password_hash || req.user.password || ''))) return res.status(401).json({ error: 'Invalid admin password' });
    const replicas = [];
    for (const file of db.getAllFiles(null, true) || []) replicas.push(...(db.getFileReplicas(file.id) || []).filter(r => r.provider === 'telegram'));
    if (replicas.length) await storageManager.deleteChunksBulk(replicas);
    res.json({ success: true, deleted: replicas.length, message: 'Known CloudDrive Telegram messages deleted. External messages require the user-session purge tool.' });
  } catch (err) { res.status(500).json({ error: 'Telegram cleanup failed: ' + err.message }); }
});

// Import SQLite Database or User Data Package
router.post('/import-db', upload.single('database'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No backup file provided' });

  const isAdmin = req.user && req.user.role === 'admin';
  const filePath = req.file.path;
  const originalName = (req.file.originalname || '').toLowerCase();

  try {
    if (originalName.endsWith('.json')) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const dataPackage = JSON.parse(fileContent);
      const importRes = db.importUserData(req.user.id, dataPackage);
      fs.unlinkSync(filePath);
      return res.json({
        success: true,
        message: `Personal backup restored successfully! (${importRes.importedFiles} files, ${importRes.importedFolders} folders restored)`,
        details: importRes
      });
    }

    // If .db or .sqlite and user is Admin
    if (isAdmin && (originalName.endsWith('.db') || originalName.endsWith('.sqlite'))) {
      const dbPath = path.join(config.DATA_DIR, 'clouddrive.db');
      fs.copyFileSync(filePath, dbPath);
      fs.unlinkSync(filePath);
      await db.initialize();
      return res.json({ success: true, message: 'Database restored successfully! CloudDrive reinitialized.' });
    }

    // If .enc file, try decrypting
    if (originalName.endsWith('.enc') || originalName.endsWith('.enc.db')) {
      const tempDecPath = path.join(config.TMP_DIR, `imported_dec_${Date.now()}.tmp`);
      try {
        await cryptoModule.decryptFile(filePath, tempDecPath, config.ENCRYPTION_KEY, null, null, 'db-backup');
        const decContent = fs.readFileSync(tempDecPath, 'utf8');
        try {
          const dataPackage = JSON.parse(decContent);
          const importRes = db.importUserData(req.user.id, dataPackage);
          if (fs.existsSync(tempDecPath)) fs.unlinkSync(tempDecPath);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return res.json({
            success: true,
            message: `Encrypted personal backup restored successfully! (${importRes.importedFiles} files, ${importRes.importedFolders} folders restored)`,
            details: importRes
          });
        } catch (e) {
          if (isAdmin) {
            const dbPath = path.join(config.DATA_DIR, 'clouddrive.db');
            fs.copyFileSync(tempDecPath, dbPath);
            if (fs.existsSync(tempDecPath)) fs.unlinkSync(tempDecPath);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            await db.initialize();
            return res.json({ success: true, message: 'Encrypted system database restored successfully!' });
          }
          throw new Error('Encrypted file is not a valid user data package');
        }
      } finally {
        if (fs.existsSync(tempDecPath)) fs.unlinkSync(tempDecPath);
      }
    }

    fs.unlinkSync(filePath);
    return res.status(400).json({ error: 'Unsupported backup file format. Please upload .json or .enc backup file.' });
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(500).json({ error: `Restore failed: ${err.message}` });
  }
});

// ─── Preferences ────────────────────────────────────────────────────────────

router.get('/preferences', async (req, res) => {
  try {
    const preferences = db.getAllSettings(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.put('/preferences', async (req, res) => {
  try {
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'Invalid preferences object' });
    }

    const keyMap = {
      theme: 'theme',
      view_mode: 'view_mode',
      viewMode: 'view_mode',
      sort_by: 'sort_by',
      sortBy: 'sort_by',
      sort_order: 'sort_order',
      sortOrder: 'sort_order',
      chunk_size: 'chunk_size',
      chunkSize: 'chunk_size',
      discord_chunk_size: 'discord_chunk_size',
      discordChunkSize: 'discord_chunk_size',
      telegram_chunk_size: 'telegram_chunk_size',
      telegramChunkSize: 'telegram_chunk_size',
      concurrent_chunks: 'concurrent_chunks',
      concurrentChunks: 'concurrent_chunks',
      wake_lock: 'wake_lock',
      wakeLock: 'wake_lock',
      file_prefix: 'file_prefix',
      filePrefix: 'file_prefix',
      default_storage_mode: 'default_storage_mode',
      defaultStorageMode: 'default_storage_mode',
      primary_provider: 'primary_provider',
      primaryProvider: 'primary_provider',
      upload_strategy: 'upload_strategy',
      uploadStrategy: 'upload_strategy',
      encryption_enabled: 'encryption_enabled',
      encryptionEnabled: 'encryption_enabled',
      show_thumbnails: 'show_thumbnails',
      thumbnails: 'show_thumbnails',
      language: 'language',
      compact_view: 'compact_view'
    };

    const filtered = {};
    for (const [k, v] of Object.entries(preferences)) {
      const dbKey = keyMap[k];
      if (dbKey && v !== undefined) {
        filtered[dbKey] = String(v);
      }
    }

    db.setMultipleSettings(filtered, req.user.id);

    const userUpdates = {};
    if (filtered.file_prefix !== undefined) {
      userUpdates.file_prefix = filtered.file_prefix ? filtered.file_prefix.trim() : null;
    }
    if (filtered.default_storage_mode !== undefined) {
      userUpdates.default_storage_mode = filtered.default_storage_mode;
    }
    if (Object.keys(userUpdates).length > 0) {
      db.updateUser(req.user.id, userUpdates);
    }

    res.json({ success: true, preferences: db.getAllSettings(req.user.id) });
  } catch (error) {
    console.error('Error updating user preferences:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// PUT /discord alias
router.put('/discord', adminOnly, async (req, res) => {
  const { botToken, channelId, guildId } = req.body;
  const effectiveToken = clean(botToken) || process.env.DISCORD_BOT_TOKEN;
  const effectiveChannel = clean(channelId) || process.env.DISCORD_CHANNEL_ID;
  if (!effectiveToken || !effectiveChannel) {
    return res.status(400).json({ error: 'Bot Token and Channel ID are required' });
  }

  process.env.DISCORD_BOT_TOKEN = effectiveToken;
  process.env.DISCORD_CHANNEL_ID = effectiveChannel;
  if (guildId) process.env.DISCORD_GUILD_ID = guildId.trim();

  db.setSetting('discord_enabled', 'true');
  saveEnvFile();

  const provider = storageManager.getProvider('discord');
  const connected = await provider.initialize({
    botToken: process.env.DISCORD_BOT_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    forceConnect: true
  });

  res.json({
    success: true,
    connected,
    message: connected ? 'Discord connected successfully!' : 'Discord credentials saved, but connection failed.'
  });
});

// ─── WebDAV Settings & Sessions ─────────────────────────────────────────────

// GET /webdav — open to all authenticated users
// Admin gets full global settings; regular users get their own connection info
router.get('/webdav', async (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const globalEnabled = (db.getSetting('webdav_enabled') !== 'false') && (process.env.WEBDAV_ENABLED !== 'false');
    const permissionMode = db.getSetting('webdav_permission_mode') || process.env.WEBDAV_PERMISSION_MODE || 'full';

    // Per-user WebDAV password stored in app_settings keyed to this user
    const userWebdavPassHash = db.getSetting('webdav_user_password_hash', req.user.id);
    const hasCustomPassword = Boolean(userWebdavPassHash);
    const userEnabled = db.getSetting('webdav_user_enabled', req.user.id) !== 'false';

    // Each user's WebDAV username is their own email
    const username = req.user ? (db.getSetting('webdav_username', req.user.id) || req.user.email) : 'admin';

    res.json({
      enabled: globalEnabled,
      permissionMode,
      username,
      hasCustomPassword,
      userEnabled,
      urlPath: '/webdav',
      isAdmin,
      userEmail: req.user ? req.user.email : '',
      userName: req.user ? req.user.name : ''
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch WebDAV settings' });
  }
});

// POST /webdav — Admin can change global enabled/permissionMode; any user can set their own password
router.post('/webdav', async (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const { enabled, permissionMode, password, username, resetPassword, userEnabled } = req.body;

    // Admin-only: global enable/disable
    if (enabled !== undefined) {
      if (isAdmin) {
        const val = enabled ? 'true' : 'false';
        process.env.WEBDAV_ENABLED = val;
        db.setSetting('webdav_enabled', val);
        saveEnvFile();
      } else {
        return res.status(403).json({ error: 'Administrator privileges required to change WebDAV enabled state' });
      }
    }

    // Admin-only: global permission mode
    if (permissionMode !== undefined) {
      if (isAdmin) {
        const validModes = ['full', 'readonly', 'safemode'];
        const mode = validModes.includes(permissionMode) ? permissionMode : 'full';
        process.env.WEBDAV_PERMISSION_MODE = mode;
        db.setSetting('webdav_permission_mode', mode);
        saveEnvFile();
      } else {
        return res.status(403).json({ error: 'Administrator privileges required to change permission mode' });
      }
    }

    // Any user: set/reset their own WebDAV password (stored per-user)
    const userId = req.user.id;
    if (userEnabled !== undefined) db.setSetting('webdav_user_enabled', userEnabled ? 'true' : 'false', userId);
    if (username !== undefined) {
      const normalized = String(username).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) return res.status(400).json({ error: 'Username must be 3-64 letters, numbers, dot, underscore, or hyphen' });
      const taken = (db.getAllUsers ? db.getAllUsers() : []).some(u => u.id !== userId && db.getSetting('webdav_username', u.id) === normalized);
      if (taken) return res.status(409).json({ error: 'That WebDAV username is already in use' });
      db.setSetting('webdav_username', normalized, userId);
    }
    if (resetPassword) {
      db.setSetting('webdav_user_password_hash', '', userId);
    } else if (password !== undefined && password.trim()) {
      if (password.trim().length < 10) return res.status(400).json({ error: 'WebDAV password must be at least 10 characters' });
      const passHash = bcrypt.hashSync(password.trim(), 10);
      db.setSetting('webdav_user_password_hash', passHash, userId);
    }

    const globalEnabled = (db.getSetting('webdav_enabled') !== 'false') && (process.env.WEBDAV_ENABLED !== 'false');
    const userWebdavPassHash = db.getSetting('webdav_user_password_hash', userId);
    const hasCustomPassword = Boolean(userWebdavPassHash);

    res.json({
      success: true,
      message: resetPassword
        ? 'WebDAV password reset — you can now sign in with your account password!'
        : 'WebDAV settings updated successfully!',
      settings: {
        enabled: globalEnabled,
        permissionMode: db.getSetting('webdav_permission_mode') || process.env.WEBDAV_PERMISSION_MODE || 'full',
        username: db.getSetting('webdav_username', userId) || req.user.email,
        userEnabled: db.getSetting('webdav_user_enabled', userId) !== 'false',
        hasCustomPassword,
        isAdmin
      }
    });
  } catch (error) {
    console.error('Error updating WebDAV settings:', error);
    res.status(500).json({ error: 'Failed to update WebDAV settings: ' + error.message });
  }
});

// Test WebDAV credentials — any user can test their own
router.post('/webdav/test-auth', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required to test credentials.' });
    }

    const testEmail = username.trim().toLowerCase();
    const testPass = password;

    // A signed-in user may test only their own WebDAV identity. This avoids
    // turning the helper endpoint into a credential-oracle for other accounts.
    const ownWebdavUsername = (db.getSetting('webdav_username', req.user.id) || req.user.email).toLowerCase();
    if (testEmail !== req.user.email.toLowerCase() && testEmail !== ownWebdavUsername) {
      return res.status(403).json({ success: false, error: 'You can only test your own WebDAV credentials.' });
    }
    const matchedDbUser = req.user;

    if (!matchedDbUser || matchedDbUser.status !== 'active') {
      return res.status(401).json({ success: false, error: 'User not found or account suspended.' });
    }

    // 1. Check per-user dedicated WebDAV password
    const perUserPassHash = db.getSetting('webdav_user_password_hash', matchedDbUser.id);
    if (perUserPassHash) {
      if (bcrypt.compareSync(testPass, perUserPassHash)) {
        return res.json({ success: true, message: `Credentials verified using dedicated WebDAV password for ${matchedDbUser.email}!` });
      } else {
        return res.status(401).json({ success: false, error: 'Authentication failed: Incorrect WebDAV password.' });
      }
    }

    // 2. Fallback: account password
    if (bcrypt.compareSync(testPass, matchedDbUser.password_hash)) {
      return res.json({ success: true, message: `Credentials verified using Account Password for ${matchedDbUser.email}!` });
    }

    res.status(401).json({ success: false, error: 'Authentication failed: Incorrect username or password.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sessions: admin sees all sessions; regular users see only their own
router.get('/webdav/sessions', (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const allSessions = sessionTracker.getActiveSessions();
    // Filter to user's own sessions if not admin
    const sessions = isAdmin
      ? allSessions
      : allSessions.filter(s => s.username && s.username.toLowerCase() === req.user.email.toLowerCase());
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active device sessions' });
  }
});

// Revoke: admin can revoke any; user can only revoke their own sessions
router.post('/webdav/sessions/revoke', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      const allSessions = sessionTracker.getActiveSessions();
      const session = allSessions.find(s => s.id === sessionId);
      if (!session || session.username.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(403).json({ error: 'You can only disconnect your own sessions' });
      }
    }
    sessionTracker.revokeSession(sessionId);
    res.json({ success: true, message: 'Device disconnected successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to revoke device session' });
  }
});

// Unrevoke: admin can unrevoke any; user can unrevoke their own
router.post('/webdav/sessions/unrevoke', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      const allSessions = sessionTracker.getActiveSessions();
      const session = allSessions.find(s => s.id === sessionId);
      if (!session || session.username.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(403).json({ error: 'You can only re-allow your own sessions' });
      }
    }
    sessionTracker.unrevokeSession(sessionId);
    res.json({ success: true, message: 'Device re-allowed successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unrevoke device session' });
  }
});

// ─── Cloud Backup & Restore ─────────────────────────────────────────────────

router.get('/backup-status', (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const status = backupService.getBackupStatus(req.user ? req.user.id : null, isAdmin);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve backup status: ' + error.message });
  }
});

router.post('/backup-now', async (req, res) => {
  try {
    const { provider = 'all', scope } = req.body || {};
    const isAdmin = req.user && req.user.role === 'admin';

    if (isAdmin && scope === 'system') {
      const result = await backupService.performDatabaseBackup(null, provider);
      return res.json(result);
    }

    const result = await backupService.performUserBackup(req.user.id, provider);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create backup' });
  }
});

router.post('/restore-cloud-backup', async (req, res) => {
  try {
    const { discordMessageId, remoteId, provider } = req.body || {};
    const idToRestore = remoteId || discordMessageId;
    if (!idToRestore) {
      return res.status(400).json({ error: 'remoteId is required' });
    }

    const isAdmin = req.user && req.user.role === 'admin';
    const backupRec = db.getBackupByRemoteId ? db.getBackupByRemoteId(idToRestore) : null;

    if (backupRec && backupRec.user_id) {
      if (!isAdmin && backupRec.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized: You can only restore your own backups' });
      }
      const result = await backupService.restoreUserBackup(idToRestore, req.user.id, provider || backupRec.provider);
      return res.json(result);
    }

    if (!isAdmin) {
      const result = await backupService.restoreUserBackup(idToRestore, req.user.id, provider);
      return res.json(result);
    }

    const result = await backupService.restoreBackup(idToRestore, provider);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to restore cloud backup' });
  }
});

router.delete('/backup/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Backup ID is required' });
    }
    const isAdmin = req.user && req.user.role === 'admin';
    const result = await backupService.deleteBackup(id, req.user ? req.user.id : null, isAdmin);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to delete backup' });
  }
});

function saveEnvFile() {
  const lines = [
    `PORT=${config.PORT}`,
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
  const content = lines.join('\n');
  try {
    fs.writeFileSync(config.CONFIG_ENV_PATH, content, { mode: 0o600 });
    try { fs.chmodSync(config.CONFIG_ENV_PATH, 0o600); } catch (_) {}
  } catch (e) {
    console.warn('[Settings] Failed to save config.env:', e.message);
  }
  try {
    const rootEnv = path.join(__dirname, '../../.env');
    if (fs.existsSync(rootEnv)) {
      fs.writeFileSync(rootEnv, content, { mode: 0o600 });
      try { fs.chmodSync(rootEnv, 0o600); } catch (_) {}
    }
  } catch (e) {
    console.warn('[Settings] Failed to save root .env:', e.message);
  }
}

module.exports = router;
