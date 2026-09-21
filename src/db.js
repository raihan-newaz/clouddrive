const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'clouddrive.db');
let db = null;

/**
 * Initializes the CloudDrive SQLite database
 */
async function initialize() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');

  // 1. Users Table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      encryption_key TEXT NOT NULL,
      storage_limit INTEGER DEFAULT 0,
      storage_used INTEGER DEFAULT 0,
      file_prefix TEXT,
      default_storage_mode TEXT DEFAULT 'dual',
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Folders Table
  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      storage_policy TEXT,
      is_locked INTEGER DEFAULT 0,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Files Table
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      storage_mode TEXT NOT NULL DEFAULT 'dual',
      primary_provider TEXT NOT NULL DEFAULT 'telegram',
      discord_status TEXT DEFAULT 'none',
      telegram_status TEXT DEFAULT 'none',
      replication_status TEXT DEFAULT 'completed',
      iv TEXT,
      salt TEXT,
      auth_tag TEXT,
      sha256 TEXT,
      is_starred INTEGER DEFAULT 0,
      is_trashed INTEGER DEFAULT 0,
      is_chunked INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      is_shared INTEGER DEFAULT 0,
      share_token TEXT,
      share_password TEXT,
      share_expires_at DATETIME,
      share_views INTEGER DEFAULT 0,
      share_downloads INTEGER DEFAULT 0,
      trashed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. File Chunks Table
  db.run(`
    CREATE TABLE IF NOT EXISTS file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      auth_tag TEXT,
      sha256 TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_id, chunk_index)
    );
  `);

  // 5. Chunk Replicas Table (Tracks physical storage location in each provider)
  db.run(`
    CREATE TABLE IF NOT EXISTS chunk_replicas (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES file_chunks(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      provider TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      remote_channel_id TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chunk_id, provider)
    );
  `);

  // 6. Persistent Replication Queue Table
  db.run(`
    CREATE TABLE IF NOT EXISTS replication_jobs (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      source_provider TEXT NOT NULL,
      target_provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 5,
      last_error TEXT,
      next_run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 7. Upload Sessions Table
  db.run(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      folder_id TEXT,
      storage_mode TEXT NOT NULL DEFAULT 'dual',
      primary_provider TEXT NOT NULL DEFAULT 'telegram',
      total_chunks INTEGER NOT NULL,
      sha256 TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 8. Upload Session Chunks Table
  db.run(`
    CREATE TABLE IF NOT EXISTS upload_session_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      provider TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      auth_tag TEXT,
      sha256 TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, chunk_index, provider)
    );
  `);

  // 9. Backups Table
  db.run(`
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'discord',
      remote_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 10. App Settings Table
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT NOT NULL,
      user_id TEXT,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key, user_id)
    );
  `);

  // 11. Video Metadata Table
  db.run(`
    CREATE TABLE IF NOT EXISTS video_metadata (
      file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      duration REAL,
      width INTEGER,
      height INTEGER,
      codec TEXT,
      fps REAL,
      bitrate INTEGER,
      has_audio INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 12. Security Audit Logs Table
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_email TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run(`CREATE TABLE IF NOT EXISTS blocked_ips (ip_address TEXT PRIMARY KEY, reason TEXT, blocked_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);

  // Indexes for high-speed queries
  try { db.run('CREATE INDEX IF NOT EXISTS idx_files_user_trashed ON files(user_id, is_trashed);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_replicas_file_chunk ON chunk_replicas(file_id, chunk_index);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_replicas_chunk ON chunk_replicas(chunk_id);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_rep_jobs_status ON replication_jobs(status, next_run_at);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at);'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at);'); } catch (e) {}
  try { db.run('ALTER TABLE upload_sessions ADD COLUMN upload_strategy TEXT DEFAULT "primary_first";'); } catch (e) {}
  try { db.run('ALTER TABLE upload_sessions ADD COLUMN encryption_enabled INTEGER DEFAULT 1;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN encryption_enabled INTEGER DEFAULT 1;'); } catch (e) {}
  try { db.run('ALTER TABLE file_chunks ADD COLUMN crypto_version INTEGER DEFAULT 2;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN locked_until DATETIME DEFAULT NULL;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 1;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN file_prefix TEXT DEFAULT NULL;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN default_storage_mode TEXT DEFAULT "dual";'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN first_name TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE users ADD COLUMN last_name TEXT;'); } catch (e) {}
  try {
    db.run(`
      UPDATE users
      SET first_name = CASE
            WHEN INSTR(TRIM(name), ' ') > 0 THEN SUBSTR(TRIM(name), 1, INSTR(TRIM(name), ' ') - 1)
            ELSE TRIM(name)
          END,
          last_name = CASE
            WHEN INSTR(TRIM(name), ' ') > 0 THEN TRIM(SUBSTR(TRIM(name), INSTR(TRIM(name), ' ') + 1))
            ELSE ''
          END
      WHERE first_name IS NULL OR TRIM(first_name) = '';
    `);
  } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN is_trashed INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN trashed_at DATETIME DEFAULT NULL;'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_folders_user_trashed ON folders(user_id, is_trashed);'); } catch (e) {}

  save();
  return db;
}

/**
 * Persists SQLite in-memory state to disk
 */
function save() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer, { mode: 0o600 });
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

function run(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function all(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// ─── User Management ────────────────────────────────────────────────────────

function createUser(user) {
  const sql = `
    INSERT INTO users (id, email, password_hash, name, role, status, encryption_key, storage_limit, storage_used, file_prefix, default_storage_mode, first_name, last_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    user.id,
    user.email,
    user.password_hash,
    user.name || [user.first_name || user.firstName, user.last_name || user.lastName].filter(Boolean).join(' '),
    user.role || 'user',
    user.status || 'active',
    user.encryption_key,
    user.storage_limit || 0,
    user.storage_used || 0,
    user.file_prefix || null,
    user.default_storage_mode || 'dual',
    user.first_name || user.firstName || null,
    user.last_name || user.lastName || null
  ]);
  return getUserById(user.id);
}

function getUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = ?', [email]);
}

