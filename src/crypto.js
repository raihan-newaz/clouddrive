const crypto = require('crypto');
const fs = require('fs');

const MASTER_SALT_DEFAULT = 'clouddrive-master-salt-v2';
const masterKeyCache = new Map();
const MAX_MASTER_KEY_CACHE = 1000;

/**
 * Derives a 32-byte Master Key from passphrase and salt using PBKDF2-SHA512
 * Results are memoized in memory for 0ms reuse across sessions.
 * @param {string} passphrase - User passphrase or master secret
 * @param {string|Buffer} [salt] - Optional salt (default fixed string for deterministic master key)
 * @returns {Buffer} 32-byte Master Key
 */
function deriveMasterKey(passphrase, salt = null) {
  const saltBuf = salt
    ? (Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'base64'))
    : Buffer.from(MASTER_SALT_DEFAULT, 'utf8');

  const cacheKey = `${passphrase}::${saltBuf.toString('base64')}`;
  if (masterKeyCache.has(cacheKey)) {
    return masterKeyCache.get(cacheKey);
  }

  const derived = crypto.pbkdf2Sync(passphrase, saltBuf, 310000, 32, 'sha512');
  if (masterKeyCache.size >= MAX_MASTER_KEY_CACHE) {
    const first = masterKeyCache.keys().next().value;
    masterKeyCache.delete(first);
  }
  masterKeyCache.set(cacheKey, derived);
  return derived;
}

/**
 * Derives a 32-byte File Key from Master Key using HKDF-SHA256
 * @param {string|Buffer} masterOrUserKey - Master key or user encryption key
 * @param {string} fileId - Unique file ID for domain separation
 * @param {Buffer} [fileSalt] - Optional salt buffer (default empty buffer)
 * @returns {Buffer} 32-byte File Key
 */
