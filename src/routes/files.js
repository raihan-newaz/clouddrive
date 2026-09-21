const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { notifySecurityEvent } = require('../services/notificationService');
const { uploadLimiter } = require('../middleware/rateLimiter');
const storageManager = require('../storage/StorageManager');
const db = require('../db');
const cryptoModule = require('../crypto');
const replicationWorker = require('../services/replicationWorker');
const cacheManager = require('../services/cacheManager');
const eventBroadcaster = require('../services/eventBroadcaster');
const { UploadQueue, UploadQueueFullError } = require('../services/uploadQueue');
const config = require('../config');
const { verifyFolderToken } = require('../securityTokens');

const router = express.Router();
router.use(authMiddleware);

fs.mkdirSync(config.TMP_DIR, { recursive: true });
const upload = multer({
  // Keep waiting chunks on disk. Memory storage lets queued multipart requests
  // consume RAM before the server-side queue can apply backpressure.
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, config.TMP_DIR),
    filename: (_req, _file, callback) => callback(null, `upload-${Date.now()}-${uuidv4()}.part`)
  }),
  limits: { fileSize: 64 * 1024 * 1024, files: 1, fields: 20 }
});
const STORAGE_MODES = new Set(['discord', 'telegram', 'dual']);
const PROVIDERS = new Set(['discord', 'telegram']);
const UPLOAD_STRATEGIES = new Set(['primary_first', 'simultaneous', 'parallel_both', 'auto']);
const uploadQueue = new UploadQueue({
  maxActive: config.MAX_ACTIVE_UPLOAD_JOBS,
  maxPerUser: config.MAX_UPLOAD_JOBS_PER_USER,
  maxQueued: config.MAX_QUEUED_UPLOAD_JOBS
});

function requireUnlockedFile(req, res, file) {
  if (!file || !file.folder_id) return true;
  const folder = db.getFolderById(file.folder_id, req.user.id);
  if (!folder || (!folder.is_locked && !folder.password_hash)) return true;
  const token = req.headers['x-folder-token'] || req.query.folderToken;
  if (verifyFolderToken(folder.id, req.user.id, token)) return true;
  res.status(403).json({ error: 'Folder password verification required' });
  return false;
}

router.use((req, res, next) => {
  const firstSegment = (req.path.split('/').filter(Boolean)[0] || '');
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(firstSegment)) return next();
  const file = db.getFileById(firstSegment, req.user.id);
  if (file && !requireUnlockedFile(req, res, file)) return;
  next();
});

/**
 * Accurately decodes Unicode UTF-8 filenames (Bengali, Russian, Cyrillic, Asian, Emojis)
 * that may have been parsed as latin1/binary by multipart parsers.
 */
function decodeUtf8FileName(name) {
  if (!name || typeof name !== 'string') return 'unnamed_file';
  let cleanName = name.trim();
  try {
    // If busboy/multer mis-encoded UTF-8 as latin1/binary
    const reDecoded = Buffer.from(cleanName, 'latin1').toString('utf8');
    // If reDecoded is valid and does not contain replacement character (\uFFFD)
    // and had multi-byte UTF-8 sequences (like Bengali or Russian)
    if (reDecoded && !reDecoded.includes('\ufffd') && reDecoded !== cleanName) {
      cleanName = reDecoded;
    }
  } catch (e) {}
  return cleanName || 'unnamed_file';
}

/**
 * Formats the remote file/chunk name stored in cloud providers (Discord / Telegram)
 * e.g. `<prefix>_<filename>.enc` or `<prefix>_<filename>.part0.enc`
 */
function formatRemoteFileName(fileName, prefix = null, chunkIndex = null, totalChunks = 1, isEnc = true) {
  let base = (fileName || 'file').trim().replace(/[\/\\]/g, '_');
  if (prefix) {
    const cleanPrefix = prefix.trim();
    if (cleanPrefix && !base.startsWith(`${cleanPrefix}_`)) {
      base = `${cleanPrefix}_${base}`;
    }
  }
  const ext = (isEnc !== false && isEnc !== 0 && isEnc !== 'false') ? '.enc' : '';
  if (totalChunks > 1 && chunkIndex !== null && chunkIndex !== undefined) {
    return `${base}.part${chunkIndex}${ext}`;
  }
  return `${base}${ext}`;
}

/**
 * Sets RFC 5987 / RFC 6266 compliant Content-Disposition header
 * ensuring native UTF-8 Bengali & Russian file names download perfectly across all browsers.
 */
function setContentDisposition(res, filename, type = 'attachment') {
  const cleanName = filename || 'file';
  const safeAscii = cleanName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const utf8Encoded = encodeURIComponent(cleanName).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition', `${type}; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`);
}

// ─── List Files ─────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const { folderId, starred, recent, trash, trashed, type, search } = req.query;

  let files = [];
  const hasSearch = (search && search.trim().length > 0);
  const targetFolder = (folderId === 'null' || folderId === 'root' || !folderId) ? null : folderId;

  if (targetFolder) {
    const folder = db.getFolderById(targetFolder, req.user.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if ((folder.is_locked || folder.password_hash) && !verifyFolderToken(targetFolder, req.user.id, req.headers['x-folder-token'] || req.query.folderToken)) {
      return res.status(403).json({ error: 'Folder password verification required' });
    }
  }

  if (trash === 'true' || trash === '1' || trashed === 'true' || trashed === '1') {
    if (hasSearch) {
      files = db.getAllTrashedFiles(req.user.id);
    } else {
      files = db.getTrashedFiles(req.user.id, targetFolder);
    }
  } else if (starred === 'true' || starred === '1') {
    files = db.getStarredFiles(req.user.id);
  } else if (recent === 'true' || recent === '1') {
    files = db.getRecentFiles(50, req.user.id);
  } else if (hasSearch) {
    if (targetFolder) {
      files = db.getFilesByFolder(targetFolder, req.user.id);
    } else {
      files = db.getAllFiles(req.user.id, false);
    }
  } else {
    files = db.getFilesByFolder(targetFolder, req.user.id);
  }

  // Filter by MIME category if requested
  if (type && type !== 'all') {
    files = files.filter(f => {
      const mime = (f.mime_type || '').toLowerCase();
      const ext = (f.name || '').split('.').pop().toLowerCase();
      if (type === 'image') return mime.startsWith('image/');
      if (type === 'video') return mime.startsWith('video/');
      if (type === 'audio') return mime.startsWith('audio/');
      if (type === 'document') return mime.includes('pdf') || mime.includes('document') || mime.includes('text') || ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xlsx', 'pptx'].includes(ext);
      if (type === 'archive') return mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext);
      return true;
    });
  }

  // Filter by search query
  if (search && search.trim().length > 0) {
    const q = search.trim().toLowerCase();
    files = files.filter(f => (f.name || '').toLowerCase().includes(q));
  }

  res.json(files);
});

// ─── Resumable Upload Sessions ──────────────────────────────────────────────

