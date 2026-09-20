const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cryptoModule = require('../crypto');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

function safeUser(user) {
  if (!user) return null;
  const { password_hash, encryption_key, token_version, failed_login_attempts, locked_until, ...safe } = user;
  return safe;
}

function parseStorageLimit(val) {
  if (val === undefined || val === null || val === '') return 0;
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) return 0;
  // If <= 100000, user/UI entered in Gigabytes (GB)
  if (num <= 100000) {
    return Math.round(num * 1024 * 1024 * 1024);
  }
  return Math.round(num);
}

// List all users
router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, users });
});

// Create new user (by Admin)
router.post('/users', async (req, res) => {
  const { email, name, password, role, storageLimit, filePrefix, default_storage_mode } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, name, and password are required' });
  }

  const complexity = cryptoModule.validatePasswordComplexity(password);
  if (!complexity.valid) {
    return res.status(400).json({ error: complexity.error });
  }

  const existing = db.getUserByEmail(email.toLowerCase().trim());
  if (existing) {
    return res.status(400).json({ error: 'User with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const encryptionKey = cryptoModule.generateUserEncryptionKey();

  const user = {
    id: uuidv4(),
    email: email.toLowerCase().trim(),
    password_hash: passwordHash,
    name: name.trim(),
    role: role || 'user',
    status: 'active',
    encryption_key: encryptionKey,
    storage_limit: parseStorageLimit(storageLimit),
    storage_used: 0,
    file_prefix: filePrefix ? filePrefix.trim() : null,
    default_storage_mode: default_storage_mode || 'dual',
    token_version: 1,
    failed_login_attempts: 0
  };

  db.createUser(user);

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'ADMIN_USER_CREATED',
    details: { createdUserId: user.id, createdUserEmail: user.email, role: user.role },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.json({ success: true, user: safeUser(user) });
});

// Edit user account
router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, status, storageLimit, filePrefix, default_storage_mode } = req.body;

  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (role !== undefined) updates.role = role;
  if (status !== undefined) updates.status = status;
  if (storageLimit !== undefined) updates.storage_limit = parseStorageLimit(storageLimit);
  if (filePrefix !== undefined) updates.file_prefix = filePrefix ? filePrefix.trim() : null;
  if (default_storage_mode !== undefined) updates.default_storage_mode = default_storage_mode;

  const updated = db.updateUser(id, updates);

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'ADMIN_USER_UPDATED',
    details: { targetUserId: id, updates },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.json({ success: true, user: safeUser(updated) });
});

// Reset user password
router.post('/users/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ error: 'New password is required' });
  }

  const complexity = cryptoModule.validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return res.status(400).json({ error: complexity.error });
  }

  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  
  // Invalidate all active sessions for that user by incrementing token_version
  db.incrementTokenVersion(id);
  db.updateUser(id, { password_hash: passwordHash, failed_login_attempts: 0, locked_until: null });

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'ADMIN_PASSWORD_RESET',
    details: { targetUserId: id, targetUserEmail: target.email },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.json({ success: true, message: 'Password reset successfully. User sessions have been invalidated.' });
});

// Delete user account
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own administrator account' });
  }

  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Fetch all user's files and replicas and delete from Discord & Telegram
  try {
    const userFiles = db.get('SELECT id FROM files WHERE user_id = ?', [id]) ? db.all('SELECT id FROM files WHERE user_id = ?', [id]) : [];
    const storageManager = require('../storage/StorageManager');
    const replicationWorker = require('../services/replicationWorker');

    for (const f of userFiles) {
      replicationWorker.cancelFileReplication(f.id);
      const replicas = db.getFileReplicas(f.id);
      if (replicas && replicas.length > 0) {
        await storageManager.deleteChunkReplicas(replicas).catch(err => {
          console.warn(`[Admin] Chunk deletion error during user deletion (${f.id}):`, err.message);
        });
      }
    }
  } catch (cleanErr) {
    console.warn(`[Admin] Error cleaning user cloud chunks for user ${id}:`, cleanErr.message);
  }

  db.deleteUser(id);

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'ADMIN_USER_DELETED',
    details: { deletedUserId: id, deletedUserEmail: target.email },
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.json({ success: true, message: 'User deleted and all cloud chunk replicas purged.' });
});

// Security Audit Logs
router.get('/audit-logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const action = req.query.action || null;
    const userId = req.query.userId || null;

    const logs = db.getAuditLogs({ limit, offset, userId, action });
    const total = db.getAuditLogCount({ userId, action });

    res.json({
      success: true,
      logs,
      total,
      limit,
      offset
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve audit logs: ' + err.message });
  }
});

// Admin Storage Reconcile & Cross-Cloud Auto-Heal (System-wide)
router.post('/storage/reconcile', async (req, res) => {
  try {
    const storageReconciler = require('../services/storageReconciler');
    const result = await storageReconciler.scanAndHealMissingReplicas(null);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[Admin Storage API] Reconcile error:', error);
    res.status(500).json({ error: 'Failed to execute storage reconciliation: ' + error.message });
  }
});

// Admin Storage Overview Stats
router.get('/storage/stats', async (req, res) => {
  try {
    const storageReconciler = require('../services/storageReconciler');
    const syncStatus = await storageReconciler.getSyncStatus(null);
    res.json({ success: true, stats: syncStatus });
  } catch (error) {
    console.error('[Admin Storage API] Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch admin storage stats: ' + error.message });
  }
});

module.exports = router;