function getUserById(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

function getAllUsers() {
  return all('SELECT id, email, name, first_name, last_name, role, status, storage_limit, storage_used, file_prefix, default_storage_mode, last_login_at, created_at, updated_at FROM users ORDER BY created_at ASC');
}

function updateUser(id, updates) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  return getUserById(id);
}

function deleteUser(id) {
  run('DELETE FROM users WHERE id = ?', [id]);
}

// ─── Folder Management ──────────────────────────────────────────────────────

function createFolder(folder) {
  const sql = `
    INSERT INTO folders (id, user_id, name, parent_id, storage_policy, is_locked, password_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    folder.id,
    folder.user_id || null,
    folder.name,
    folder.parent_id || null,
    folder.storage_policy || null,
    folder.is_locked || 0,
    folder.password_hash || null
  ]);
  return getFolderById(folder.id, folder.user_id);
}

function getFolderById(id, userId = null) {
  if (userId) {
    return get('SELECT * FROM folders WHERE id = ? AND user_id = ?', [id, userId]);
  }
  return get('SELECT * FROM folders WHERE id = ?', [id]);
}

function getFoldersByParent(parentId, userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM folders WHERE ';
  const params = [];

  if (parentId === null || parentId === undefined) {
    sql += 'parent_id IS NULL';
  } else {
    sql += 'parent_id = ?';
    params.push(parentId);
  }

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }

  sql += ' ORDER BY name ASC';
  return all(sql, params);
}

function getAllFolders(userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM folders WHERE 1=1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }
  sql += ' ORDER BY name ASC';
  return all(sql, params);
}

function getTrashedFolders(userId = null, parentId = null) {
  let sql = 'SELECT * FROM folders WHERE is_trashed = 1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (parentId !== null && parentId !== undefined) {
    sql += ' AND parent_id = ?';
    params.push(parentId);
  } else {
    // Root level trash: either parent_id is NULL or parent_id is not in trashed folders
    if (userId) {
      sql += ' AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM folders WHERE is_trashed = 1 AND user_id = ?))';
      params.push(userId);
    } else {
      sql += ' AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM folders WHERE is_trashed = 1))';
    }
  }

  sql += ' ORDER BY trashed_at DESC, name ASC';
  return all(sql, params);
}

function getAllTrashedFolders(userId = null) {
  let sql = 'SELECT * FROM folders WHERE is_trashed = 1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY trashed_at DESC, name ASC';
  return all(sql, params);
}

function updateFolder(id, updates, userId = null) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  let sql = `UPDATE folders SET ${fields.join(', ')} WHERE id = ?`;
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  run(sql, params);
  return getFolderById(id, userId);
}

function deleteFolder(id, userId = null) {
  if (userId) {
    run('DELETE FROM folders WHERE id = ? AND user_id = ?', [id, userId]);
  } else {
    run('DELETE FROM folders WHERE id = ?', [id]);
  }
}

// ─── File Management ────────────────────────────────────────────────────────

function createFile(file) {
  const sql = `
    INSERT INTO files (
      id, user_id, name, mime_type, size, folder_id, storage_mode, primary_provider,
      discord_status, telegram_status, replication_status, iv, salt, auth_tag, sha256,
      is_starred, is_trashed, is_chunked, total_chunks, encryption_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    file.id,
    file.user_id || null,
    file.name,
    file.mime_type || null,
    file.size || 0,
    file.folder_id || null,
    file.storage_mode || 'dual',
    file.primary_provider || 'telegram',
    file.discord_status || 'none',
    file.telegram_status || 'none',
    file.replication_status || 'completed',
    file.iv || null,
    file.salt || null,
    file.auth_tag || null,
    file.sha256 || null,
    file.is_starred || 0,
    file.is_trashed || 0,
    file.is_chunked || 0,
    file.total_chunks || 1,
    file.encryption_enabled !== undefined ? file.encryption_enabled : 1
  ]);
  return getFileById(file.id, file.user_id);
}

function getFileById(id, userId = null) {
  if (userId) {
    return get('SELECT * FROM files WHERE id = ? AND user_id = ?', [id, userId]);
  }
  return get('SELECT * FROM files WHERE id = ?', [id]);
}

function getFilesByFolder(folderId, userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM files WHERE ';
  const params = [];

  if (folderId === null || folderId === undefined) {
    sql += 'folder_id IS NULL';
  } else {
    sql += 'folder_id = ?';
    params.push(folderId);
  }

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }

  sql += ' ORDER BY name ASC';
  return all(sql, params);
}

function getAllFiles(userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM files WHERE 1=1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }
  sql += ' ORDER BY created_at DESC';
  return all(sql, params);
}

function getRecentFiles(limit = 10, userId = null) {
  let sql = 'SELECT * FROM files WHERE (is_trashed = 0 OR is_trashed IS NULL)';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  return all(sql, params);
}

function getStarredFiles(userId = null) {
  let sql = 'SELECT * FROM files WHERE is_starred = 1 AND (is_trashed = 0 OR is_trashed IS NULL)';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY name ASC';
  return all(sql, params);
}

function getTrashedFiles(userId = null, folderId = null) {
  let sql = 'SELECT * FROM files WHERE is_trashed = 1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (folderId !== null && folderId !== undefined) {
    sql += ' AND folder_id = ?';
    params.push(folderId);
  } else {
    // Root level trash: either folder_id is NULL or folder_id is not in trashed folders
    if (userId) {
      sql += ' AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM folders WHERE is_trashed = 1 AND user_id = ?))';
      params.push(userId);
    } else {
      sql += ' AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM folders WHERE is_trashed = 1))';
    }
  }

  sql += ' ORDER BY trashed_at DESC';
  return all(sql, params);
}

function getAllTrashedFiles(userId = null) {
  let sql = 'SELECT * FROM files WHERE is_trashed = 1';
  const params = [];
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY trashed_at DESC';
  return all(sql, params);
}

function updateFile(id, updates, userId = null) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  let sql = `UPDATE files SET ${fields.join(', ')} WHERE id = ?`;
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  run(sql, params);
  return getFileById(id, userId);
}

function deleteFilePermanently(id, userId = null) {
  if (userId) {
    run('DELETE FROM files WHERE id = ? AND user_id = ?', [id, userId]);
  } else {
    run('DELETE FROM files WHERE id = ?', [id]);
  }
}