// Initialize Upload Session
router.post('/upload/init', uploadLimiter, async (req, res) => {
  const { fileName, fileSize, folderId, totalChunks, storageMode, primaryProvider, sha256 } = req.body;
  if (!fileName || !fileSize || !totalChunks) {
    return res.status(400).json({ error: 'fileName, fileSize, and totalChunks are required' });
  }
  const parsedSize = Number(fileSize);
  const parsedChunks = Number(totalChunks);
  if (!Number.isSafeInteger(parsedSize) || parsedSize <= 0 || !Number.isSafeInteger(parsedChunks) || parsedChunks < 1 || parsedChunks > 100000) {
    return res.status(400).json({ error: 'Invalid fileSize or totalChunks' });
  }

  // Quota check
  if (req.user.storage_limit > 0 && req.user.storage_used + parseInt(fileSize, 10) > req.user.storage_limit) {
    return res.status(403).json({ error: 'Storage quota exceeded' });
  }

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).json({
      error: 'All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings before uploading files.'
    });
  }

  // Determine storage policy
  let mode = storageMode || req.user.default_storage_mode || db.getSetting('default_storage_mode') || config.DEFAULT_STORAGE_MODE || 'dual';
  if (folderId && folderId !== 'null' && folderId !== 'root') {
    const folder = db.getFolderById(folderId, req.user.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if ((folder.is_locked || folder.password_hash) && !verifyFolderToken(folder.id, req.user.id, req.headers['x-folder-token'] || req.query.folderToken)) {
      return res.status(403).json({ error: 'Folder password verification required' });
    }
    if (folder.storage_policy) mode = folder.storage_policy;
  }
  if (!STORAGE_MODES.has(mode)) return res.status(400).json({ error: 'Invalid storage mode' });

  if (mode === 'dual') {
    if (!isDiscordEnabled && isTelegramEnabled) mode = 'telegram';
    else if (!isTelegramEnabled && isDiscordEnabled) mode = 'discord';
  }

  let primary = primaryProvider;
  if (mode === 'discord') {
    primary = 'discord';
  } else if (mode === 'telegram') {
    primary = 'telegram';
  } else {
    primary = primary || db.getSetting('primary_provider') || config.PRIMARY_PROVIDER || 'telegram';
  }
  if (!PROVIDERS.has(primary)) return res.status(400).json({ error: 'Invalid primary provider' });

  if (primary === 'discord' && !isDiscordEnabled && isTelegramEnabled) primary = 'telegram';
  if (primary === 'telegram' && !isTelegramEnabled && isDiscordEnabled) primary = 'discord';

  const activeStrategy = db.getSetting('upload_strategy', req.user.id) || config.UPLOAD_STRATEGY || 'primary_first';
  if (!UPLOAD_STRATEGIES.has(activeStrategy)) return res.status(400).json({ error: 'Invalid upload strategy' });
  const isEnc = db.getSetting('encryption_enabled', req.user.id) !== 'false';
  const sessionId = uuidv4();
  const cleanFileName = decodeUtf8FileName(fileName);

  const session = {
    id: sessionId,
    user_id: req.user.id,
    file_name: cleanFileName,
    file_size: parseInt(fileSize, 10),
    folder_id: (folderId === 'null' || folderId === 'root' || !folderId) ? null : folderId,
    storage_mode: mode,
    primary_provider: primary,
    upload_strategy: activeStrategy,
    total_chunks: parseInt(totalChunks, 10),
    sha256: sha256 || null,
    encryption_enabled: isEnc ? 1 : 0
  };

  db.run(`
    INSERT INTO upload_sessions (id, user_id, file_name, file_size, folder_id, storage_mode, primary_provider, upload_strategy, total_chunks, sha256, encryption_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [session.id, session.user_id, session.file_name, session.file_size, session.folder_id, session.storage_mode, session.primary_provider, session.upload_strategy, session.total_chunks, session.sha256, session.encryption_enabled]);

  res.json({
    success: true,
    sessionId,
    storageMode: mode,
    primaryProvider: primary,
    uploadStrategy: activeStrategy,
    encryptionEnabled: isEnc
  });
});

// Upload Single Chunk of a Session
router.post('/upload/chunk', uploadLimiter, upload.single('chunk'), async (req, res) => {
  const { sessionId, chunkIndex } = req.body;
  if (!sessionId || chunkIndex === undefined || !req.file) {
    return res.status(400).json({ error: 'sessionId, chunkIndex, and chunk file are required' });
  }

  const session = db.get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', [sessionId, req.user.id]);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found or expired' });
  }

  const index = parseInt(chunkIndex, 10);
  if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) {
    return res.status(400).json({ error: 'Invalid chunk index' });
  }
  try {
    const result = await uploadQueue.run(req.user.id, async () => {
      const plainBuffer = await fs.promises.readFile(req.file.path);
      const isEncEnabled = session.encryption_enabled !== undefined && session.encryption_enabled !== null
        ? session.encryption_enabled === 1
        : (db.getSetting('encryption_enabled', req.user.id) !== 'false');

      // Encrypt and send one chunk as one bounded job. Holding the queue slot
      // through provider I/O prevents a burst of encrypted buffers from piling up.
      const encResult = cryptoModule.encryptChunkBuffer(
        plainBuffer,
        req.user.encryption_key,
        sessionId,
        index,
        isEncEnabled
      );
      const remoteFileName = formatRemoteFileName(
        session.file_name,
        req.user.file_prefix,
        index,
        session.total_chunks,
        isEncEnabled
      );
      const activeUploadStrategy = session.upload_strategy || db.getSetting('upload_strategy') || config.UPLOAD_STRATEGY || 'primary_first';

    if (session.storage_mode === 'dual' && (activeUploadStrategy === 'parallel_both' || activeUploadStrategy === 'simultaneous')) {
      const secondaryProvider = session.primary_provider === 'discord' ? 'telegram' : 'discord';
      
      const [uploadResult, secResult] = await Promise.all([
        storageManager.uploadChunk(session.primary_provider, encResult.ciphertext, remoteFileName).catch(err => {
          console.warn(`[Files] Simultaneous upload to primary provider ${session.primary_provider} failed:`, err.message);
          return null;
        }),
        storageManager.uploadChunk(secondaryProvider, encResult.ciphertext, remoteFileName).catch(err => {
          console.warn(`[Files] Simultaneous upload to secondary provider ${secondaryProvider} failed:`, err.message);
          return null;
        })
      ]);

      if (!uploadResult && !secResult) {
        throw new Error(`Upload failed on both ${session.primary_provider} and ${secondaryProvider}`);
      }

      // Record primary session chunk if successful
      if (uploadResult && uploadResult.remoteId) {
        db.run(`
          INSERT OR REPLACE INTO upload_session_chunks (id, session_id, chunk_index, provider, remote_id, size, iv, salt, auth_tag, sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          sessionId,
          index,
          session.primary_provider,
          uploadResult.remoteId,
          encResult.ciphertext.length,
          encResult.iv,
          cryptoModule.MASTER_SALT_DEFAULT,
          encResult.authTag,
          encResult.sha256
        ]);
      }

      // Record secondary session chunk if successful
      if (secResult && secResult.remoteId) {
        db.run(`
          INSERT OR REPLACE INTO upload_session_chunks (id, session_id, chunk_index, provider, remote_id, size, iv, salt, auth_tag, sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          sessionId,
          index,
          secondaryProvider,
          secResult.remoteId,
          encResult.ciphertext.length,
          encResult.iv,
          cryptoModule.MASTER_SALT_DEFAULT,
          encResult.authTag,
          encResult.sha256
        ]);
      }

      const activeProvider = uploadResult ? session.primary_provider : secondaryProvider;
      const activeRemoteId = uploadResult ? uploadResult.remoteId : secResult.remoteId;

      return {
        success: true,
        chunkIndex: index,
        provider: activeProvider,
        remoteId: activeRemoteId,
        secondaryRemoteId: secResult ? secResult.remoteId : null
      };
    } else {
      // Primary provider upload with automatic failover
      const uploadResult = await storageManager.uploadChunkWithFailover(
        session.primary_provider,
        encResult.ciphertext,
        remoteFileName
      );

      const actualProvider = uploadResult.provider || session.primary_provider;

      // Record session chunk under actual successful provider
      db.run(`
        INSERT OR REPLACE INTO upload_session_chunks (id, session_id, chunk_index, provider, remote_id, size, iv, salt, auth_tag, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        sessionId,
        index,
        actualProvider,
        uploadResult.remoteId,
        encResult.ciphertext.length,
        encResult.iv,
        cryptoModule.MASTER_SALT_DEFAULT,
        encResult.authTag,
        encResult.sha256
      ]);

      return {
        success: true,
        chunkIndex: index,
        provider: actualProvider,
        remoteId: uploadResult.remoteId,
        failoverUsed: !!uploadResult.failoverUsed
      };
    }
    });
    return res.json(result);
  } catch (err) {
    console.error(`[Files] Chunk upload error for session ${sessionId} chunk ${index}:`, err.message);
    notifySecurityEvent('Upload failure', { user: req.user.email, ip: req.ip, sessionId, chunk: index, error: err.message });
    const status = err instanceof UploadQueueFullError ? 429 : 500;
    res.status(status).json({ error: err.message || `Upload failed: ${err.message}`, retryAfter: status === 429 ? 5 : undefined });
  } finally {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

// Check Upload Session Status (for Resuming / Reconnecting)
router.get('/upload/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = db.get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', [sessionId, req.user.id]);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const sessionChunks = db.all('SELECT chunk_index, size FROM upload_session_chunks WHERE session_id = ? ORDER BY chunk_index ASC', [sessionId]);
  const uploadedIndices = sessionChunks.map(c => c.chunk_index);

  res.json({
    success: true,
    sessionId: session.id,
    fileName: session.file_name,
    fileSize: session.file_size,
    totalChunks: session.total_chunks,
    storageMode: session.storage_mode,
    primaryProvider: session.primary_provider,
    uploadedChunks: uploadedIndices
  });
});

