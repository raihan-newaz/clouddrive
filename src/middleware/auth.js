const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const sessionTracker = require('../services/sessionTracker');

function authMiddleware(req, res, next) {
  if (db.isIpBlocked && db.isIpBlocked(req.ip)) return res.status(403).json({ error: 'Access denied from this IP address' });
  // Allow token from Authorization header or cookie
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const user = db.getUserById(decoded.id || decoded.userId);
    if (!user || user.status === 'suspended') {
      return res.status(403).json({ error: 'User account is inactive or not found' });
    }

    // Check account lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesRemaining = Math.max(1, Math.ceil((new Date(user.locked_until) - new Date()) / 60000));
      return res.status(403).json({ error: `Account is temporarily locked. Please try again in ${minutesRemaining} minute(s).` });
    }

    // Check session invalidation (token_version)
    if (Number(decoded.tokenVersion) !== Number(user.token_version || 1)) {
      return res.status(401).json({ error: 'Session has been invalidated. Please log in again.' });
    }
    if (sessionTracker.isBrowserSessionRevoked(decoded.sid)) {
      return res.status(401).json({ error: 'This device session has been revoked. Please log in again.' });
    }

    req.user = user;
    req.authSessionId = decoded.sid || null;
    sessionTracker.track(user.id, req, decoded.sid, user.email);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator privileges required' });
  }
  next();
}

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.adminOnly = adminOnly;