function searchFiles(query, userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM files WHERE LOWER(name) LIKE ?';
  const cleanQ = `%${String(query || '').trim().toLowerCase()}%`;
  const params = [cleanQ];
  if (userId && typeof userId === 'string' && userId.trim()) {
    sql += ' AND user_id = ?';
    params.push(userId.trim());
  }
  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }
  sql += ' ORDER BY created_at DESC';
  return all(sql, params);
}

function searchFolders(query, userId = null, includeTrashed = false) {
  let sql = 'SELECT * FROM folders WHERE LOWER(name) LIKE ?';
  const cleanQ = `%${String(query || '').trim().toLowerCase()}%`;
  const params = [cleanQ];
  if (userId && typeof userId === 'string' && userId.trim()) {
    sql += ' AND user_id = ?';
    params.push(userId.trim());
  }
  if (!includeTrashed) {
    sql += ' AND (is_trashed = 0 OR is_trashed IS NULL)';
  }
  sql += ' ORDER BY name ASC';
  return all(sql, params);
}

// ─── Chunk & Replicas Management ────────────────────────────────────────────

function addFileChunk(chunk) {
  const sql = `
    INSERT OR REPLACE INTO file_chunks (id, file_id, chunk_index, size, iv, salt, auth_tag, sha256, crypto_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    chunk.id,
    chunk.file_id,
    chunk.chunk_index,
    chunk.size,
    chunk.iv || '',
    chunk.salt || '',
    chunk.auth_tag || null,
    chunk.sha256 || null,
    chunk.crypto_version !== undefined ? chunk.crypto_version : 2
  ]);
  return chunk;
}

function getFileChunks(fileId) {
  return all('SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index ASC', [fileId]);
}

function addChunkReplica(replica) {
  const existing = get('SELECT remote_id FROM chunk_replicas WHERE chunk_id = ? AND provider = ?', [replica.chunk_id, replica.provider]);
  if (existing && existing.remote_id && existing.remote_id !== replica.remote_id) {
    try {
      const storageManager = require('./storage/StorageManager');
      const prov = storageManager.getProvider(replica.provider);
      prov.deleteChunk(existing.remote_id).catch(() => {});
    } catch (e) {}
  }

  const sql = `
    INSERT OR REPLACE INTO chunk_replicas (id, chunk_id, file_id, chunk_index, provider, remote_id, remote_channel_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    replica.id,
    replica.chunk_id,
    replica.file_id,
    replica.chunk_index,
    replica.provider,
    replica.remote_id,
    replica.remote_channel_id || null,
    replica.status || 'completed'
  ]);
  return replica;
}

function getChunkReplicas(chunkId) {
  return all('SELECT * FROM chunk_replicas WHERE chunk_id = ?', [chunkId]);
}

function getFileReplicas(fileId) {
  return all('SELECT * FROM chunk_replicas WHERE file_id = ? ORDER BY chunk_index ASC, provider ASC', [fileId]);
}

function getFileChunkWithReplicas(fileId, chunkIndex) {
  const chunk = get('SELECT * FROM file_chunks WHERE file_id = ? AND chunk_index = ?', [fileId, chunkIndex]);
  if (!chunk) return null;
  const replicas = all('SELECT * FROM chunk_replicas WHERE chunk_id = ?', [chunk.id]);
  return {
    ...chunk,
    replicas
  };
}

function getAllFileChunksWithReplicas(fileId) {
  const chunks = getFileChunks(fileId);
  const replicas = getFileReplicas(fileId);

  const replicaMap = new Map();
  for (const rep of replicas) {
    if (!replicaMap.has(rep.chunk_id)) replicaMap.set(rep.chunk_id, []);
    replicaMap.get(rep.chunk_id).push(rep);
  }

  return chunks.map(chunk => ({
    ...chunk,
    replicas: replicaMap.get(chunk.id) || []
  }));
}

// ─── Replication Queue Management ───────────────────────────────────────────