// Cancel & Purge Incomplete Upload Session
router.post('/upload/cancel', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  try {
    const session = db.get('SELECT id FROM upload_sessions WHERE id = ? AND user_id = ?', [sessionId, req.user.id]);
    if (!session) return res.status(404).json({ error: 'Upload session not found' });
    // 1. Cancel any replication jobs associated with this session/file ID
    replicationWorker.cancelFileReplication(sessionId);

    // 2. Fetch and physically delete all chunks uploaded so far from Discord/Telegram
    const sessionChunks = db.all('SELECT provider, remote_id FROM upload_session_chunks WHERE session_id = ?', [sessionId]) || [];
    if (sessionChunks.length > 0) {
      await storageManager.deleteChunkReplicas(sessionChunks).catch(err => {
        console.warn(`[Files] Cancel upload chunk cleanup warning for session ${sessionId}:`, err.message);
      });
    }

    // 3. Clean up database records
    db.run('DELETE FROM upload_session_chunks WHERE session_id = ?', [sessionId]);
    db.run('DELETE FROM upload_sessions WHERE id = ?', [sessionId]);

    res.json({ success: true, message: 'Upload session cancelled and all uploaded chunks purged from cloud providers' });
  } catch (err) {
    console.error(`[Files] Cancel upload session error:`, err);
    res.status(500).json({ error: 'Failed to cancel upload session: ' + err.message });
  }
});

// Complete Upload Session
router.post('/upload/complete', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const session = db.get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', [sessionId, req.user.id]);
  if (!session) return res.status(404).json({ error: 'Upload session not found' });

  const sessionChunks = db.all('SELECT * FROM upload_session_chunks WHERE session_id = ? ORDER BY chunk_index ASC', [sessionId]);
  if (sessionChunks.length === 0) {
    return res.status(400).json({ error: 'No chunks uploaded for this session' });
  }

  const fileId = sessionId; // Stable file ID matches session
  const finalName = session.file_name;

  const totalExpected = session.total_chunks;
  const discordChunksCount = sessionChunks.filter(c => c.provider === 'discord').length;
  const telegramChunksCount = sessionChunks.filter(c => c.provider === 'telegram').length;

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  let discordStatus = 'none';
  let telegramStatus = 'none';
  let repStatus = 'completed';

  if (session.storage_mode === 'dual' && isDiscordEnabled && isTelegramEnabled) {
    discordStatus = (discordChunksCount >= totalExpected) ? 'completed' : (discordChunksCount > 0 ? 'partial' : 'pending');
    telegramStatus = (telegramChunksCount >= totalExpected) ? 'completed' : (telegramChunksCount > 0 ? 'partial' : 'pending');
    repStatus = (discordStatus === 'completed' && telegramStatus === 'completed') ? 'completed' : 'pending';
  } else if (session.storage_mode === 'discord' || (!isTelegramEnabled && isDiscordEnabled)) {
    discordStatus = (discordChunksCount >= totalExpected) ? 'completed' : 'pending';
    telegramStatus = 'none';
    repStatus = (discordStatus === 'completed') ? 'completed' : 'pending';
  } else if (session.storage_mode === 'telegram' || (!isDiscordEnabled && isTelegramEnabled)) {
    telegramStatus = (telegramChunksCount >= totalExpected) ? 'completed' : 'pending';
    discordStatus = 'none';
    repStatus = (telegramStatus === 'completed') ? 'completed' : 'pending';
  }

  // Create permanent file record
  const newFile = {
    id: fileId,
    user_id: req.user.id,
    name: finalName,
    mime_type: getMimeType(finalName),
    size: session.file_size,
    folder_id: session.folder_id,
    storage_mode: session.storage_mode,
    primary_provider: session.primary_provider,
    discord_status: discordStatus,
    telegram_status: telegramStatus,
    replication_status: repStatus,
    iv: sessionChunks[0].iv,
    salt: sessionChunks[0].salt,
    auth_tag: sessionChunks[0].auth_tag,
    sha256: session.sha256 || sessionChunks[0].sha256,
    is_starred: 0,
    is_trashed: 0,
    is_chunked: session.total_chunks > 1 ? 1 : 0,
    total_chunks: session.total_chunks,
    encryption_enabled: session.encryption_enabled !== 0 ? 1 : 0
  };

  db.createFile(newFile);

  // Group session chunks by index and create file_chunks & chunk_replicas
  const uniqueIndices = new Set(sessionChunks.map(c => c.chunk_index));
  for (const idx of uniqueIndices) {
    const chunkVariants = sessionChunks.filter(c => c.chunk_index === idx);
    const mainVariant = chunkVariants[0];
    const chunkId = uuidv4();

    db.addFileChunk({
      id: chunkId,
      file_id: fileId,
      chunk_index: idx,
      size: mainVariant.size,
      iv: mainVariant.iv,
      salt: mainVariant.salt,
      auth_tag: mainVariant.auth_tag,
      sha256: mainVariant.sha256,
      crypto_version: mainVariant.iv ? 2 : 0
    });

    for (const v of chunkVariants) {
      db.addChunkReplica({
        id: uuidv4(),
        chunk_id: chunkId,
        file_id: fileId,
        chunk_index: idx,
        provider: v.provider,
        remote_id: v.remote_id,
        remote_channel_id: v.remote_channel_id || null,
        status: 'completed'
      });
    }
  }

  // Update user storage used
  db.updateUser(req.user.id, {
    storage_used: (req.user.storage_used || 0) + session.file_size
  });

  // Clean up upload session
  db.run('DELETE FROM upload_sessions WHERE id = ?', [sessionId]);

  // If dual mode and any chunk replicas are missing on an ENABLED cloud, trigger background replication
  if (session.storage_mode === 'dual' && repStatus === 'pending') {
    if (discordChunksCount < totalExpected && isDiscordEnabled) {
      replicationWorker.enqueueFileReplication(fileId, 'discord');
    }
    if (telegramChunksCount < totalExpected && isTelegramEnabled) {
      replicationWorker.enqueueFileReplication(fileId, 'telegram');
    }
  }

  const savedFile = db.getFileById(fileId, req.user.id);
  eventBroadcaster.broadcast('file_uploaded', { file: savedFile, userId: req.user.id }, req.user.id);

  res.json({
    success: true,
    file: savedFile
  });
});

