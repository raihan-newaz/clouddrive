const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const cryptoModule = require('../crypto');
const config = require('../config');
const { authLimiter } = require('../middleware/rateLimiter');
const authMiddleware = require('../middleware/auth');
const sessionTracker = require('../services/sessionTracker');
const { notifySecurityEvent } = require('../services/notificationService');

const router = express.Router();

function safeUser(user) {
  if (!user) return null;
  const { password_hash, encryption_key, token_version, failed_login_attempts, locked_until, ...safe } = user;
  return safe;
}

function normalizeNameParts(firstName, lastName, legacyName = '') {
  let first = String(firstName || '').trim();
  let last = String(lastName || '').trim();
  if (!first && legacyName) {
    const parts = String(legacyName).trim().split(/\s+/);
    first = parts.shift() || '';
    last = parts.join(' ');
  }
  return { first, last, name: [first, last].filter(Boolean).join(' ') };
}

// Register (first user becomes admin)
router.post('/register', authLimiter, async (req, res) => {
  return res.status(403).json({
    error: 'Public registration is disabled. New accounts must be created by an administrator.'
  });
});

// Login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (db.isIpBlocked && db.isIpBlocked(req.ip)) {
    db.logAuditEvent({ userEmail: email ? String(email).toLowerCase().trim() : null, action: 'LOGIN_BLOCKED_IP', ipAddress: req.ip, userAgent: req.get('User-Agent') });
    notifySecurityEvent('Suspicious login blocked', { email, ip: req.ip, reason: 'IP is blocked' });
    return res.status(403).json({ error: 'Access denied from this IP address' });
  }
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const user = db.getUserByEmail(cleanEmail);
  if (!user) {
    db.logAuditEvent({
      userEmail: cleanEmail,
      action: 'LOGIN_FAILED',
      details: 'User not found',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Check Account Lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(user.locked_until) - new Date()) / 60000));
    db.logAuditEvent({
      userId: user.id,
      userEmail: user.email,
      action: 'LOGIN_BLOCKED_LOCKED',
      details: { lockedUntil: user.locked_until, minutesRemaining: mins },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(403).json({ error: `Account is temporarily locked due to multiple failed login attempts. Please try again in ${mins} minute(s).` });
  }

  if (user.status === 'suspended') {
    db.logAuditEvent({
      userId: user.id,
      userEmail: user.email,
      action: 'LOGIN_BLOCKED_SUSPENDED',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(403).json({ error: 'Account is suspended. Please contact administrator.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    const lockInfo = db.recordFailedLogin(user.id);
    db.logAuditEvent({
      userId: user.id,
      userEmail: user.email,
      action: lockInfo && lockInfo.isLocked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
      details: { attempts: lockInfo ? lockInfo.attempts : 1 },
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });

    if (lockInfo && lockInfo.isLocked) {
      notifySecurityEvent('Account locked after failed logins', { email: user.email, ip: req.ip, attempts: lockInfo.attempts });
      return res.status(403).json({ error: 'Account has been temporarily locked for 15 minutes due to 5 consecutive failed login attempts.' });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Login Succeeded - Reset lockout counters
  if (db.getSetting('maintenance_mode') === 'true' && user.role !== 'admin') {
    db.logAuditEvent({ userId: user.id, userEmail: user.email, action: 'LOGIN_BLOCKED_MAINTENANCE', ipAddress: req.ip, userAgent: req.get('User-Agent') });
    return res.status(503).json({ error: 'The service is currently in maintenance mode.' });
  }
  db.resetFailedLogins(user.id);
  db.updateUser(user.id, { last_login_at: new Date().toISOString() });
  const sessionId = sessionTracker.createBrowserSession(user, req);

  db.logAuditEvent({
    userId: user.id,
    userEmail: user.email,
    action: 'LOGIN_SUCCESS',
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, tokenVersion: user.token_version || 1, sid: sessionId },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  return res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      first_name: user.first_name || '', firstName: user.first_name || '',
      last_name: user.last_name || '', lastName: user.last_name || '',
      role: user.role,
      status: user.status,
      file_prefix: user.file_prefix,
      filePrefix: user.file_prefix,
      storage_limit: user.storage_limit || 0,
      storageLimit: user.storage_limit || 0,
      storage_used: user.storage_used || 0,
      storageUsed: user.storage_used || 0,
      default_storage_mode: user.default_storage_mode || 'dual',
      defaultStorageMode: user.default_storage_mode || 'dual',
      created_at: user.created_at
    }
  });
});

// Verify Auth Token & Return Current User Profile
router.get('/verify', authMiddleware, (req, res) => {
  sessionTracker.track(req.user.id, req);
  const preferences = db.getAllSettings(req.user.id);
  const storageUsed = db.recalculateUserStorage(req.user.id);

  // Refresh the auth cookie on every verify to keep session alive
  const freshToken = jwt.sign(
    { id: req.user.id, email: req.user.email, role: req.user.role, tokenVersion: req.user.token_version || 1 },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', freshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  return res.json({
    valid: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      first_name: req.user.first_name || '', firstName: req.user.first_name || '',
      last_name: req.user.last_name || '', lastName: req.user.last_name || '',
      role: req.user.role,
      status: req.user.status,
      storageLimit: req.user.storage_limit || 0,
      storage_limit: req.user.storage_limit || 0,
      storageUsed,
      storage_used: storageUsed,
      filePrefix: req.user.file_prefix,
      file_prefix: req.user.file_prefix,
      defaultStorageMode: req.user.default_storage_mode || 'dual',
      default_storage_mode: req.user.default_storage_mode || 'dual',
      created_at: req.user.created_at
    },
    preferences
  });
});

// Refresh Auth Token
router.post('/refresh', authMiddleware, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, email: req.user.email, role: req.user.role, tokenVersion: req.user.token_version || 1 },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  return res.json({ success: true });
});