function createReplicationJob(job) {
  const sql = `
    INSERT INTO replication_jobs (id, file_id, chunk_index, source_provider, target_provider, status, retry_count, max_retries, last_error, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  run(sql, [
    job.id,
    job.file_id,
    job.chunk_index,
    job.source_provider,
    job.target_provider,
    job.status || 'pending',
    job.retry_count || 0,
    job.max_retries || 5,
    job.last_error || null,
    job.next_run_at || new Date().toISOString()
  ]);
}

function getPendingReplicationJobs(limit = 10) {
  return all(`
    SELECT * FROM replication_jobs
    WHERE status IN ('pending', 'retrying')
      AND datetime(next_run_at) <= datetime('now')
    ORDER BY created_at ASC
    LIMIT ?
  `, [limit]);
}

function updateReplicationJob(id, updates) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    params.push(value);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);
  run(`UPDATE replication_jobs SET ${fields.join(', ')} WHERE id = ?`, params);
}

function deleteReplicationJob(id) {
  run('DELETE FROM replication_jobs WHERE id = ?', [id]);
}

function getReplicationJobsByFile(fileId) {
  return all('SELECT * FROM replication_jobs WHERE file_id = ? ORDER BY chunk_index ASC', [fileId]);
}

// ─── Settings & Storage Stats ───────────────────────────────────────────────

function getSetting(key, userId = null) {
  if (userId) {
    const userRow = get('SELECT value FROM app_settings WHERE key = ? AND user_id = ?', [key, userId]);
    if (userRow && userRow.value !== undefined && userRow.value !== null) {
      return userRow.value;
    }
  }
  const globalRow = get('SELECT value FROM app_settings WHERE key = ? AND (user_id IS NULL OR user_id = "")', [key]);
  return globalRow ? globalRow.value : null;
}

function setSetting(key, value, userId = null) {
  const strVal = (value === null || value === undefined) ? '' : String(value);
  if (userId) {
    run('DELETE FROM app_settings WHERE key = ? AND user_id = ?', [key, userId]);
    run('INSERT INTO app_settings (key, user_id, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [key, userId, strVal]);
  } else {
    run('DELETE FROM app_settings WHERE key = ? AND (user_id IS NULL OR user_id = "")', [key]);
    run('INSERT INTO app_settings (key, user_id, value, updated_at) VALUES (?, NULL, ?, CURRENT_TIMESTAMP)', [key, strVal]);
  }
  save();
}

function getStorageStats(userId = null) {
  let fileQuery = 'SELECT COUNT(*) as total_files, SUM(size) as total_size FROM files WHERE is_trashed = 0';
  const params = [];
  if (userId) {
    fileQuery += ' AND user_id = ?';
    params.push(userId);
  }

  const fileStats = get(fileQuery, params) || { total_files: 0, total_size: 0 };

  // Calculate physical storage per provider
  let discordQuery = `
    SELECT SUM(cr.remote_id IS NOT NULL) as count, SUM(fc.size) as bytes
    FROM chunk_replicas cr
    JOIN file_chunks fc ON cr.chunk_id = fc.id
    JOIN files f ON cr.file_id = f.id
    WHERE cr.provider = 'discord' AND f.is_trashed = 0
  `;
  let telegramQuery = `
    SELECT SUM(cr.remote_id IS NOT NULL) as count, SUM(fc.size) as bytes
    FROM chunk_replicas cr
    JOIN file_chunks fc ON cr.chunk_id = fc.id
    JOIN files f ON cr.file_id = f.id
    WHERE cr.provider = 'telegram' AND f.is_trashed = 0
  `;

  if (userId) {
    discordQuery += ' AND f.user_id = ?';
    telegramQuery += ' AND f.user_id = ?';
  }

  const discordStats = get(discordQuery, userId ? [userId] : []) || { bytes: 0 };
  const telegramStats = get(telegramQuery, userId ? [userId] : []) || { bytes: 0 };

  return {
    logicalFiles: fileStats.total_files || 0,
    logicalBytes: fileStats.total_size || 0,
    discordBytes: discordStats.bytes || 0,
    telegramBytes: telegramStats.bytes || 0,
    physicalBytes: (discordStats.bytes || 0) + (telegramStats.bytes || 0)
  };
}

function getAllSettings(userId = null) {
  if (!db) return {};
  const uid = userId ? String(userId).trim() : '';
  const rows = uid
    ? all(`
        SELECT key, value, user_id 
        FROM app_settings 
        WHERE user_id = ? OR user_id IS NULL OR user_id = ''
        ORDER BY CASE WHEN user_id = ? THEN 1 ELSE 0 END ASC
      `, [uid, uid])
    : all('SELECT key, value, user_id FROM app_settings WHERE user_id IS NULL OR user_id = ""');
  const result = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      result[r.key] = r.value;
    }
  }
  return result;
}

function setMultipleSettings(settingsObj, userId = null) {
  if (!settingsObj || typeof settingsObj !== 'object') return;
  for (const [key, value] of Object.entries(settingsObj)) {
    setSetting(key, String(value), userId);
  }
}

function recalculateUserStorage(userId) {
  if (!userId) return 0;
  const stats = get('SELECT COALESCE(SUM(size), 0) as total_size FROM files WHERE user_id = ?', [userId]);
  const total = stats ? (stats.total_size || 0) : 0;
  run('UPDATE users SET storage_used = ? WHERE id = ?', [total, userId]);
  return total;
}

function getUserDetailedStorageStats(userId) {
  if (!userId) return null;
  const user = getUserById(userId);
  if (!user) return null;

  const activeStats = get('SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize FROM files WHERE user_id = ? AND is_trashed = 0', [userId]);
  const trashStats = get('SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize FROM files WHERE user_id = ? AND is_trashed = 1', [userId]);
  const folderStats = get('SELECT COUNT(*) as count FROM folders WHERE user_id = ?', [userId]);

  const activeFilesSize = activeStats ? activeStats.totalSize : 0;
  const trashSize = trashStats ? trashStats.totalSize : 0;
  const totalUsed = activeFilesSize + trashSize;
  const storageLimit = user.storage_limit || 0; // 0 = unlimited

  let usagePercentage = 0;
  let freeStorage = 0;
  if (storageLimit > 0) {
    usagePercentage = Math.min(100, Math.round((totalUsed / storageLimit) * 100));
    freeStorage = Math.max(0, storageLimit - totalUsed);
  }

  let warningLevel = null;
  if (storageLimit > 0) {
    if (usagePercentage >= 100) warningLevel = '100';
    else if (usagePercentage >= 95) warningLevel = '95';
    else if (usagePercentage >= 90) warningLevel = '90';
    else if (usagePercentage >= 80) warningLevel = '80';
  }

  return {
    userId,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storageLimit,
    storageUsed: totalUsed,
    activeFilesSize,
    trashSize,
    freeStorage,
    usagePercentage,
    warningLevel,
    fileCount: (activeStats ? activeStats.count : 0) + (trashStats ? trashStats.count : 0),
    activeFileCount: activeStats ? activeStats.count : 0,
    trashFileCount: trashStats ? trashStats.count : 0,
    folderCount: folderStats ? folderStats.count : 0
  };
}

function getUserStorageBreakdown(userId) {
  if (!userId) return { totalSize: 0, breakdown: {} };
  const rows = all(`
    SELECT 
      CASE 
        WHEN mime_type LIKE 'video/%' OR LOWER(name) LIKE '%.mp4' OR LOWER(name) LIKE '%.mkv' OR LOWER(name) LIKE '%.avi' OR LOWER(name) LIKE '%.mov' OR LOWER(name) LIKE '%.webm' OR LOWER(name) LIKE '%.wmv' OR LOWER(name) LIKE '%.flv' OR LOWER(name) LIKE '%.ts' OR LOWER(name) LIKE '%.m4v' THEN 'video'
        WHEN mime_type LIKE 'image/%' OR LOWER(name) LIKE '%.jpg' OR LOWER(name) LIKE '%.jpeg' OR LOWER(name) LIKE '%.png' OR LOWER(name) LIKE '%.gif' OR LOWER(name) LIKE '%.webp' OR LOWER(name) LIKE '%.svg' OR LOWER(name) LIKE '%.bmp' OR LOWER(name) LIKE '%.ico' OR LOWER(name) LIKE '%.avif' THEN 'image'
        WHEN mime_type LIKE 'audio/%' OR LOWER(name) LIKE '%.mp3' OR LOWER(name) LIKE '%.wav' OR LOWER(name) LIKE '%.ogg' OR LOWER(name) LIKE '%.flac' OR LOWER(name) LIKE '%.aac' OR LOWER(name) LIKE '%.m4a' OR LOWER(name) LIKE '%.opus' OR LOWER(name) LIKE '%.wma' THEN 'audio'
        WHEN mime_type = 'application/pdf' OR mime_type LIKE 'text/%' OR LOWER(name) LIKE '%.pdf' OR LOWER(name) LIKE '%.doc' OR LOWER(name) LIKE '%.docx' OR LOWER(name) LIKE '%.xls' OR LOWER(name) LIKE '%.xlsx' OR LOWER(name) LIKE '%.ppt' OR LOWER(name) LIKE '%.pptx' OR LOWER(name) LIKE '%.txt' OR LOWER(name) LIKE '%.csv' OR LOWER(name) LIKE '%.md' THEN 'document'
        WHEN mime_type LIKE '%zip%' OR mime_type LIKE '%rar%' OR mime_type LIKE '%tar%' OR mime_type LIKE '%compressed%' OR LOWER(name) LIKE '%.zip' OR LOWER(name) LIKE '%.rar' OR LOWER(name) LIKE '%.7z' OR LOWER(name) LIKE '%.tar' OR LOWER(name) LIKE '%.gz' OR LOWER(name) LIKE '%.iso' THEN 'archive'
        ELSE 'other'
      END AS category,
      COUNT(*) as count,
      COALESCE(SUM(size), 0) as total_size
    FROM files
    WHERE user_id = ? AND is_trashed = 0
    GROUP BY category
  `, [userId]);

  const breakdown = {
    video: { count: 0, size: 0, label: 'Videos', icon: 'video' },
    image: { count: 0, size: 0, label: 'Images', icon: 'image' },
    document: { count: 0, size: 0, label: 'Documents', icon: 'document' },
    audio: { count: 0, size: 0, label: 'Audio', icon: 'audio' },
    archive: { count: 0, size: 0, label: 'Archives', icon: 'archive' },
    other: { count: 0, size: 0, label: 'Other', icon: 'other' }
  };

  let totalSize = 0;
  for (const r of rows) {
    if (breakdown[r.category]) {
      breakdown[r.category].count = r.count;
      breakdown[r.category].size = r.total_size;
      totalSize += r.total_size;
    } else {
      breakdown.other.count += r.count;
      breakdown.other.size += r.total_size;
      totalSize += r.total_size;
    }
  }

  for (const key of Object.keys(breakdown)) {
    breakdown[key].percentage = totalSize > 0 ? Math.round((breakdown[key].size / totalSize) * 100) : 0;
  }

  return { totalSize, breakdown };
}

function getUserLargestFiles(userId, limit = 10) {
  if (!userId) return [];
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100));
  return all(
    'SELECT id, name, size, mime_type, folder_id, is_starred, created_at, updated_at FROM files WHERE user_id = ? AND is_trashed = 0 ORDER BY size DESC LIMIT ?',
    [userId, safeLimit]
  );
}

function getUserRecentStorageActivity(userId, limit = 10) {
  if (!userId) return [];
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
  return all(
    'SELECT id, name, size, mime_type, is_trashed, created_at, updated_at FROM files WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    [userId, safeLimit]
  );
}

function searchFiles(query, userId) {
  if (!query) return [];
  const q = `%${query.trim().toLowerCase()}%`;
  return all(
    'SELECT * FROM files WHERE user_id = ? AND LOWER(name) LIKE ? AND is_trashed = 0 ORDER BY name ASC',
    [userId, q]
  );
}

function searchFolders(query, userId) {
  if (!query) return [];
  const q = `%${query.trim().toLowerCase()}%`;
  return all(
    'SELECT * FROM folders WHERE user_id = ? AND LOWER(name) LIKE ? ORDER BY name ASC',
    [userId, q]
  );
}

function getLatestBackup(userId = null) {
  const sql = userId
    ? 'SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    : 'SELECT * FROM backups ORDER BY created_at DESC LIMIT 1';
  return get(sql, userId ? [userId] : []);
}

function getAllBackups(limit = 10, userId = null) {
  const sql = userId
    ? 'SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM backups ORDER BY created_at DESC LIMIT ?';
  return all(sql, userId ? [userId, limit] : [limit]);
}

function addBackup(id, fileName, remoteId, size, provider = 'discord', userId = null) {
  run(
    'INSERT INTO backups (id, user_id, file_name, provider, remote_id, size) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, fileName, provider, remoteId, size]
  );
  return get('SELECT * FROM backups WHERE id = ?', [id]);
}

function getBackupById(id) {
  return get('SELECT * FROM backups WHERE id = ?', [id]);
}

function getBackupByRemoteId(remoteId) {
  return get('SELECT * FROM backups WHERE remote_id = ? ORDER BY created_at DESC LIMIT 1', [remoteId]);
}

function deleteBackup(id) {
  return run('DELETE FROM backups WHERE id = ?', [id]);
}

function getUserBackupById(id, userId) {
  if (!userId) return get('SELECT * FROM backups WHERE id = ?', [id]);
  return get('SELECT * FROM backups WHERE id = ? AND user_id = ?', [id, userId]);
}

function exportUserData(userId) {
  if (!userId) throw new Error('User ID is required for data export');
  const user = get('SELECT id, email, name, role, storage_limit, file_prefix, default_storage_mode, encryption_key FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('User not found');

  const folders = all('SELECT * FROM folders WHERE user_id = ?', [userId]);
  const files = all('SELECT * FROM files WHERE user_id = ?', [userId]);
  const fileIds = files.map(f => f.id);

  let fileChunks = [];
  let chunkReplicas = [];

  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    fileChunks = all(`SELECT * FROM file_chunks WHERE file_id IN (${placeholders})`, fileIds);
    const chunkIds = fileChunks.map(c => c.id);
    if (chunkIds.length > 0) {
      const chunkPlaceholders = chunkIds.map(() => '?').join(',');
      chunkReplicas = all(`SELECT * FROM chunk_replicas WHERE chunk_id IN (${chunkPlaceholders})`, chunkIds);
    }
  }

  return {
    version: 'clouddrive-user-backup-v1',
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      file_prefix: user.file_prefix
    },
    folders,
    files,
    fileChunks,
    chunkReplicas
  };
}

function importUserData(targetUserId, dataPackage) {
  if (!targetUserId) throw new Error('Target User ID is required');
  if (!dataPackage || typeof dataPackage !== 'object') throw new Error('Invalid backup package');

  const folders = Array.isArray(dataPackage.folders) ? dataPackage.folders : [];
  const files = Array.isArray(dataPackage.files) ? dataPackage.files : [];
  const fileChunks = Array.isArray(dataPackage.fileChunks) ? dataPackage.fileChunks : [];
  const chunkReplicas = Array.isArray(dataPackage.chunkReplicas) ? dataPackage.chunkReplicas : [];

  // Imported identifiers may only update records already owned by this tenant.
  for (const folder of folders) {
    if (!folder || typeof folder.id !== 'string') throw new Error('Invalid folder record in backup');
    const existing = get('SELECT user_id FROM folders WHERE id = ?', [folder.id]);
    if (existing && existing.user_id !== targetUserId) throw new Error('Backup contains a folder ID owned by another user');
  }
  for (const file of files) {
    if (!file || typeof file.id !== 'string') throw new Error('Invalid file record in backup');
    const existing = get('SELECT user_id FROM files WHERE id = ?', [file.id]);
    if (existing && existing.user_id !== targetUserId) throw new Error('Backup contains a file ID owned by another user');
  }
  const allowedFileIds = new Set(files.map(file => file.id));
  for (const chunk of fileChunks) {
    if (!chunk || !allowedFileIds.has(chunk.file_id)) throw new Error('Backup chunk references an unauthorized file');
  }
  const allowedChunkIds = new Set(fileChunks.map(chunk => chunk.id));
  for (const replica of chunkReplicas) {
    if (!replica || !allowedFileIds.has(replica.file_id) || !allowedChunkIds.has(replica.chunk_id)) {
      throw new Error('Backup replica references an unauthorized file or chunk');
    }
  }

  let importedFolders = 0;
  let importedFiles = 0;

  // 1. Upsert Folders
  for (const folder of folders) {
    const existing = get('SELECT id FROM folders WHERE id = ?', [folder.id]);
    if (existing) {
      run(
        'UPDATE folders SET user_id = ?, name = ?, parent_id = ?, color = ?, is_starred = ?, is_trashed = ?, is_locked = ?, password_hash = ? WHERE id = ?',
        [targetUserId, folder.name, folder.parent_id, folder.color, folder.is_starred, folder.is_trashed, folder.is_locked, folder.password_hash, folder.id]
      );
    } else {
      run(
        'INSERT INTO folders (id, user_id, name, parent_id, color, is_starred, is_trashed, is_locked, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [folder.id, targetUserId, folder.name, folder.parent_id, folder.color, folder.is_starred, folder.is_trashed, folder.is_locked, folder.password_hash, folder.created_at || new Date().toISOString()]
      );
    }
    importedFolders++;
  }

  // 2. Upsert Files
  for (const file of files) {
    const existing = get('SELECT id FROM files WHERE id = ?', [file.id]);
    if (existing) {
      run(
        `UPDATE files SET user_id = ?, name = ?, original_name = ?, mime_type = ?, size = ?, folder_id = ?,
         primary_provider = ?, discord_status = ?, telegram_status = ?, replication_status = ?,
         iv = ?, salt = ?, auth_tag = ?, sha256 = ?, is_starred = ?, is_trashed = ?, is_chunked = ?, total_chunks = ?, encryption_enabled = ?
         WHERE id = ?`,
        [
          targetUserId, file.name, file.original_name, file.mime_type, file.size, file.folder_id,
          file.primary_provider, file.discord_status, file.telegram_status, file.replication_status,
          file.iv, file.salt, file.auth_tag, file.sha256, file.is_starred, file.is_trashed, file.is_chunked, file.total_chunks, file.encryption_enabled,
          file.id
        ]
      );
    } else {
      run(
        `INSERT INTO files (id, user_id, name, original_name, mime_type, size, folder_id,
         primary_provider, discord_status, telegram_status, replication_status,
         iv, salt, auth_tag, sha256, is_starred, is_trashed, is_chunked, total_chunks, encryption_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          file.id, targetUserId, file.name, file.original_name, file.mime_type, file.size, file.folder_id,
          file.primary_provider, file.discord_status, file.telegram_status, file.replication_status,
          file.iv, file.salt, file.auth_tag, file.sha256, file.is_starred, file.is_trashed, file.is_chunked, file.total_chunks, file.encryption_enabled,
          file.created_at || new Date().toISOString()
        ]
      );
    }
    importedFiles++;
  }

  // 3. Upsert File Chunks
  for (const chunk of fileChunks) {
    const existing = get('SELECT id FROM file_chunks WHERE id = ?', [chunk.id]);
    if (existing) {
      run(
        'UPDATE file_chunks SET file_id = ?, chunk_index = ?, size = ?, iv = ?, salt = ?, auth_tag = ?, sha256 = ? WHERE id = ?',
        [chunk.file_id, chunk.chunk_index, chunk.size, chunk.iv, chunk.salt, chunk.auth_tag, chunk.sha256, chunk.id]
      );
    } else {
      run(
        'INSERT INTO file_chunks (id, file_id, chunk_index, size, iv, salt, auth_tag, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [chunk.id, chunk.file_id, chunk.chunk_index, chunk.size, chunk.iv, chunk.salt, chunk.auth_tag, chunk.sha256, chunk.created_at || new Date().toISOString()]
      );
    }
  }

  // 4. Upsert Chunk Replicas
  for (const rep of chunkReplicas) {
    const existing = get('SELECT id FROM chunk_replicas WHERE id = ?', [rep.id]);
    if (existing) {
      run(
        'UPDATE chunk_replicas SET chunk_id = ?, file_id = ?, chunk_index = ?, provider = ?, remote_id = ?, remote_channel_id = ?, status = ? WHERE id = ?',
        [rep.chunk_id, rep.file_id, rep.chunk_index, rep.provider, rep.remote_id, rep.remote_channel_id, rep.status || 'completed', rep.id]
      );
    } else {
      run(
        'INSERT INTO chunk_replicas (id, chunk_id, file_id, chunk_index, provider, remote_id, remote_channel_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [rep.id, rep.chunk_id, rep.file_id, rep.chunk_index, rep.provider, rep.remote_id, rep.remote_channel_id, rep.status || 'completed', rep.created_at || new Date().toISOString()]
      );
    }
  }

  // Recalculate user storage usage
  recalculateUserStorage(targetUserId);

  return {
    success: true,
    importedFolders,
    importedFiles,
    importedChunks: fileChunks.length,
    importedReplicas: chunkReplicas.length
  };
}