// Single Direct File Upload (for smaller files)
router.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { folderId, storageMode, primaryProvider } = req.body;
  const fileName = decodeUtf8FileName(req.file.originalname);
  const fileSize = req.file.size;

  if (req.user.storage_limit > 0 && req.user.storage_used + fileSize > req.user.storage_limit) {
    return res.status(403).json({ error: 'Storage quota exceeded' });
  }

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).json({
      error: 'All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings before uploading files.'
    });
  }

  let mode = storageMode || req.user.default_storage_mode || db.getSetting('default_storage_mode') || config.DEFAULT_STORAGE_MODE || 'dual';
  if (folderId && folderId !== 'null' && folderId !== 'root') {
    const folder = db.getFolderById(folderId, req.user.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if ((folder.is_locked || folder.password_hash) && !verifyFolderToken(folder.id, req.user.id, req.headers['x-folder-token'] || req.query.folderToken)) {
      return res.status(403).json({ error: 'Folder password verification required' });
    }
    if (folder.storage_policy) mode = folder.storage_policy;
  }
  if (!STORAGE_MODES.has(mode)) return res.status(400).json({ error: 'Invalid storage mode' });

  if (mode === 'dual') {
    if (!isDiscordEnabled && isTelegramEnabled) mode = 'telegram';
    else if (!isTelegramEnabled && isDiscordEnabled) mode = 'discord';
  }

  let primary = primaryProvider;
  if (mode === 'discord') {
    primary = 'discord';
  } else if (mode === 'telegram') {
    primary = 'telegram';
  } else {
    primary = primary || db.getSetting('primary_provider') || config.PRIMARY_PROVIDER || 'telegram';
  }
  if (!PROVIDERS.has(primary)) return res.status(400).json({ error: 'Invalid primary provider' });

  if (primary === 'discord' && !isDiscordEnabled && isTelegramEnabled) primary = 'telegram';
  if (primary === 'telegram' && !isTelegramEnabled && isDiscordEnabled) primary = 'discord';

  const fileId = uuidv4();
  const finalName = fileName;

  try {
    const result = await uploadQueue.run(req.user.id, async () => {
      const plainBuffer = await fs.promises.readFile(req.file.path);
      const isEnc = db.getSetting('encryption_enabled', req.user.id) !== 'false';
      const encResult = cryptoModule.encryptChunkBuffer(
        plainBuffer,
        req.user.encryption_key,
        fileId,
        0,
        isEnc
      );
      const remoteFileName = formatRemoteFileName(
        fileName,
        req.user.file_prefix,
        0,
        1,
        isEnc
      );
    // 2. Upload with automatic failover
    const uploadResult = await storageManager.uploadChunkWithFailover(
      primary,
      encResult.ciphertext,
      remoteFileName
    );

    const actualPrimary = uploadResult.provider || primary;

    // 3. If dual mode and parallel strategy, also upload to secondary directly
    let secondaryResult = null;
    const secondary = actualPrimary === 'discord' ? 'telegram' : 'discord';
    const activeUploadStrategy = db.getSetting('upload_strategy') || config.UPLOAD_STRATEGY || 'primary_first';
    if (mode === 'dual' && (activeUploadStrategy === 'simultaneous' || activeUploadStrategy === 'parallel_both')) {
      try {
        secondaryResult = await storageManager.uploadChunk(
          secondary,
          encResult.ciphertext,
          remoteFileName
        );
      } catch (secErr) {
        console.warn(`[Files] Secondary upload to ${secondary} failed:`, secErr.message);
      }
    }

    const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
    const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';
    const isBothUploaded = mode === 'dual' && secondaryResult !== null;

    let discordStatus = 'none';
    let telegramStatus = 'none';
    let repStatus = 'completed';

    if (mode === 'dual' && isDiscordEnabled && isTelegramEnabled) {
      discordStatus = (actualPrimary === 'discord' || isBothUploaded) ? 'completed' : 'pending';
      telegramStatus = (actualPrimary === 'telegram' || isBothUploaded) ? 'completed' : 'pending';
      repStatus = isBothUploaded ? 'completed' : 'pending';
    } else if (mode === 'discord' || (!isTelegramEnabled && isDiscordEnabled)) {
      discordStatus = 'completed';
      telegramStatus = 'none';
      repStatus = 'completed';
    } else if (mode === 'telegram' || (!isDiscordEnabled && isTelegramEnabled)) {
      telegramStatus = 'completed';
      discordStatus = 'none';
      repStatus = 'completed';
    }

    // 4. Create database records
    const newFile = {
      id: fileId,
      user_id: req.user.id,
      name: finalName,
      mime_type: req.file.mimetype || getMimeType(finalName),
      size: fileSize,
      folder_id: (folderId === 'null' || folderId === 'root' || !folderId) ? null : folderId,
      storage_mode: mode,
      primary_provider: actualPrimary,
      discord_status: discordStatus,
      telegram_status: telegramStatus,
      replication_status: repStatus,
      iv: encResult.iv,
      salt: cryptoModule.MASTER_SALT_DEFAULT,
      auth_tag: encResult.authTag,
      sha256: encResult.sha256,
      is_starred: 0,
      is_trashed: 0,
      is_chunked: 0,
      total_chunks: 1,
      encryption_enabled: isEnc ? 1 : 0
    };

    db.createFile(newFile);

    const chunkId = uuidv4();
    db.addFileChunk({
      id: chunkId,
      file_id: fileId,
      chunk_index: 0,
      size: fileSize,
      iv: encResult.iv,
      salt: cryptoModule.MASTER_SALT_DEFAULT,
      auth_tag: encResult.authTag,
      sha256: encResult.sha256,
      crypto_version: isEnc ? 2 : 0
    });

    db.addChunkReplica({
      id: uuidv4(),
      chunk_id: chunkId,
      file_id: fileId,
      chunk_index: 0,
      provider: actualPrimary,
      remote_id: uploadResult.remoteId,
      remote_channel_id: uploadResult.channelId || null,
      status: 'completed'
    });

    if (secondaryResult) {
      db.addChunkReplica({
        id: uuidv4(),
        chunk_id: chunkId,
        file_id: fileId,
        chunk_index: 0,
        provider: secondary,
        remote_id: secondaryResult.remoteId,
        remote_channel_id: secondaryResult.channelId || null,
        status: 'completed'
      });
    }

    db.updateUser(req.user.id, {
      storage_used: (req.user.storage_used || 0) + fileSize
    });

    // Enqueue background replication only if dual mode and secondary provider is ENABLED
    if (mode === 'dual' && !isBothUploaded && isDiscordEnabled && isTelegramEnabled) {
      replicationWorker.enqueueFileReplication(fileId, secondary, actualPrimary);
    }

    const savedFile = db.getFileById(fileId, req.user.id);
    eventBroadcaster.broadcast('file_uploaded', { file: savedFile, userId: req.user.id }, req.user.id);

    return {
      success: true,
      file: savedFile
    };
    });
    return res.json(result);
  } catch (err) {
    console.error(`[Files] Single upload failed:`, err.message);
    notifySecurityEvent('Upload failure', { user: req.user.email, ip: req.ip, error: err.message });
    const status = err instanceof UploadQueueFullError ? 429 : 500;
    res.status(status).json({ error: err.message || `Upload failed: ${err.message}`, retryAfter: status === 429 ? 5 : undefined });
  } finally {
    if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

// ─── Download & Stream (with Instant Multi-Provider Failover) ───────────────

router.get('/:id/download', async (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!requireUnlockedFile(req, res, file)) return;
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'FILE_DOWNLOAD', details: { fileId: file.id, fileName: file.name }, ipAddress: req.ip, userAgent: req.get('User-Agent') });

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).json({
      error: 'All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings to download files.'
    });
  }

  try {
    const chunks = db.getAllFileChunksWithReplicas(file.id);
    if (!chunks || chunks.length === 0) {
      return res.status(404).json({ error: 'No chunks found for this file' });
    }

    // Check if at least one replica is on an enabled provider
    const hasEnabledReplica = chunks.every(chunk =>
      chunk.replicas && chunk.replicas.some(r => db.getSetting(`${r.provider}_enabled`) !== 'false')
    );

    if (!hasEnabledReplica) {
      return res.status(400).json({
        error: 'The storage provider(s) holding this file are currently in Standby / Disabled mode. Please enable the appropriate provider in Settings to download.'
      });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    setContentDisposition(res, file.name, 'attachment');
    res.setHeader('Content-Length', file.size);

    for (const chunk of chunks) {
      const downloaded = await storageManager.downloadChunkWithFailover(
        chunk.replicas,
        file.primary_provider
      );

      // Decrypt chunk buffer (or return raw bytes if unencrypted)
      const decrypted = cryptoModule.decryptChunkBuffer(
        downloaded.buffer,
        req.user.encryption_key,
        file.id,
        chunk.chunk_index,
        chunk.iv,
        chunk.auth_tag,
        chunk.crypto_version !== undefined ? chunk.crypto_version : 2
      );

      res.write(decrypted);
    }
    res.end();
  } catch (err) {
    console.error(`[Files] Download failed for ${id}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Download failed: ${err.message}` });
    }
  }
});

