const bcrypt = require('bcryptjs');
const db = require('../db');
const sessionTracker = require('../services/sessionTracker');

async function webdavAuth(req, res, next) {
  if (db.isIpBlocked && db.isIpBlocked(req.ip)) {
    db.logAuditEvent({ action: 'WEBDAV_BLOCKED_IP', ipAddress: req.ip, userAgent: req.get('User-Agent'), details: { method: req.method, path: req.path } });
    return res.status(403).send('Access denied from this IP address');
  }
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_HTTPS !== 'false' && !req.secure) {
    return res.status(426).send('HTTPS is required for WebDAV');
  }
  if (db.getSetting('webdav_enabled') === 'false' || process.env.WEBDAV_ENABLED === 'false') {
    return res.status(503).send('WebDAV is disabled');
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
  const firstColon = credentials.indexOf(':');
  if (firstColon === -1) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
    return res.status(401).send('Invalid credentials format');
  }

  const emailOrUser = credentials.substring(0, firstColon).trim();
  const password = credentials.substring(firstColon + 1);

  if (!emailOrUser || !password) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
    return res.status(401).send('Invalid credentials');
  }

  try {
    // Each user signs into WebDAV with their own email as username
    const user = db.getUserByEmail(emailOrUser.toLowerCase()) ||
      (db.getAllUsers ? (db.getAllUsers() || []).map(u => db.getUserById(u.id) || u).find(u => db.getSetting('webdav_username', u.id) === emailOrUser) : null);
    if (!user || user.status === 'suspended') {
      res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
      return res.status(401).send('Invalid credentials');
    }
    if (db.getSetting('webdav_user_enabled', user.id) === 'false') {
      return res.status(403).send('WebDAV access is disabled for this user');
    }
    if (db.getSetting('maintenance_mode') === 'true' && user.role !== 'admin') return res.status(503).send('Service is in maintenance mode');
    if (sessionTracker.isRevoked(req.ip, req.get('User-Agent') || 'Generic-WebDAV', user.email)) return res.status(401).send('This WebDAV device session has been revoked');

    // 1. Check per-user dedicated WebDAV password first
    const perUserPassHash = db.getSetting('webdav_user_password_hash', user.id);
    if (perUserPassHash) {
      const match = await bcrypt.compare(password, perUserPassHash);
      if (!match) {
        res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
        return res.status(401).send('Invalid credentials');
      }
      req.user = user;
      sessionTracker.trackWebDavRequest(req, user.email);
      return next();
    }

    // 2. Fallback: use the user's main CloudDrive account password
    const accountMatch = await bcrypt.compare(password, user.password_hash);
    if (!accountMatch) {
      res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
      return res.status(401).send('Invalid credentials');
    }

    req.user = user;
    sessionTracker.trackWebDavRequest(req, user.email);
    next();
  } catch (err) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudDrive WebDAV Vault"');
    return res.status(401).send('Authentication error');
  }
}

module.exports = webdavAuth;
