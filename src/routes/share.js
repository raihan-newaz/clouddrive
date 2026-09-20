const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const storageManager = require('../storage/StorageManager');
const cacheManager = require('../services/cacheManager');
const cryptoModule = require('../crypto');
const authMiddleware = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { shareLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
router.use('/public', shareLimiter);

function denyBlockedIp(req, res) {
  if (db.isIpBlocked && db.isIpBlocked(req.ip)) {
    db.logAuditEvent({ action: 'SHARE_BLOCKED_IP', ipAddress: req.ip, userAgent: req.get('User-Agent'), details: { path: req.path } });
    res.status(403).json({ error: 'Access denied from this IP address' });
    return true;
  }
  return false;
}

function generateShareToken(fileId, shareToken) {
  const secret = config.JWT_SECRET;
  return crypto.createHmac('sha256', secret).update(`share_access:${fileId}:${shareToken}`).digest('hex');
}

function verifyShareAccess(file, token, req) {
  if (!file.share_password) return true;
  const accessKey = req.headers['x-share-key'] || req.query.key || req.query.shareKey;
  if (accessKey) {
    const expected = generateShareToken(file.id, token);
    const actual = Buffer.from(String(accessKey));
    const wanted = Buffer.from(expected);
    if (actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted)) return true;
  }
  return false;
}

function setContentDisposition(res, filename, type = 'attachment') {
  const cleanName = filename || 'file';
  const safeAscii = cleanName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  const utf8Encoded = encodeURIComponent(cleanName).replace(/['()]/g, escape);
  res.setHeader('Content-Disposition', `${type}; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`);
}

// Generate Share Link (User Authenticated)
router.post('/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { password, expiresDays } = req.body;

  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const shareToken = crypto.randomBytes(16).toString('hex');
  let passwordHash = null;
  if (password && password.trim().length > 0) {
    passwordHash = await bcrypt.hash(password.trim(), 10);
  }

  let expiresAt = null;
  if (expiresDays && parseInt(expiresDays, 10) > 0) {
    expiresAt = new Date(Date.now() + parseInt(expiresDays, 10) * 24 * 60 * 60 * 1000).toISOString();
  }

  db.updateFile(file.id, {
    is_shared: 1,
    share_token: shareToken,
    share_password: passwordHash,
    share_expires_at: expiresAt,
    share_views: 0,
    share_downloads: 0
  }, req.user.id);

  res.json({
    success: true,
    shareToken,
    shareUrl: `/share/${shareToken}`
  });
});

// Revoke Share Link
router.delete('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const file = db.getFileById(id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.updateFile(file.id, {
    is_shared: 0,
    share_token: null,
    share_password: null,
    share_expires_at: null
  }, req.user.id);

  res.json({ success: true, message: 'Share link revoked' });
});

// Authenticated Share Status
router.get('/file/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = db.getFileById(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const shareUrl = file.share_token ? `${protocol}://${host}/share/${file.share_token}` : null;

    res.json({
      success: true,
      fileId: file.id,
      id: file.id,
      fileName: file.name,
      name: file.name,
      fileSize: file.size,
      size: file.size,
      mimeType: file.mime_type,
      mime_type: file.mime_type,
      isShared: Boolean(file.is_shared),
      is_shared: Boolean(file.is_shared),
      shareToken: file.share_token || null,
      share_token: file.share_token || null,
      shareUrl,
      share_url: shareUrl,
      hasPassword: Boolean(file.share_password),
      has_password: Boolean(file.share_password),
      expiresAt: file.share_expires_at || null,
      share_expires_at: file.share_expires_at || null,
      views: file.share_views || 0,
      share_views: file.share_views || 0,
      downloads: file.share_downloads || 0,
      share_downloads: file.share_downloads || 0
    });
  } catch (err) {
    console.error('[Share] Get status error:', err);
    res.status(500).json({ error: 'Failed to retrieve share status' });
  }
});