// Streaming (Range Request Support for Media Player)
router.get('/:id/stream', async (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).send('File not found');
  if (!requireUnlockedFile(req, res, file)) return;
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'FILE_VIEW', details: { fileId: file.id, fileName: file.name, access: 'stream' }, ipAddress: req.ip, userAgent: req.get('User-Agent') });

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).send('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings.');
  }

  const mimeType = file.mime_type || 'application/octet-stream';
  const totalSize = Number(file.size);
  const rangeHeader = req.headers.range;

  try {
    const chunks = db.getAllFileChunksWithReplicas(file.id);
    if (!chunks || chunks.length === 0 || !Number.isSafeInteger(totalSize) || totalSize <= 0) {
      return res.status(404).send('No streamable file chunks found');
    }

    // Discord attachments are served from a CDN and are noticeably faster for
    // interactive media preview. Use them when a completed replica exists;
    // downloadChunkWithFailover still falls back to the file's other replica.
    const hasDiscordReplicas = chunks.every(chunk =>
      (chunk.replicas || []).some(replica => replica.provider === 'discord' && replica.status === 'completed')
    );
    const streamPreferredProvider = hasDiscordReplicas ? 'discord' : file.primary_provider;

    // Do not assemble the entire decrypted video in RAM before responding. A
    // media element normally asks for only a byte range, so fetch/decrypt just
    // the chunks that overlap that range and start sending as soon as possible.
    let start = 0;
    let end = totalSize - 1;
    let statusCode = 200;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (!match) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      if (match[1] === '' && match[2] !== '') {
        const suffixLength = Number(match[2]);
        start = Math.max(0, totalSize - suffixLength);
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? totalSize - 1 : Math.min(Number(match[2]), totalSize - 1);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      statusCode = 206;
    }

    const contentLength = end - start + 1;
    const responseHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Type': mimeType
    };
    if (statusCode === 206) responseHeaders['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    res.writeHead(statusCode, responseHeaders);

    const getDecryptedChunk = async (chunk) => {
      let plain = cacheManager.get(file.id, chunk.chunk_index);
      if (plain) return plain;

      const candidates = (chunk.replicas || [])
        .filter(replica => replica.status === 'completed')
        .sort((a, b) => (a.provider === streamPreferredProvider ? -1 : 0) - (b.provider === streamPreferredProvider ? -1 : 0));
      if (candidates.length === 0) throw new Error(`No completed replicas for stream chunk ${chunk.chunk_index}`);

      // Preview is latency-sensitive. A stale replica should not hold the
      // browser hostage while another completed replica is available.
      const downloaded = candidates.length === 1
        ? await storageManager.downloadChunkWithFailover(candidates, streamPreferredProvider)
        : await Promise.any(candidates.map(async replica => {
          const provider = storageManager.getProvider(replica.provider);
          if (!provider.isInitialized) await provider.initialize();
          return {
            buffer: await provider.downloadChunk(replica.remote_id),
            provider: replica.provider
          };
        }));
      plain = cryptoModule.decryptChunkBuffer(
        downloaded.buffer,
        req.user.encryption_key,
        file.id,
        chunk.chunk_index,
        chunk.iv,
        chunk.auth_tag,
        chunk.crypto_version !== undefined ? chunk.crypto_version : 2
      );
      cacheManager.set(file.id, plain, chunk.chunk_index);
      return plain;
    };

    const streamUnencryptedChunk = async (chunk, replica, from, to) => {
      const provider = storageManager.getProvider(replica.provider);
      if (typeof provider.iterDownloadChunk !== 'function') return false;
      if (!provider.isInitialized) await provider.initialize();

      let remoteOffset = 0;
      for await (const remotePart of provider.iterDownloadChunk(replica.remote_id)) {
        const partEnd = remoteOffset + remotePart.length - 1;
        if (partEnd >= from && remoteOffset <= to) {
          const partFrom = Math.max(0, from - remoteOffset);
          const partTo = Math.min(remotePart.length - 1, to - remoteOffset);
          if (partTo >= partFrom) await writeWithBackpressure(remotePart.subarray(partFrom, partTo + 1));
        }
        remoteOffset += remotePart.length;
        if (remoteOffset > to || res.destroyed) break;
      }
      return true;
    };

    const writeWithBackpressure = (buffer) => {
      if (res.write(buffer)) return Promise.resolve();
      return new Promise(resolve => res.once('drain', resolve));
    };

    let chunkOffset = 0;
    for (const chunk of chunks) {
      const declaredChunkSize = Number(chunk.size);
      if (!Number.isSafeInteger(declaredChunkSize) || declaredChunkSize <= 0) {
        throw new Error(`Invalid size metadata for stream chunk ${chunk.chunk_index}`);
      }
      const chunkEnd = chunkOffset + declaredChunkSize - 1;
      if (chunkEnd < start) {
        chunkOffset += declaredChunkSize;
        continue;
      }
      if (chunkOffset > end || res.destroyed) break;

      const from = Math.max(0, start - chunkOffset);
      const to = Math.min(declaredChunkSize - 1, end - chunkOffset);

      // Unencrypted media can be sent directly from Telegram's iterator,
      // allowing playback to begin before the complete chunk is buffered.
      const rawReplica = file.encryption_enabled === 0
        ? (chunk.replicas || []).find(replica => replica.provider === 'telegram' && replica.status === 'completed')
        : null;
      if (rawReplica && to >= from && await streamUnencryptedChunk(chunk, rawReplica, from, to)) {
        chunkOffset += declaredChunkSize;
        continue;
      }

      const plain = await getDecryptedChunk(chunk);
      const plainTo = Math.min(plain.length - 1, end - chunkOffset);
      if (plainTo >= from) await writeWithBackpressure(plain.subarray(from, plainTo + 1));
      chunkOffset += declaredChunkSize;
    }

    if (!res.destroyed) res.end();
  } catch (err) {
    console.error(`[Files] Stream error for ${id}:`, err.message);
    if (!res.headersSent) res.status(500).send(`Stream error: ${err.message}`);
  }
});

