const crypto = require('crypto');
const config = require('./config');

function generateFolderToken(folderId, userId) {
  return crypto.createHmac('sha256', config.JWT_SECRET)
    .update(`folder_access:${userId}:${folderId}`)
    .digest('hex');
}

function verifyFolderToken(folderId, userId, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = generateFolderToken(folderId, userId);
  const actual = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

module.exports = { generateFolderToken, verifyFolderToken };