// Update Share Settings
router.post('/file/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = db.getFileById(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const isShared = req.body.isShared !== undefined ? req.body.isShared : req.body.is_shared;
    const password = req.body.password;
    let expiresInDays = undefined;
    if (req.body.expiresInDays !== undefined) {
      expiresInDays = req.body.expiresInDays;
    } else if (req.body.expires_in_days !== undefined) {
      expiresInDays = req.body.expires_in_days;
    } else if (req.body.expiresDays !== undefined) {
      expiresInDays = req.body.expiresDays;
    }
    const clearPassword = req.body.clearPassword || req.body.clear_password;

    let token = file.share_token;
    if (isShared && !token) {
      token = crypto.randomBytes(16).toString('hex');
    }

    let hashedPassword = file.share_password;
    if (clearPassword || password === null || password === '') {
      hashedPassword = null;
    } else if (typeof password === 'string' && password.trim() !== '') {
      hashedPassword = await bcrypt.hash(password.trim(), 10);
    }

    let expiresAt = file.share_expires_at;
    if (expiresInDays !== undefined) {
      if (expiresInDays === null || expiresInDays === 'never' || expiresInDays === '' || Number(expiresInDays) <= 0) {
        expiresAt = null;
      } else {
        const d = new Date();
        d.setDate(d.getDate() + Number(expiresInDays));
        expiresAt = d.toISOString();
      }
    }

    const updated = db.updateFileShare(fileId, {
      isShared: Boolean(isShared),
      token,
      password: hashedPassword,
      expiresAt
    }, req.user.id) || file;

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const shareUrl = token ? `${protocol}://${host}/share/${token}` : null;

    res.json({
      success: true,
      fileId: updated.id || fileId,
      id: updated.id || fileId,
      isShared: Boolean(updated.is_shared),
      is_shared: Boolean(updated.is_shared),
      shareToken: updated.share_token || token,
      share_token: updated.share_token || token,
      shareUrl,
      share_url: shareUrl,
      hasPassword: Boolean(updated.share_password),
      has_password: Boolean(updated.share_password),
      expiresAt: updated.share_expires_at,
      share_expires_at: updated.share_expires_at,
      views: updated.share_views || 0,
      downloads: updated.share_downloads || 0
    });
  } catch (err) {
    console.error('[Share] Update share error:', err);
    res.status(500).json({ error: 'Failed to update share settings' });
  }
});

// Revoke Share Link
router.delete('/file/:fileId', authMiddleware, (req, res) => {
  try {
    const { fileId } = req.params;
    const file = db.getFileById(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    db.revokeFileShare(fileId, req.user.id);
    res.json({ success: true, message: 'Share link revoked successfully' });
  } catch (err) {
    console.error('[Share] Revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
});

// Public Share Info (Unauthenticated)
router.get('/public/:token', async (req, res) => {
  if (denyBlockedIp(req, res)) return;
  const { token } = req.params;
  const file = db.get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1', [token]);
  if (!file) return res.status(404).json({ error: 'Share link not found or revoked' });

  if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This share link has expired' });
  }

  // Increment view count
  db.run('UPDATE files SET share_views = share_views + 1 WHERE id = ?', [file.id]);
  db.logAuditEvent({
    userId: file.user_id, action: 'SHARE_VIEW',
    details: { fileId: file.id, fileName: file.name, token: token.slice(0, 8) },
    ipAddress: req.ip, userAgent: req.get('User-Agent')
  });

  const hasPassword = Boolean(file.share_password);
  const requiresPassword = hasPassword && !verifyShareAccess(file, token, req);

  res.json({
    success: true,
    requiresPassword,
    hasPassword,
    file: {
      id: file.id,
      name: file.name,
      size: file.size,
      mime_type: file.mime_type,
      hasPassword,
      requiresPassword,
      created_at: file.created_at,
      expiresAt: file.share_expires_at,
      views: (file.share_views || 0) + 1,
      downloads: file.share_downloads || 0
    }
  });
});

// Verify Password for Public Share Link
router.post('/public/:token/verify', authLimiter, async (req, res) => {
  if (denyBlockedIp(req, res)) return;
  const { token } = req.params;
  const { password } = req.body;

  const file = db.get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1', [token]);
  if (!file) return res.status(404).json({ error: 'Share link not found or revoked' });

  if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This share link has expired' });
  }

  if (file.share_password) {
    if (!password) {
      return res.status(401).json({ error: 'Password is required' });
    }
    const match = await bcrypt.compare(password, file.share_password);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
  }

  const accessKey = generateShareToken(file.id, token);
  res.json({
    success: true,
    accessKey,
    file: {
      id: file.id,
      name: file.name,
      size: file.size,
      mime_type: file.mime_type,
      hasPassword: Boolean(file.share_password),
      requiresPassword: false,
      created_at: file.created_at,
      expiresAt: file.share_expires_at,
      views: file.share_views || 0,
      downloads: file.share_downloads || 0
    }
  });
});

// Public Streaming / Preview
router.get('/public/:token/stream', async (req, res) => {
  if (denyBlockedIp(req, res)) return;
  const { token } = req.params;
  const file = db.get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1', [token]);
  if (!file) return res.status(404).send('File not found or share link revoked');

  if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
    return res.status(410).send('This share link has expired');
  }

  if (file.share_password && !verifyShareAccess(file, token, req)) {
    return res.status(401).send('Password required to stream shared file');
  }
  db.logAuditEvent({ userId: file.user_id, action: 'SHARE_FILE_VIEW', details: { fileId: file.id, fileName: file.name, token: token.slice(0, 8), access: 'stream' }, ipAddress: req.ip, userAgent: req.get('User-Agent') });

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).send('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode.');
  }

  const owner = db.getUserById(file.user_id);
  const userKey = owner ? owner.encryption_key : config.ENCRYPTION_KEY;
  const mimeType = file.mime_type || 'application/octet-stream';
  const totalSize = file.size;
  const rangeHeader = req.headers.range;

  try {
    const chunks = db.getAllFileChunksWithReplicas(file.id);
    if (!chunks || chunks.length === 0) {
      return res.status(404).send('No chunks found for this file');
    }

    let cachedBuffer = cacheManager.get(file.id);
    if (!cachedBuffer) {
      const decryptedParts = [];
      for (const chunk of chunks) {
        let chunkPlain = cacheManager.get(file.id, chunk.chunk_index);
        if (!chunkPlain) {
          const downloaded = await storageManager.downloadChunkWithFailover(
            chunk.replicas,
            file.primary_provider
          );
          chunkPlain = cryptoModule.decryptChunkBuffer(
            downloaded.buffer,
            userKey,
            file.id,
            chunk.chunk_index,
            chunk.iv,
            chunk.auth_tag,
            chunk.crypto_version !== undefined ? chunk.crypto_version : 2
          );
          cacheManager.set(file.id, chunkPlain, chunk.chunk_index);
        }
        decryptedParts.push(chunkPlain);
      }
      cachedBuffer = Buffer.concat(decryptedParts);
      cacheManager.set(file.id, cachedBuffer);
    }

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType
      });
      res.end(cachedBuffer.subarray(start, end + 1));
    } else {
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      res.end(cachedBuffer);
    }
  } catch (err) {
    console.error(`[Share] Public stream error for ${token}:`, err.message);
    if (!res.headersSent) res.status(500).send(`Stream error: ${err.message}`);
  }
});