// ─── Thumbnail Serving & Upload ─────────────────────────────────────────────

// GET Thumbnail (supports browser caching, on-demand image decryption)
router.get('/:id/thumbnail', async (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).send('File not found');
  if (!requireUnlockedFile(req, res, file)) return;
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'FILE_VIEW', details: { fileId: file.id, fileName: file.name, access: 'thumbnail' }, ipAddress: req.ip, userAgent: req.get('User-Agent') });

  const thumbJpg = path.join(config.THUMBNAILS_DIR, `${file.id}.jpg`);
  const thumbWebp = path.join(config.THUMBNAILS_DIR, `${file.id}.webp`);
  const thumbPng = path.join(config.THUMBNAILS_DIR, `${file.id}.png`);
  const encryptedThumb = path.join(config.THUMBNAILS_DIR, `${file.id}.thumb`);
  const encryptedThumbMeta = path.join(config.THUMBNAILS_DIR, `${file.id}.thumb.json`);
  const setThumbnailCacheHeaders = () => {
    // Thumbnails are account-scoped; shared proxies must not reuse them across
    // signed-in users, but a browser can safely cache its own preview.
    res.setHeader('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('Vary', 'Cookie');
  };

  // Video previews are generated in the uploader's browser. Persist them
  // encrypted at rest so every device on the same account sees the result,
  // without enabling the plaintext file cache.
  if (fs.existsSync(encryptedThumb) && fs.existsSync(encryptedThumbMeta)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(encryptedThumbMeta, 'utf8'));
      const thumbnail = cryptoModule.decryptChunkBuffer(
        fs.readFileSync(encryptedThumb),
        req.user.encryption_key,
        `thumbnail:${file.id}`,
        0,
        metadata.iv,
        metadata.authTag,
        metadata.cryptoVersion
      );
      res.setHeader('Content-Type', metadata.contentType || 'image/jpeg');
      setThumbnailCacheHeaders();
      return res.end(thumbnail);
    } catch (err) {
      console.warn(`[Files] Encrypted thumbnail read failed for ${id}:`, err.message);
    }
  }

  if (cacheManager.enabled && fs.existsSync(thumbJpg)) {
    res.setHeader('Content-Type', 'image/jpeg');
    setThumbnailCacheHeaders();
    return fs.createReadStream(thumbJpg).pipe(res);
  }
  if (cacheManager.enabled && fs.existsSync(thumbWebp)) {
    res.setHeader('Content-Type', 'image/webp');
    setThumbnailCacheHeaders();
    return fs.createReadStream(thumbWebp).pipe(res);
  }
  if (cacheManager.enabled && fs.existsSync(thumbPng)) {
    res.setHeader('Content-Type', 'image/png');
    setThumbnailCacheHeaders();
    return fs.createReadStream(thumbPng).pipe(res);
  }

  // If this is an image file, dynamically decrypt and cache thumbnail
  const mime = (file.mime_type || '').toLowerCase();
  if (mime.startsWith('image/')) {
    try {
      let cached = cacheManager.get(file.id);
      if (!cached) {
        const chunks = db.getAllFileChunksWithReplicas(file.id);
        if (chunks && chunks.length > 0) {
          const chunk0 = chunks[0];
          const downloaded = await storageManager.downloadChunkWithFailover(
            chunk0.replicas,
            file.primary_provider
          );
          const decrypted = cryptoModule.decryptChunkBuffer(
            downloaded.buffer,
            req.user.encryption_key,
            file.id,
            chunk0.chunk_index,
            chunk0.iv,
            chunk0.auth_tag,
            chunk0.crypto_version !== undefined ? chunk0.crypto_version : 2
          );

          if (chunks.length === 1) {
            cached = decrypted;
            cacheManager.set(file.id, cached);
            try {
              if (!cacheManager.enabled) throw new Error('Plaintext thumbnail cache disabled');
              if (!fs.existsSync(config.THUMBNAILS_DIR)) {
                fs.mkdirSync(config.THUMBNAILS_DIR, { recursive: true });
              }
              fs.writeFileSync(thumbJpg, cached);
            } catch (wErr) {}
          } else {
            cached = decrypted;
          }
        }
      }

      if (cached) {
        res.setHeader('Content-Type', file.mime_type || 'image/jpeg');
        setThumbnailCacheHeaders();
        return res.end(cached);
      }
    } catch (err) {
      console.warn(`[Files] Image thumbnail dynamic extraction failed for ${id}:`, err.message);
    }
  }

  return res.status(404).send('Thumbnail not available');
});

// POST Upload Thumbnail (Client-generated video / image canvas thumbnail)
router.post('/:id/thumbnail', async (req, res) => {
  const { id } = req.params;
  const { thumbnail } = req.body;
  if (!thumbnail || typeof thumbnail !== 'string') {
    return res.status(400).json({ error: 'Thumbnail base64 is required' });
  }

  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  try {
    if (!fs.existsSync(config.THUMBNAILS_DIR)) {
      fs.mkdirSync(config.THUMBNAILS_DIR, { recursive: true });
    }

    const matches = thumbnail.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let buffer;
    let contentType = 'image/jpeg';
    if (matches && matches.length === 3) {
      contentType = matches[1].toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        return res.status(400).json({ error: 'Thumbnail must be a JPEG, PNG, or WebP image' });
      }
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(thumbnail, 'base64');
    }
    if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Thumbnail must be between 1 byte and 2 MB' });
    }

    const encrypted = cryptoModule.encryptChunkBuffer(
      buffer,
      req.user.encryption_key,
      `thumbnail:${file.id}`,
      0,
      true
    );
    const thumbPath = path.join(config.THUMBNAILS_DIR, `${file.id}.thumb`);
    const thumbMetaPath = path.join(config.THUMBNAILS_DIR, `${file.id}.thumb.json`);
    fs.writeFileSync(thumbPath, encrypted.ciphertext);
    fs.writeFileSync(thumbMetaPath, JSON.stringify({
      contentType,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      cryptoVersion: encrypted.crypto_version
    }));

    res.json({ success: true, thumbnail: `/api/files/${file.id}/thumbnail` });
  } catch (err) {
    console.error(`[Files] Save thumbnail error for ${id}:`, err);
    res.status(500).json({ error: 'Failed to save thumbnail' });
  }
});