// Get Current User Profile
router.get('/me', authMiddleware, (req, res) => {
  sessionTracker.track(req.user.id, req);
  const preferences = db.getAllSettings(req.user.id);
  const storageUsed = db.recalculateUserStorage(req.user.id);
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      first_name: req.user.first_name || '', firstName: req.user.first_name || '',
      last_name: req.user.last_name || '', lastName: req.user.last_name || '',
      role: req.user.role,
      status: req.user.status,
      storage_limit: req.user.storage_limit || 0,
      storageLimit: req.user.storage_limit || 0,
      storage_used: storageUsed,
      storageUsed,
      file_prefix: req.user.file_prefix,
      filePrefix: req.user.file_prefix,
      default_storage_mode: req.user.default_storage_mode || 'dual',
      defaultStorageMode: req.user.default_storage_mode || 'dual',
      created_at: req.user.created_at
    },
    preferences,
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    status: req.user.status,
    storage_limit: req.user.storage_limit || 0,
    storageLimit: req.user.storage_limit || 0,
    storage_used: storageUsed,
    storageUsed,
    file_prefix: req.user.file_prefix,
    filePrefix: req.user.file_prefix,
    default_storage_mode: req.user.default_storage_mode || 'dual',
    defaultStorageMode: req.user.default_storage_mode || 'dual',
    created_at: req.user.created_at
  });
});

// Update Profile
router.put('/profile', authMiddleware, async (req, res) => {
  const { name, firstName, first_name, lastName, last_name, email, filePrefix, file_prefix, default_storage_mode, defaultStorageMode } = req.body;
  const updates = {};
  if (firstName !== undefined || first_name !== undefined || lastName !== undefined || last_name !== undefined || name !== undefined) {
    const parts = normalizeNameParts(firstName !== undefined ? firstName : first_name, lastName !== undefined ? lastName : last_name, name || req.user.name);
    if (parts.first.length < 1 || parts.first.length > 50 || parts.last.length > 100 || parts.name.length > 150) return res.status(400).json({ error: 'First name is required and both names must be valid' });
    updates.first_name = parts.first;
    updates.last_name = parts.last;
    updates.name = parts.name;
  }
  if (email !== undefined) {
    const cleanEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return res.status(400).json({ error: 'Valid email address is required' });
    const existing = db.getUserByEmail(cleanEmail);
    if (existing && existing.id !== req.user.id) return res.status(409).json({ error: 'This email address is already in use' });
    updates.email = cleanEmail;
  }
  const prefix = filePrefix !== undefined ? filePrefix : file_prefix;
  if (prefix !== undefined) {
    updates.file_prefix = prefix ? prefix.trim() : null;
    db.setSetting('file_prefix', updates.file_prefix || '', req.user.id);
  }
  const storageMode = default_storage_mode !== undefined ? default_storage_mode : defaultStorageMode;
  if (storageMode !== undefined) {
    if (!['discord', 'telegram', 'dual'].includes(storageMode)) return res.status(400).json({ error: 'Invalid storage mode' });
    updates.default_storage_mode = storageMode;
    db.setSetting('default_storage_mode', storageMode, req.user.id);
  }

  const updated = db.updateUser(req.user.id, updates);
  res.json({
    success: true,
    user: {
      ...safeUser(updated),
      filePrefix: updated.file_prefix,
      file_prefix: updated.file_prefix,
      defaultStorageMode: updated.default_storage_mode,
      default_storage_mode: updated.default_storage_mode,
      storageLimit: updated.storage_limit || 0,
      storage_limit: updated.storage_limit || 0,
      storageUsed: updated.storage_used || 0,
      storage_used: updated.storage_used || 0
    }
  });
});

// Change Password (with Complexity Enforcement & Token Invalidation)
router.post('/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }

  const match = await bcrypt.compare(currentPassword, req.user.password_hash);
  if (!match) {
    db.logAuditEvent({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'PASSWORD_CHANGE_FAILED',
      details: 'Current password incorrect',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const complexity = cryptoModule.validatePasswordComplexity(newPassword);
  if (!complexity.valid) {
    return res.status(400).json({ error: complexity.error });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  
  // Increment token version to invalidate old JWT tokens on other devices
  db.incrementTokenVersion(req.user.id);
  db.updateUser(req.user.id, { password_hash: passwordHash });

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'PASSWORD_CHANGED',
    details: 'Password changed successfully; other sessions invalidated',
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Issue fresh token for current session
  const freshUser = db.getUserById(req.user.id);
  const token = jwt.sign(
    { id: freshUser.id, email: freshUser.email, role: freshUser.role, tokenVersion: freshUser.token_version || 1 },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({ success: true, message: 'Password updated successfully! Other device sessions have been signed out.' });
});

// Logout from All Devices (Invalidates all active tokens)
router.post('/logout-all', authMiddleware, (req, res) => {
  db.incrementTokenVersion(req.user.id);

  db.logAuditEvent({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'ALL_SESSIONS_REVOKED',
    details: 'User revoked all active device sessions',
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  });

  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });

  res.json({ success: true, message: 'All active sessions across all devices have been signed out.' });
});

// Logout
router.post('/logout', (req, res) => {
  if (req.user) {
    db.logAuditEvent({
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'LOGOUT',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    });
  }

  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
  res.json({ success: true, message: 'Logged out' });
});

module.exports = router;
