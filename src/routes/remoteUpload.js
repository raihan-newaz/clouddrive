const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { notifySecurityEvent } = require('../services/notificationService');
const remoteDownloader = require('../services/remoteDownloader');
const gdriveCrawler = require('../services/gdriveCrawler');
const storageManager = require('../storage/StorageManager');
const db = require('../db');
const cryptoModule = require('../crypto');
const config = require('../config');
const { verifyFolderToken } = require('../securityTokens');

const router = express.Router();
router.use(authMiddleware);

// Remote URL or Google Drive Download
router.post('/', async (req, res) => {
  const { url, folderId, storageMode } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let targetUrl = url.trim();
  let fileName = 'downloaded_file';

  let tempPath = null;
  try {
    if (targetUrl.includes('drive.google.com')) {
      const gdrive = await gdriveCrawler.crawlPublicGdriveUrl(targetUrl);
      targetUrl = gdrive.directUrl;
      fileName = `gdrive_${gdrive.id}`;
    } else {
      const urlObj = new URL(targetUrl);
      fileName = path.basename(urlObj.pathname) || 'remote_file';
    }

    tempPath = path.join(config.TMP_DIR, `${uuidv4()}_${fileName}`);
    const downloadResult = await remoteDownloader.downloadRemoteUrl(targetUrl, tempPath);

    const stats = fs.statSync(tempPath);
    const fileId = uuidv4();
    const mode = storageMode || req.user.default_storage_mode || config.DEFAULT_STORAGE_MODE;
    if (!['discord', 'telegram', 'dual'].includes(mode)) throw new Error('Invalid storage mode');
    if (folderId && folderId !== 'null' && folderId !== 'root') {
      const folder = db.getFolderById(folderId, req.user.id);
      if (!folder) throw new Error('Folder not found');
      if ((folder.is_locked || folder.password_hash) && !verifyFolderToken(folder.id, req.user.id, req.headers['x-folder-token'] || req.query.folderToken)) {
        return res.status(403).json({ error: 'Folder password verification required' });
      }
    }
    const preferred = db.getSetting('primary_provider', req.user.id) || config.PRIMARY_PROVIDER || 'telegram';
    const primary = mode === 'discord' || mode === 'telegram' ? mode : preferred;
    const isEnc = (db.getSetting('encryption_enabled', req.user.id) !== 'false');

    // Encrypt file (or pass raw if encryption disabled)
    const encResult = cryptoModule.encryptChunkBuffer(
      fs.readFileSync(tempPath),
      req.user.encryption_key,
      fileId,
      0,
      isEnc
    );

    const prefix = req.user.file_prefix ? req.user.file_prefix.trim() : null;
    let base = fileName.trim().replace(/[\/\\]/g, '_');
    if (prefix && !base.startsWith(`${prefix}_`)) {
      base = `${prefix}_${base}`;
    }
    const ext = isEnc ? '.enc' : '';
    const remoteFileName = `${base}${ext}`;

    const uploadResult = await storageManager.uploadChunkWithFailover(
      primary,
      encResult.ciphertext,
      remoteFileName
    );

    const actualPrimary = uploadResult.provider || primary;

    const newFile = {
      id: fileId,
      user_id: req.user.id,
      name: fileName,
      mime_type: 'application/octet-stream',
      size: stats.size,
      folder_id: (folderId === 'null' || folderId === 'root' || !folderId) ? null : folderId,
      storage_mode: mode,
      primary_provider: actualPrimary,
      discord_status: actualPrimary === 'discord' ? 'completed' : 'none',
      telegram_status: actualPrimary === 'telegram' ? 'completed' : 'none',
      replication_status: mode === 'dual' ? 'pending' : 'completed',
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
      size: encResult.ciphertext.length,
      iv: encResult.iv,
      salt: cryptoModule.MASTER_SALT_DEFAULT,
      auth_tag: encResult.authTag,
      sha256: encResult.sha256
    });

    db.addChunkReplica({
      id: uuidv4(),
      chunk_id: chunkId,
      file_id: fileId,
      chunk_index: 0,
      provider: primary,
      remote_id: uploadResult.remoteId,
      status: 'completed'
    });

    res.json({
      success: true,
      file: db.getFileById(fileId, req.user.id)
    });
  } catch (err) {
    console.error('[RemoteUpload] Error:', err.message);
    notifySecurityEvent('Remote upload failure', { user: req.user.email, ip: req.ip, error: err.message });
    res.status(500).json({ error: `Remote upload failed: ${err.message}` });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

module.exports = router;