function getFileByShareToken(token) {
  return get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1', [token]);
}

function incrementShareViews(token) {
  run('UPDATE files SET share_views = share_views + 1 WHERE share_token = ?', [token]);
}

function updateFileShare(fileId, data, userId = null) {
  const fields = [];
  const params = [];
  if (data.isShared !== undefined) {
    fields.push('is_shared = ?');
    params.push(data.isShared ? 1 : 0);
  }
  if (data.token !== undefined) {
    fields.push('share_token = ?');
    params.push(data.token);
  }
  if (data.password !== undefined) {
    fields.push('share_password = ?');
    params.push(data.password);
  }
  if (data.expiresAt !== undefined) {
    fields.push('share_expires_at = ?');
    params.push(data.expiresAt);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(fileId);
  let sql = `UPDATE files SET ${fields.join(', ')} WHERE id = ?`;
  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  run(sql, params);
  return getFileById(fileId, userId);
}

function revokeFileShare(fileId, userId = null) {
  return updateFileShare(fileId, {
    isShared: false,
    token: null,
    password: null,
    expiresAt: null
  }, userId);
}

// ─── Storage Statistics & Analytics ─────────────────────────────────────────

function recalculateUserStorage(userId) {
  if (!userId) return 0;
  const row = get('SELECT COALESCE(SUM(size), 0) as total FROM files WHERE user_id = ? AND is_trashed = 0', [userId]);
  const total = row ? (row.total || 0) : 0;
  run('UPDATE users SET storage_used = ? WHERE id = ?', [total, userId]);
  return total;
}

function getStorageStats(userId = null) {
  let fileWhere = 'WHERE is_trashed = 0';
  const fileParams = [];
  if (userId) {
    fileWhere += ' AND user_id = ?';
    fileParams.push(userId);
  }

  const fileSummary = get(`
    SELECT 
      COUNT(*) as total_files,
      COALESCE(SUM(size), 0) as total_bytes,
      COUNT(CASE WHEN is_starred = 1 THEN 1 END) as starred_files,
      COUNT(CASE WHEN discord_status = 'completed' THEN 1 END) as discord_files,
      COUNT(CASE WHEN telegram_status = 'completed' THEN 1 END) as telegram_files,
      COUNT(CASE WHEN discord_status = 'completed' AND telegram_status = 'completed' THEN 1 END) as dual_files
    FROM files ${fileWhere}
  `, fileParams) || {
    total_files: 0,
    total_bytes: 0,
    starred_files: 0,
    discord_files: 0,
    telegram_files: 0,
    dual_files: 0
  };

  let folderWhere = '';
  const folderParams = [];
  if (userId) {
    folderWhere = 'WHERE user_id = ?';
    folderParams.push(userId);
  }
  const folderSummary = get(`SELECT COUNT(*) as total_folders FROM folders ${folderWhere}`, folderParams) || { total_folders: 0 };

  // Total unique chunks
  let chunkJoin = 'JOIN files f ON fc.file_id = f.id WHERE f.is_trashed = 0';
  const chunkParams = [];
  if (userId) {
    chunkJoin += ' AND f.user_id = ?';
    chunkParams.push(userId);
  }
  const totalChunkStats = get(`
    SELECT 
      COUNT(fc.id) as total_chunks,
      COALESCE(SUM(fc.size), 0) as total_chunk_bytes
    FROM file_chunks fc
    ${chunkJoin}
  `, chunkParams) || { total_chunks: 0, total_chunk_bytes: 0 };

  // Provider replicas breakdown
  let replicaJoin = 'JOIN files f ON cr.file_id = f.id JOIN file_chunks fc ON cr.chunk_id = fc.id WHERE f.is_trashed = 0 AND cr.status = "completed"';
  const replicaParams = [];
  if (userId) {
    replicaJoin += ' AND f.user_id = ?';
    replicaParams.push(userId);
  }

  const discordReplicas = get(`
    SELECT 
      COUNT(cr.id) as chunk_count,
      COALESCE(SUM(fc.size), 0) as bytes_used
    FROM chunk_replicas cr
    ${replicaJoin} AND cr.provider = 'discord'
  `, replicaParams) || { chunk_count: 0, bytes_used: 0 };

  const telegramReplicas = get(`
    SELECT 
      COUNT(cr.id) as chunk_count,
      COALESCE(SUM(fc.size), 0) as bytes_used
    FROM chunk_replicas cr
    ${replicaJoin} AND cr.provider = 'telegram'
  `, replicaParams) || { chunk_count: 0, bytes_used: 0 };

  const discordBytes = discordReplicas.bytes_used > 0 ? discordReplicas.bytes_used : (fileSummary.discord_files > 0 ? fileSummary.total_bytes : 0);
  const telegramBytes = telegramReplicas.bytes_used > 0 ? telegramReplicas.bytes_used : (fileSummary.telegram_files > 0 ? fileSummary.total_bytes : 0);
  const discordChunks = discordReplicas.chunk_count > 0 ? discordReplicas.chunk_count : (fileSummary.discord_files > 0 ? totalChunkStats.total_chunks : 0);
  const telegramChunks = telegramReplicas.chunk_count > 0 ? telegramReplicas.chunk_count : (fileSummary.telegram_files > 0 ? totalChunkStats.total_chunks : 0);

  return {
    totalFiles: fileSummary.total_files || 0,
    totalFolders: folderSummary.total_folders || 0,
    totalBytes: fileSummary.total_bytes || 0,
    totalChunks: totalChunkStats.total_chunks || 0,
    totalChunkBytes: totalChunkStats.total_chunk_bytes || 0,
    dualFiles: fileSummary.dual_files || 0,
    starredFiles: fileSummary.starred_files || 0,
    discord: {
      files: fileSummary.discord_files || 0,
      chunks: discordChunks || 0,
      bytes: discordBytes || 0
    },
    telegram: {
      files: fileSummary.telegram_files || 0,
      chunks: telegramChunks || 0,
      bytes: telegramBytes || 0
    }
  };
}

// ─── Security, Lockout & Audit Logging ──────────────────────────────────────

function recordFailedLogin(userId) {
  const user = getUserById(userId);
  if (!user) return null;

  const currentAttempts = (user.failed_login_attempts || 0) + 1;
  let lockUntil = user.locked_until;

  if (currentAttempts >= 5) {
    // Lock for 15 minutes
    lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }

  run('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [
    currentAttempts,
    lockUntil,
    userId
  ]);

  return {
    attempts: currentAttempts,
    isLocked: currentAttempts >= 5,
    lockedUntil: lockUntil
  };
}