// Helper for Public Download
async function handlePublicDownload(req, res) {
  if (denyBlockedIp(req, res)) return;
  const { token } = req.params;
  const password = req.body?.password;

  const file = db.get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1', [token]);
  if (!file) return res.status(404).json({ error: 'Share link not found or revoked' });

  if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
    return res.status(410).json({ error: 'This share link has expired' });
  }

  if (file.share_password) {
    let authorized = verifyShareAccess(file, token, req);
    if (!authorized && password) {
      const match = await bcrypt.compare(password, file.share_password);
      if (match) authorized = true;
    }
    if (!authorized) {
      return res.status(401).json({ error: 'Incorrect share password' });
    }
  }

  db.logAuditEvent({ userId: file.user_id, action: 'SHARE_FILE_DOWNLOAD', details: { fileId: file.id, fileName: file.name, token: token.slice(0, 8) }, ipAddress: req.ip, userAgent: req.get('User-Agent') });

  const owner = db.getUserById(file.user_id);
  const userKey = owner ? owner.encryption_key : config.ENCRYPTION_KEY;

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    return res.status(400).json({
      error: 'All storage providers (Discord and Telegram) are currently in Standby / Disabled mode.'
    });
  }

  try {
    const chunks = db.getAllFileChunksWithReplicas(file.id);
    if (!chunks || chunks.length === 0) {
      return res.status(404).json({ error: 'No chunks found for this file' });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    setContentDisposition(res, file.name, 'attachment');
    res.setHeader('Content-Length', file.size);

    for (const chunk of chunks) {
      let chunkPlain = cacheManager.get(file.id, chunk.chunk_index);
      if (!chunkPlain) {
        const downloaded = await storageManager.downloadChunkWithFailover(
          chunk.replicas,
          file.primary_provider
        );
        chunkPlain = cryptoModule.decryptChunkBuffer(
          downloaded.buffer,
          userKey,
          file.id,
          chunk.chunk_index,
          chunk.iv,
          chunk.auth_tag,
          chunk.crypto_version !== undefined ? chunk.crypto_version : 2
        );
        cacheManager.set(file.id, chunkPlain, chunk.chunk_index);
      }
      res.write(chunkPlain);
    }

    db.run('UPDATE files SET share_downloads = share_downloads + 1 WHERE id = ?', [file.id]);
    db.logAuditEvent({
      userId: file.user_id, action: 'SHARE_DOWNLOAD',
      details: { fileId: file.id, fileName: file.name, token: token.slice(0, 8) },
      ipAddress: req.ip, userAgent: req.get('User-Agent')
    });
    res.end();
  } catch (err) {
    console.error('[Share] Public download failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: `Download failed: ${err.message}` });
  }
}

router.get('/public/:token/download', authLimiter, handlePublicDownload);
router.post('/public/:token/download', authLimiter, handlePublicDownload);

module.exports = router;
