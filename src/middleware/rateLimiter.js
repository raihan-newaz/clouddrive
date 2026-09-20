const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 30,
  message: { error: 'Too many login attempts, please try again later.' }
});

const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: 'Upload rate limit exceeded, please slow down.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300,
  message: { error: 'API rate limit exceeded.' }
});

const webdavLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many WebDAV authentication attempts'
});

module.exports = {
  authLimiter,
  uploadLimiter,
  apiLimiter,
  webdavLimiter
};
