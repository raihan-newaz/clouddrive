const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const sessionTracker = require('../services/sessionTracker');

function maintenanceMode(req, res, next) {
  if (db.getSetting('maintenance_mode') !== 'true') return next();
  // Login must remain available so an administrator can enter the system.
  if (req.path === '/api/auth/login') return next();
  const bearer = req.get('authorization');
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : req.cookies?.token;
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    const user = db.getUserById(decoded.id || decoded.userId);
    if (user?.role === 'admin' && Number(decoded.tokenVersion) === Number(user.token_version || 1) && !sessionTracker.isBrowserSessionRevoked(decoded.sid)) return next();
  } catch (_) { /* maintenance response below */ }
  if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Service is in maintenance mode. Administrator access only.' });
  return res.status(503).send('Service is in maintenance mode. Administrator access only.');
}
module.exports = maintenanceMode;