function deriveFileKey(masterOrUserKey, fileId, fileSalt = Buffer.alloc(0)) {
  const keyBuf = Buffer.isBuffer(masterOrUserKey)
    ? masterOrUserKey
    : (masterOrUserKey.length === 44 && masterOrUserKey.endsWith('=')
        ? Buffer.from(masterOrUserKey, 'base64')
        : deriveMasterKey(masterOrUserKey));

  const info = Buffer.from(`clouddrive/file-key/v2:${fileId || 'default'}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', keyBuf, fileSalt, info, 32));
}

/**
 * Derives a unique 32-byte Chunk Key from File Key using HKDF-SHA256
 * @param {Buffer} fileKey - 32-byte File Key
 * @param {string} fileId - Unique file ID
 * @param {number} chunkIndex - 0-indexed chunk sequence number
 * @returns {Buffer} 32-byte Chunk Key
 */
function deriveChunkKey(fileKey, fileId, chunkIndex) {
  const fileKeyBuf = Buffer.isBuffer(fileKey) ? fileKey : Buffer.from(fileKey, 'utf8');
  const info = Buffer.from(`clouddrive/chunk-key/v2:${fileId || 'default'}:${chunkIndex || 0}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', fileKeyBuf, Buffer.alloc(0), info, 32));
}

/**
 * Generates a random 16-byte salt
 * @returns {string} Salt as base64 string
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Generates a random 12-byte initialization vector (IV) for AES-GCM
 * @returns {string} IV as base64 string
 */
function generateIV() {
  return crypto.randomBytes(12).toString('base64');
}

/**
 * Generates a random 32-byte user encryption key as base64 string
 * @returns {string} 32-byte key in base64 format
 */
function generateUserEncryptionKey() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Computes SHA-256 hash of a buffer or string
 * @param {Buffer|string} data - Input data
 * @returns {string} Hex SHA-256 digest
 */
function calculateSha256(data) {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Computes SHA-256 hash of a file on disk
 * @param {string} filePath - Absolute path to file
 * @returns {Promise<string>} Hex SHA-256 digest
 */
function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Encrypts a chunk buffer in memory using HKDF-derived chunk key and AES-256-GCM.
 * If encryption is disabled by user setting, returns plaintext buffer with crypto_version: 0.
 * @param {Buffer} plainBuffer - Plaintext chunk data
 * @param {string|Buffer} userOrFileKey - User encryption key or master key
 * @param {string} fileId - File UUID
 * @param {number} chunkIndex - Chunk index (0, 1, 2, ...)
 * @param {boolean} [isEncryptionEnabled=true] - Whether encryption is enabled
 * @returns {{ ciphertext: Buffer, iv: string, authTag: string, sha256: string, crypto_version: number }}
 */
function encryptChunkBuffer(plainBuffer, userOrFileKey, fileId, chunkIndex = 0, isEncryptionEnabled = true) {
  if (isEncryptionEnabled === false) {
    const sha256 = calculateSha256(plainBuffer);
    return {
      ciphertext: plainBuffer,
      iv: '',
      authTag: '',
      sha256,
      crypto_version: 0
    };
  }

  const fileKey = deriveFileKey(userOrFileKey, fileId);
  const chunkKey = deriveChunkKey(fileKey, fileId, chunkIndex);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', chunkKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const sha256 = calculateSha256(ciphertext);

  return {
    ciphertext,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    sha256,
    crypto_version: 2
  };
}

/**
 * Decrypts a chunk buffer in memory using HKDF-derived chunk key and AES-256-GCM.
 * If crypto_version is 0 or unencrypted, returns plain buffer directly.
 * @param {Buffer} cipherBuffer - Ciphertext chunk data
 * @param {string|Buffer} userOrFileKey - User encryption key or master key
 * @param {string} fileId - File UUID
 * @param {number} chunkIndex - Chunk index
 * @param {string} ivBase64 - IV base64 string
 * @param {string} authTagBase64 - AuthTag base64 string
 * @param {number} [cryptoVersion=2] - Crypto version (0 = unencrypted, 2 = AES-256-GCM)
 * @returns {Buffer} Decrypted plaintext buffer
 */
function decryptChunkBuffer(cipherBuffer, userOrFileKey, fileId, chunkIndex, ivBase64, authTagBase64, cryptoVersion = 2) {
  if (cryptoVersion === 0 || !ivBase64 || !authTagBase64) {
    return cipherBuffer;
  }

  const fileKey = deriveFileKey(userOrFileKey, fileId);
  const chunkKey = deriveChunkKey(fileKey, fileId, chunkIndex);
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', chunkKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
  return plaintext;
}

/**
 * Encrypts a file on disk using HKDF-SHA256 and AES-256-GCM
 * @param {string} inputPath - Path to plaintext file
 * @param {string} outputPath - Path to write encrypted file
 * @param {string|Buffer} passphraseOrKey - Encryption key
 * @param {string} [fileId] - Optional file ID
 * @returns {Promise<{ iv: string, salt: string, authTag: string, sha256: string, crypto_version: number }>}
 */
function encryptFile(inputPath, outputPath, passphraseOrKey, fileId = 'file') {
  return new Promise((resolve, reject) => {
    try {
      const fileKey = deriveFileKey(passphraseOrKey, fileId);
      const chunkKey = deriveChunkKey(fileKey, fileId, 0);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', chunkKey, iv);
      const hash = crypto.createHash('sha256');

      const input = fs.createReadStream(inputPath);
      const output = fs.createWriteStream(outputPath);
      if (fileId === 'db-backup') {
        output.write(Buffer.from('CDV2'));
        output.write(iv);
      }

      input.on('data', chunk => {
        const enc = cipher.update(chunk);
        if (enc.length > 0) {
          hash.update(enc);
          output.write(enc);
        }
      });

      input.on('end', () => {
        const finalEnc = cipher.final();
        if (finalEnc.length > 0) {
          hash.update(finalEnc);
          output.write(finalEnc);
        }
        const authTag = cipher.getAuthTag();
        output.write(authTag);
        output.end();
      });

      output.on('finish', () => {
        resolve({
          iv: iv.toString('base64'),
          salt: MASTER_SALT_DEFAULT,
          authTag: cipher.getAuthTag().toString('base64'),
          sha256: hash.digest('hex'),
          crypto_version: 2
        });
      });

      input.on('error', reject);
      output.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Decrypts a file on disk using HKDF-SHA256 and AES-256-GCM
 * @param {string} inputPath - Path to encrypted file
 * @param {string} outputPath - Path to write decrypted file
 * @param {string|Buffer} passphraseOrKey - Encryption key
 * @param {string} ivBase64 - IV base64
 * @param {string} [authTagBase64] - AuthTag base64 (if not appended to file)
 * @param {string} [fileId] - Optional file ID
 * @returns {Promise<boolean>}
 */
function decryptFile(inputPath, outputPath, passphraseOrKey, ivBase64 = null, authTagBase64 = null, fileId = 'file') {
  return new Promise((resolve, reject) => {
    try {
      const stats = fs.statSync(inputPath);
      let inputStart = 0;
      let iv;
      if (ivBase64) {
        iv = Buffer.from(ivBase64, 'base64');
      } else {
        const header = Buffer.alloc(16);
        const headerFd = fs.openSync(inputPath, 'r');
        fs.readSync(headerFd, header, 0, 16, 0);
        fs.closeSync(headerFd);
        if (header.subarray(0, 4).toString() !== 'CDV2') throw new Error('Encrypted backup is missing its IV header');
        iv = header.subarray(4, 16);
        inputStart = 16;
      }
      const fileKey = deriveFileKey(passphraseOrKey, fileId);
      const chunkKey = deriveChunkKey(fileKey, fileId, 0);

      let tagBuffer = null;
      let cipherLen = stats.size;

      if (authTagBase64) {
        tagBuffer = Buffer.from(authTagBase64, 'base64');
      } else {
        // Last 16 bytes is auth tag
        tagBuffer = Buffer.alloc(16);
        const fd = fs.openSync(inputPath, 'r');
        fs.readSync(fd, tagBuffer, 0, 16, stats.size - 16);
        fs.closeSync(fd);
        cipherLen = stats.size - 16;
      }

      const decipher = crypto.createDecipheriv('aes-256-gcm', chunkKey, iv);
      decipher.setAuthTag(tagBuffer);

      const input = fs.createReadStream(inputPath, { start: inputStart, end: cipherLen - 1 });
      const output = fs.createWriteStream(outputPath);

      input.on('data', chunk => {
        const dec = decipher.update(chunk);
        if (dec.length > 0) output.write(dec);
      });

      input.on('end', () => {
        try {
          const finalDec = decipher.final();
          if (finalDec.length > 0) output.write(finalDec);
          output.end();
        } catch (err) {
          reject(new Error('Decryption integrity check failed: Data was corrupted or tampered.'));
        }
      });

      output.on('finish', () => resolve(true));
      input.on('error', reject);
      output.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Validates password complexity: Min 8 chars, at least 1 uppercase, 1 lowercase, 1 number, and 1 special char
 * @param {string} password
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePasswordComplexity(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'Password is required' };
  }
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter (A-Z)' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one lowercase letter (a-z)' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number (0-9)' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one special character (!@#$%^&*...)' };
  }
  return { valid: true };
}

module.exports = {
  deriveMasterKey,
  deriveFileKey,
  deriveChunkKey,
  generateSalt,
  generateIV,
  generateUserEncryptionKey,
  validatePasswordComplexity,
  calculateSha256,
  calculateFileSha256,
  encryptChunkBuffer,
  decryptChunkBuffer,
  encryptFile,
  decryptFile,
  MASTER_SALT_DEFAULT
};
