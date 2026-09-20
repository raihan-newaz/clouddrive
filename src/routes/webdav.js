const express = require('express');
const { v4: uuidv4 } = require('uuid');
const webdavAuth = require('../middleware/webdavAuth');
const db = require('../db');
const cryptoModule = require('../crypto');
const storageManager = require('../storage/StorageManager');
const config = require('../config');
const { webdavLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
router.use(webdavLimiter);
router.use(webdavAuth);
router.use((req, res, next) => {
  const mode = db.getSetting('webdav_permission_mode') || process.env.WEBDAV_PERMISSION_MODE || 'full';
  const writeMethods = new Set(['PUT', 'POST', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH']);
  if (mode === 'readonly' && writeMethods.has(req.method)) return res.status(403).send('WebDAV is read-only');
  if (mode === 'safemode' && req.method === 'DELETE') return res.status(403).send('Delete is disabled in safe mode');
  next();
});

// Helper to escape XML
function escapeXml(unsafe) {
  return (unsafe || '').replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// OPTIONS
router.options('*', (req, res) => {
  res.setHeader('DAV', '1, 2');
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.setHeader('MS-Author-Via', 'DAV');
  res.status(200).end();
});

// PROPFIND
router.all('*', async (req, res, next) => {
  if (req.method !== 'PROPFIND') return next();

  const user = req.user;
  const reqPath = decodeURIComponent(req.path || '/');
  const depth = req.headers['depth'] || '1';

  // Root directory query
  const folders = db.getAllFolders(user.id);
  const files = db.getRecentFiles(500, user.id);

  let xml = '<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n';

  // Root
  xml += `
    <D:response>
      <D:href>/webdav/</D:href>
      <D:propstat>
        <D:prop>
          <D:displayname>CloudDrive Root</D:displayname>
          <D:resourcetype><D:collection/></D:resourcetype>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>
  `;

  if (depth !== '0') {
    for (const f of folders) {
      xml += `
        <D:response>
          <D:href>/webdav/${encodeURIComponent(f.name)}/</D:href>
          <D:propstat>
            <D:prop>
              <D:displayname>${escapeXml(f.name)}</D:displayname>
              <D:resourcetype><D:collection/></D:resourcetype>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
      `;
    }

    for (const file of files) {
      xml += `
        <D:response>
          <D:href>/webdav/${encodeURIComponent(file.name)}</D:href>
          <D:propstat>
            <D:prop>
              <D:displayname>${escapeXml(file.name)}</D:displayname>
              <D:getcontentlength>${file.size}</D:getcontentlength>
              <D:getcontenttype>${file.mime_type || 'application/octet-stream'}</D:getcontenttype>
              <D:resourcetype/>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
      `;
    }
  }

  xml += '</D:multistatus>';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(207).send(xml);
});

// GET file via WebDAV
router.get('/:name', async (req, res) => {
  const fileName = decodeURIComponent(req.params.name);
  const files = db.getRecentFiles(500, req.user.id);
  const file = files.find(f => f.name === fileName);

  if (!file) return res.status(404).send('File not found');

  try {
    const chunks = db.getAllFileChunksWithReplicas(file.id);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);

    for (const chunk of chunks) {
      const downloaded = await storageManager.downloadChunkWithFailover(
        chunk.replicas,
        file.primary_provider
      );
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
    res.status(500).send(`WebDAV download error: ${err.message}`);
  }
});

// PUT file via WebDAV
router.put('/:name', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  const fileName = decodeURIComponent(req.params.name);
  const plainBuffer = req.body;
  if (!plainBuffer || plainBuffer.length === 0) {
    return res.status(200).send('Empty file created');
  }

  const fileId = uuidv4();
  const isEnc = (db.getSetting('encryption_enabled', req.user.id) !== 'false');
  const encResult = cryptoModule.encryptChunkBuffer(
    plainBuffer,
    req.user.encryption_key,
    fileId,
    0,
    isEnc
  );

  const primary = db.getSetting('primary_provider') || config.PRIMARY_PROVIDER || 'telegram';
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
    size: plainBuffer.length,
    folder_id: null,
    storage_mode: req.user.default_storage_mode || 'dual',
    primary_provider: actualPrimary,
    discord_status: actualPrimary === 'discord' ? 'completed' : 'none',
    telegram_status: actualPrimary === 'telegram' ? 'completed' : 'none',
    replication_status: 'completed',
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
    sha256: encResult.sha256,
    crypto_version: 2
  });

  db.addChunkReplica({
    id: uuidv4(),
    chunk_id: chunkId,
    file_id: fileId,
    chunk_index: 0,
    provider: actualPrimary,
    remote_id: uploadResult.remoteId,
    status: 'completed'
  });

  db.recalculateUserStorage(req.user.id);

  res.status(201).send('File created');
});

// MKCOL (Create directory)
router.all('*', (req, res, next) => {
  if (req.method !== 'MKCOL') return next();
  const folderName = decodeURIComponent(req.path.replace(/^\/|\/$/g, ''));
  if (!folderName) return res.status(400).send('Folder name required');

  db.createFolder({
    id: uuidv4(),
    user_id: req.user.id,
    name: folderName,
    parent_id: null
  });

  res.status(201).send('Collection created');
});

// DELETE
router.delete('/:name', (req, res) => {
  const fileName = decodeURIComponent(req.params.name);
  const files = db.getRecentFiles(500, req.user.id);
  const file = files.find(f => f.name === fileName);
  if (file) {
    db.updateFile(file.id, { is_trashed: 1, trashed_at: new Date().toISOString() }, req.user.id);
    return res.status(204).end();
  }
  res.status(404).send('Resource not found');
});

module.exports = router;