// ─── Replication & Repair Actions ───────────────────────────────────────────

// Replicate file to specified target provider
router.post('/:id/replicate', async (req, res) => {
  const { id } = req.params;
  const { targetProvider } = req.body;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const target = targetProvider || (file.primary_provider === 'discord' ? 'telegram' : 'discord');
  replicationWorker.enqueueFileReplication(file.id, target, file.primary_provider);

  res.json({
    success: true,
    message: `Replication to ${target} started in background.`
  });
});

// Repair desynced or damaged replicas
router.post('/:id/repair', async (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Re-enqueue replication for both providers where replicas are missing
  replicationWorker.enqueueFileReplication(file.id, 'discord');
  replicationWorker.enqueueFileReplication(file.id, 'telegram');

  res.json({
    success: true,
    message: 'Repair verification jobs enqueued.'
  });
});

// Get Replica Breakdown for Backup Status Modal
router.get('/:id/replicas', (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const chunks = db.getAllFileChunksWithReplicas(file.id);
  const jobs = db.getReplicationJobsByFile(file.id);

  res.json({
    success: true,
    file,
    chunks,
    pendingJobs: jobs
  });
});

// ─── File CRUD & State Actions ──────────────────────────────────────────────

// Toggle Star
router.post('/:id/star', (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const newStarred = file.is_starred ? 0 : 1;
  const updated = db.updateFile(file.id, { is_starred: newStarred }, req.user.id);
  res.json({ success: true, file: updated });
});

// Trash File
router.post('/:id/trash', (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const updated = db.updateFile(file.id, {
    is_trashed: 1,
    trashed_at: new Date().toISOString()
  }, req.user.id);

  res.json({ success: true, file: updated });
});

// Restore File from Trash
router.post('/:id/restore', (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const updated = db.updateFile(file.id, {
    is_trashed: 0,
    trashed_at: null
  }, req.user.id);

  res.json({ success: true, file: updated });
});

// Rename / Update File (PUT)
router.put('/:id', (req, res) => {
  const { name, folderId, folder_id, is_starred, isStarred } = req.body;
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const updates = {};
  if (name !== undefined) updates.name = decodeUtf8FileName(name);
  const fid = folder_id !== undefined ? folder_id : folderId;
  if (fid !== undefined) updates.folder_id = (fid === 'null' || fid === 'root' || !fid) ? null : fid;
  const star = is_starred !== undefined ? is_starred : isStarred;
  if (star !== undefined) updates.is_starred = star ? 1 : 0;

  const updated = db.updateFile(file.id, updates, req.user.id);
  res.json({ success: true, file: updated });
});

// Rename / Update File (PATCH)
router.patch('/:id', (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const { name, folder_id, folderId, is_starred, isStarred } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = decodeUtf8FileName(name);
  const fid = folder_id !== undefined ? folder_id : folderId;
  if (fid !== undefined) updates.folder_id = (fid === 'null' || fid === 'root' || !fid) ? null : fid;
  const star = is_starred !== undefined ? is_starred : isStarred;
  if (star !== undefined) updates.is_starred = star ? 1 : 0;

  const updated = db.updateFile(file.id, updates, req.user.id);
  res.json(updated);
});

// Helper for permanent file deletion
async function permanentlyDeleteFile(file, options = {}) {
  if (!file || !file.id) return { success: false };
  // Immediately cancel any pending or in-flight replication jobs
  replicationWorker.cancelFileReplication(file.id);

  const replicas = db.getFileReplicas(file.id);
  if (replicas && replicas.length > 0) {
    try {
      await storageManager.deleteChunkReplicas(replicas);
    } catch (err) {
      console.warn(`[Files] Physical delete error for file ${file.id}:`, err.message);
    }
  }
  db.deleteFilePermanently(file.id, file.user_id);
  if (file.user_id) db.recalculateUserStorage(file.user_id);
  return { success: true };
}

