const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cryptoModule = require('../crypto');
const cacheManager = require('../services/cacheManager');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');
const sessionTracker = require('../services/sessionTracker');
const { notifySecurityEvent } = require('../services/notificationService');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);
const recentTestAlerts = new Map();

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

// Dashboard summary stays in the admin API so the browser never needs database access.
router.get('/stats', (req, res) => {
  try {
    const users = db.get('SELECT COUNT(*) AS count FROM users')?.count || 0;
    const activeUsers = db.get("SELECT COUNT(*) AS count FROM users WHERE status = 'active'")?.count || 0;
    const files = db.get('SELECT COUNT(*) AS count FROM files WHERE COALESCE(is_trashed, 0) = 0')?.count || 0;
    const storageUsed = db.get('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE COALESCE(is_trashed, 0) = 0')?.total || 0;
    const blockedIps = db.get('SELECT COUNT(*) AS count FROM blocked_ips')?.count || 0;
    const securityEvents = db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE created_at >= datetime('now', '-24 hours')")?.count || 0;
    res.json({ success: true, stats: { users, activeUsers, files, storageUsed, blockedIps, securityEvents } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load dashboard stats: ' + error.message });
  }
});

router.get('/maintenance', (req, res) => res.json({ success: true, enabled: db.getSetting('maintenance_mode') === 'true' }));
router.put('/maintenance', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  db.setSetting('maintenance_mode', enabled ? 'true' : 'false');
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED', ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.json({ success: true, enabled });
});

// Clears the application-side cache and returns a new deployment revision.
// Reverse proxies honor the no-cache headers set by server.js on the next reload.
router.post('/refresh-ui-cache', (req, res) => {
  const revision = String(Date.now());
  const cacheCleared = cacheManager.clear();
  db.setSetting('ui_cache_revision', revision);
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'UI_CACHE_REFRESHED', details: { revision, cacheCleared }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, revision, cacheCleared, message: 'Application cache cleared. Reloading fresh interface assets.' });
});

router.get('/sessions', (req, res) => {
  const sessions = sessionTracker.getActiveSessions().map(session => ({ ...session, isCurrent: session.id === req.authSessionId }));
  res.json({ success: true, sessions });
});
router.post('/sessions/:id/revoke', (req, res) => {
  const session = sessionTracker.getActiveSessions().find(item => item.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or server was restarted' });
  sessionTracker.revokeSession(session.id);
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'DEVICE_SESSION_REVOKED', details: { sessionId: session.id, type: session.type, username: session.username }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.json({ success: true });
});

router.get('/notification-settings', (req, res) => {
  res.json({ success: true, settings: {
    enabled: db.getSetting('alerts_enabled') !== 'false', telegram: db.getSetting('alert_telegram_enabled') !== 'false',
    discord: db.getSetting('alert_discord_enabled') !== 'false', email: db.getSetting('alert_email_enabled') !== 'false',
    emailTo: db.getSetting('alert_email_to') || process.env.ALERT_EMAIL_TO || '',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && (process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHANNEL_ID)),
    discordConfigured: Boolean(process.env.DISCORD_BOT_TOKEN && (process.env.DISCORD_ALERT_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID)),
    emailConfigured: Boolean(process.env.SMTP_HOST && (db.getSetting('alert_email_to') || process.env.ALERT_EMAIL_TO))
  } });
});
router.put('/notification-settings', (req, res) => {
  const body = req.body || {};
  [['alerts_enabled', body.enabled], ['alert_telegram_enabled', body.telegram], ['alert_discord_enabled', body.discord], ['alert_email_enabled', body.email]].forEach(([key, value]) => {
    if (typeof value === 'boolean') db.setSetting(key, value ? 'true' : 'false');
  });
  if (body.emailTo !== undefined) {
    const email = String(body.emailTo).trim();
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) return res.status(400).json({ error: 'Valid alert email is required' });
    db.setSetting('alert_email_to', email);
  }
  db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'NOTIFICATION_SETTINGS_UPDATED', ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.json({ success: true });
});
router.post('/notification-settings/test', async (req, res) => {
  const channel = String(req.body?.channel || 'telegram').toLowerCase();
  if (!['telegram', 'discord', 'email'].includes(channel)) return res.status(400).json({ error: 'Choose Telegram, Discord, or email for the test.' });

  const key = `${req.user.id}:${channel}`;
  const now = Date.now();
  if (now - (recentTestAlerts.get(key) || 0) < 15000) {
    return res.status(429).json({ error: 'A test was already sent. Please wait 15 seconds before sending another.' });
  }
  recentTestAlerts.set(key, now);
  const result = await notifySecurityEvent('Notification test', { by: req.user.email, time: new Date().toISOString() }, { channels: [channel] });
  if (!result?.attempted) return res.status(400).json({ error: `No active ${channel} alert destination is configured.` });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, message: `One test alert sent through ${channel}.`, result });
});

// List all users
router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, users });
});

// Create new user (by Admin)
router.post('/users', async (req, res) => {
  const { email, firstName, first_name, lastName, last_name, name, password, role, storageLimit, filePrefix, default_storage_mode } = req.body;
  const first = String(firstName !== undefined ? firstName : first_name || '').trim();
  const last = String(lastName !== undefined ? lastName : last_name || '').trim();
  const displayName = [first, last].filter(Boolean).join(' ') || String(name || '').trim();
  if (!email || !password || !first) {
    return res.status(400).json({ error: 'Email, first name, and password are required' });
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
    name: displayName,
    first_name: first,
    last_name: last,
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
  const { firstName, first_name, lastName, last_name, name, role, status, storageLimit, filePrefix, default_storage_mode } = req.body;

  const target = db.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const updates = {};
  if (firstName !== undefined || first_name !== undefined || lastName !== undefined || last_name !== undefined || name !== undefined) {
    const first = String(firstName !== undefined ? firstName : first_name !== undefined ? first_name : target.first_name || '').trim();
    const last = String(lastName !== undefined ? lastName : last_name !== undefined ? last_name : target.last_name || '').trim();
    const displayName = [first, last].filter(Boolean).join(' ') || String(name || target.name || '').trim();
    if (!first) return res.status(400).json({ error: 'First name is required' });
    updates.first_name = first;
    updates.last_name = last;
    updates.name = displayName;
  }
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
    const user = req.query.user || null;
    const file = req.query.file || null;
    const ip = req.query.ip || null;
    const search = req.query.search || null;

    const filters = { limit, offset, userId, action, user, file, ip, search };
    const logs = db.getAuditLogs(filters);
    const total = db.getAuditLogCount(filters);

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

router.get('/blocked-ips', (req, res) => res.json({ success: true, blockedIps: db.getBlockedIps() }));
router.post('/blocked-ips', (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (!ip || ip.length > 64) return res.status(400).json({ error: 'Valid IP address is required' });
  if (ip === req.ip || ip === String(req.ip || '').replace(/^::ffff:/, '')) {
    return res.status(400).json({ error: 'You cannot block the IP address of your current admin session' });
  }
  db.blockIp(ip, String(req.body?.reason || '').slice(0, 200), req.user.id);
  db.logAuditEvent({ userId: req.user.id, action: 'IP_BLOCKED', details: { ip }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.json({ success: true });
});
router.delete('/blocked-ips/:ip', (req, res) => {
  db.unblockIp(req.params.ip);
  db.logAuditEvent({ userId: req.user.id, action: 'IP_UNBLOCKED', details: { ip: req.params.ip }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
  res.json({ success: true });
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