function resetFailedLogins(userId) {
  run('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [userId]);
}

function incrementTokenVersion(userId) {
  run('UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?', [userId]);
  return getUserById(userId);
}

function logAuditEvent({ userId = null, userEmail = null, action, details = null, ipAddress = null, userAgent = null }) {
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const detailStr = typeof details === 'object' ? JSON.stringify(details) : (details ? String(details) : null);

  run(`
    INSERT INTO audit_logs (id, user_id, user_email, action, details, ip_address, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    id,
    userId,
    userEmail,
    action,
    detailStr,
    normalizeIp(ipAddress),
    userAgent
  ]);

  return { id, action, created_at: new Date().toISOString() };
}

function getAuditLogs({ limit = 50, offset = 0, userId = null, action = null, user = null, file = null, ip = null, search = null } = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (action) {
    sql += ' AND action = ?';
    params.push(action);
  }

  if (user) { sql += ' AND (user_id LIKE ? OR user_email LIKE ?)'; params.push(`%${user}%`, `%${user}%`); }
  if (file) { sql += ' AND details LIKE ?'; params.push(`%${file}%`); }
  if (ip) { sql += ' AND ip_address LIKE ?'; params.push(`%${ip}%`); }
  if (search) { sql += ' AND (user_email LIKE ? OR action LIKE ? OR ip_address LIKE ? OR details LIKE ? OR user_agent LIKE ?)'; params.push(...Array(5).fill(`%${search}%`)); }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, Math.max(1, limit)), Math.max(0, offset));

  return all(sql, params);
}

function getAuditLogCount({ userId = null, action = null, user = null, file = null, ip = null, search = null } = {}) {
  let sql = 'SELECT COUNT(*) as count FROM audit_logs WHERE 1=1';
  const params = [];

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }

  if (action) {
    sql += ' AND action = ?';
    params.push(action);
  }

  if (user) { sql += ' AND (user_id LIKE ? OR user_email LIKE ?)'; params.push(`%${user}%`, `%${user}%`); }
  if (file) { sql += ' AND details LIKE ?'; params.push(`%${file}%`); }
  if (ip) { sql += ' AND ip_address LIKE ?'; params.push(`%${ip}%`); }
  if (search) { sql += ' AND (user_email LIKE ? OR action LIKE ? OR ip_address LIKE ? OR details LIKE ? OR user_agent LIKE ?)'; params.push(...Array(5).fill(`%${search}%`)); }

  const row = get(sql, params);
  return row ? row.count : 0;
}

function normalizeIp(ip) {
  if (!ip) return null;
  const value = String(ip).trim().replace(/^\[|\]$/g, '');
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}
function isIpBlocked(ip) { return Boolean(get('SELECT ip_address FROM blocked_ips WHERE ip_address = ?', [normalizeIp(ip)])); }
function getBlockedIps() { return all('SELECT * FROM blocked_ips ORDER BY created_at DESC'); }
function blockIp(ip, reason = '', blockedBy = null) { run('INSERT OR REPLACE INTO blocked_ips (ip_address, reason, blocked_by) VALUES (?, ?, ?)', [normalizeIp(ip), reason, blockedBy]); }
function unblockIp(ip) { run('DELETE FROM blocked_ips WHERE ip_address = ?', [normalizeIp(ip)]); }

module.exports = {
  initialize,
  save,
  run,
  get,
  all,
  
  // Users & Security
  createUser,
  getUserByEmail,
  getUserById,
  getAllUsers,
  updateUser,
  deleteUser,
  recordFailedLogin,
  resetFailedLogins,
  incrementTokenVersion,
  logAuditEvent,
  getAuditLogs,
  getAuditLogCount,
  isIpBlocked,
  getBlockedIps,
  blockIp,
  unblockIp,
  
  // Folders
  createFolder,
  getFolderById,
  getFolder: getFolderById,
  getFoldersByParent,
  getAllFolders,
  getTrashedFolders,
  getAllTrashedFolders,
  updateFolder,
  deleteFolder,
  searchFolders,
  
  // Files
  createFile,
  getFileById,
  getFile: getFileById,
  getFilesByFolder,
  getAllFiles,
  getStarredFiles,
  getRecentFiles,
  getTrashedFiles,
  getAllTrashedFiles,
  updateFile,
  deleteFilePermanently,
  searchFiles,
  
  // Sharing
  getFileByShareToken,
  incrementShareViews,
  updateFileShare,
  revokeFileShare,
  
  // Chunks & Replicas
  addFileChunk,
  getFileChunks,
  addChunkReplica,
  getChunkReplicas,
  getFileReplicas,
  getFileChunkWithReplicas,
  getAllFileChunksWithReplicas,
  
  // Replication Queue
  createReplicationJob,
  getPendingReplicationJobs,
  updateReplicationJob,
  deleteReplicationJob,
  getReplicationJobsByFile,
  
  // Settings & Storage
  getSetting,
  setSetting,
  getAllSettings,
  setMultipleSettings,
  getStorageStats,
  recalculateUserStorage,
  getUserDetailedStorageStats,
  getUserStorageBreakdown,
  getUserLargestFiles,
  getUserRecentStorageActivity,
  
  // Backups
  getLatestBackup,
  getAllBackups,
  addBackup,
  getBackupById,
  getBackupByRemoteId,
  getUserBackupById,
  deleteBackup,
  exportUserData,
  importUserData
};