// Soft Delete (move to Trash)
router.delete('/:id', (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  // Cancel any ongoing replication tasks for this file
  replicationWorker.cancelFileReplication(file.id);

  // If permanent query param is true, do permanent delete
  if (req.query.permanent === 'true') {
    permanentlyDeleteFile(file).then(() => {
      res.json({ success: true, message: 'File permanently deleted' });
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
    return;
  }

  db.updateFile(file.id, { is_trashed: 1, trashed_at: new Date().toISOString() }, req.user.id);
  db.recalculateUserStorage(req.user.id);
  res.json({ success: true, message: 'File moved to trash' });
});

// Permanent Delete
router.delete('/:id/permanent', async (req, res) => {
  const file = db.getFileById(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  await permanentlyDeleteFile(file);
  res.json({ success: true, message: 'File permanently deleted' });
});

// Empty Trash (Guaranteed Cloud-first deletion, then Database)
router.delete('/trash/empty', async (req, res) => {
  try {
    const trashedFiles = db.getAllTrashedFiles(req.user.id);
    const trashedFolders = db.getAllTrashedFolders(req.user.id);
    const totalCount = trashedFiles.length + trashedFolders.length;

    if (totalCount === 0) {
      return res.json({ success: true, count: 0 });
    }

    // 1. Gather all chunk replicas across all trashed files
    const allReplicas = [];
    for (const file of trashedFiles) {
      replicationWorker.cancelFileReplication(file.id);
      const fileReplicas = db.getFileReplicas(file.id);
      if (fileReplicas && fileReplicas.length > 0) {
        allReplicas.push(...fileReplicas);
      }
    }

    // 2. Physical deletion from Telegram & Discord cloud FIRST (in fast 100-item slices)
    if (allReplicas.length > 0) {
      await storageManager.deleteChunksBulk(allReplicas);
    }

    // 3. ONLY after cloud deletion completes, delete records from DB
    for (const file of trashedFiles) {
      db.deleteFilePermanently(file.id, req.user.id);
    }
    for (const folder of trashedFolders) {
      db.deleteFolder(folder.id, req.user.id);
    }

    db.recalculateUserStorage(req.user.id);
    eventBroadcaster.broadcast('trash_emptied', { userId: req.user.id }, req.user.id);

    // 4. Return confirmed success response to client
    res.json({ success: true, count: totalCount });
  } catch (error) {
    console.error('[Files] Empty trash error:', error);
    res.status(500).json({ error: 'Failed to empty trash: ' + error.message });
  }
});

// Check Duplicate
router.post('/check-duplicate', (req, res) => {
  const { sha256, size, fileName } = req.body;
  if (!sha256) return res.json({ isDuplicate: false });
  const existing = db.get(
    'SELECT id, name, size, mime_type, folder_id, created_at FROM files WHERE user_id = ? AND sha256 = ? AND is_trashed = 0 LIMIT 1',
    [req.user.id, String(sha256).toLowerCase()]
  );
  res.json({ isDuplicate: !!existing, existingFile: existing || null });
});

// ─── Batch Operations ───────────────────────────────────────────────────────

const handleBatchTrash = async (req, res) => {
  const { fileIds = [], folderIds = [] } = req.body;
  const now = new Date().toISOString();
  let trashedFilesCount = 0;
  let trashedFoldersCount = 0;

  for (const id of fileIds) {
    db.updateFile(id, { is_trashed: 1, trashed_at: now }, req.user.id);
    trashedFilesCount++;
  }

  const foldersRouter = require('./folders');
  for (const fId of folderIds) {
    if (foldersRouter.deleteFolderRecursive) {
      const r = await foldersRouter.deleteFolderRecursive(fId, req.user.id);
      trashedFilesCount += r.deletedFiles || 0;
      trashedFoldersCount += r.deletedFolders || 0;
    } else {
      db.updateFolder(fId, { is_trashed: 1, trashed_at: now }, req.user.id);
      trashedFoldersCount++;
    }
  }

  db.recalculateUserStorage(req.user.id);
  res.json({ success: true, trashedFilesCount, trashedFoldersCount });
};
router.post('/batch-trash', handleBatchTrash);
router.post('/batch/trash', handleBatchTrash);

const handleBatchRestore = async (req, res) => {
  const { fileIds = [], folderIds = [] } = req.body;
  let restoredFilesCount = 0;
  let restoredFoldersCount = 0;

  for (const id of fileIds) {
    db.updateFile(id, { is_trashed: 0, trashed_at: null }, req.user.id);
    restoredFilesCount++;
  }
  const foldersRouter = require('./folders');
  for (const id of folderIds) {
    if (foldersRouter.restoreFolderRecursive) {
      const r = await foldersRouter.restoreFolderRecursive(id, req.user.id);
      restoredFilesCount += r.restoredFiles || 0;
      restoredFoldersCount += r.restoredFolders || 0;
    } else {
      db.updateFolder(id, { is_trashed: 0, trashed_at: null }, req.user.id);
      restoredFoldersCount++;
    }
  }

  db.recalculateUserStorage(req.user.id);
  res.json({ success: true, restoredCount: restoredFilesCount + restoredFoldersCount, restoredFilesCount, restoredFoldersCount });
};
router.post('/batch-restore', handleBatchRestore);
router.post('/batch/restore', handleBatchRestore);

const handleBatchDelete = async (req, res) => {
  const { fileIds = [], folderIds = [] } = req.body;
  let deletedFilesCount = 0;
  let deletedFoldersCount = 0;
  const allReplicas = [];
  const filesToDelete = [];

  // 1. Gather all file IDs to delete
  for (const id of fileIds) {
    const file = db.getFileById(id, req.user.id);
    if (file) {
      replicationWorker.cancelFileReplication(file.id);
      const replicas = db.getFileReplicas(file.id);
      if (replicas && replicas.length > 0) {
        allReplicas.push(...replicas);
      }
      filesToDelete.push(file);
      deletedFilesCount++;
    }
  }

  // Helper to gather all files in folders
  const collectFolderFiles = (fId) => {
    const subfolders = db.getFoldersByParent(fId, req.user.id, true);
    for (const sub of subfolders) {
      collectFolderFiles(sub.id);
    }
    const files = db.getFilesByFolder(fId, req.user.id, true);
    for (const file of files) {
      replicationWorker.cancelFileReplication(file.id);
      const replicas = db.getFileReplicas(file.id);
      if (replicas && replicas.length > 0) {
        allReplicas.push(...replicas);
      }
      filesToDelete.push(file);
      deletedFilesCount++;
    }
  };

  const deleteFolderDb = (fId) => {
    const subfolders = db.getFoldersByParent(fId, req.user.id, true);
    for (const sub of subfolders) {
      deleteFolderDb(sub.id);
    }
    db.deleteFolder(fId, req.user.id);
    deletedFoldersCount++;
  };

  for (const id of folderIds) {
    collectFolderFiles(id);
  }

  // 2. Physical deletion from Telegram & Discord cloud FIRST via bulk batches
  if (allReplicas.length > 0) {
    await storageManager.deleteChunksBulk(allReplicas);
  }

  // 3. ONLY after cloud deletion completes, delete records from DB
  for (const file of filesToDelete) {
    db.deleteFilePermanently(file.id, req.user.id);
  }
  for (const id of folderIds) {
    deleteFolderDb(id);
  }

  db.recalculateUserStorage(req.user.id);
  eventBroadcaster.broadcast('items_deleted', { fileIds, folderIds, userId: req.user.id }, req.user.id);

  res.json({ success: true, deletedFilesCount, deletedFoldersCount, fileIds, folderIds });
};
router.post('/batch-delete', handleBatchDelete);
router.post('/batch/delete', handleBatchDelete);

router.post('/batch-star', (req, res) => {
  const { fileIds = [], isStarred = true } = req.body;
  const starVal = isStarred ? 1 : 0;
  let updatedCount = 0;

  for (const id of fileIds) {
    db.updateFile(id, { is_starred: starVal }, req.user.id);
    updatedCount++;
  }

  res.json({ success: true, updatedCount });
});

router.post('/batch-move', (req, res) => {
  const { fileIds = [], folderIds = [], targetFolderId = null } = req.body;
  const dest = (targetFolderId && targetFolderId !== 'null' && targetFolderId !== 'root') ? targetFolderId : null;
  let movedFilesCount = 0;
  let movedFoldersCount = 0;

  for (const id of fileIds) {
    db.updateFile(id, { folder_id: dest }, req.user.id);
    movedFilesCount++;
  }
  for (const id of folderIds) {
    if (dest !== id) {
      db.updateFolder(id, { parent_id: dest }, req.user.id);
      movedFoldersCount++;
    }
  }

  res.json({ success: true, movedFilesCount, movedFoldersCount });
});

function getMimeType(fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/m4a', flac: 'audio/flac',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip', rar: 'application/x-rar-compressed', '7z': 'application/x-7z-compressed', tar: 'application/x-tar'
  };
  return map[ext] || 'application/octet-stream';
}

router.permanentlyDeleteFile = permanentlyDeleteFile;

// Clean up expired/abandoned upload sessions older than 24 hours
async function cleanupExpiredUploadSessions(maxAgeHours = 24) {
  try {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const expiredSessions = db.all('SELECT id FROM upload_sessions WHERE created_at < ?', [cutoff]) || [];
    for (const s of expiredSessions) {
      const sessionChunks = db.all('SELECT provider, remote_id FROM upload_session_chunks WHERE session_id = ?', [s.id]) || [];
      if (sessionChunks.length > 0) {
        await storageManager.deleteChunkReplicas(sessionChunks).catch(() => {});
      }
      db.run('DELETE FROM upload_session_chunks WHERE session_id = ?', [s.id]);
      db.run('DELETE FROM upload_sessions WHERE id = ?', [s.id]);
    }
  } catch (err) {
    console.warn('[Files] Upload session cleanup warning:', err.message);
  }
}

// Run cleanup immediately on load and every 6 hours
cleanupExpiredUploadSessions(24).catch(() => {});
setInterval(() => cleanupExpiredUploadSessions(24).catch(() => {}), 6 * 60 * 60 * 1000);

router.cleanupExpiredUploadSessions = cleanupExpiredUploadSessions;

module.exports = router;
