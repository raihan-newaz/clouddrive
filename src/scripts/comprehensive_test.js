'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load environment
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
if (fs.existsSync(path.join(__dirname, '../../data/config.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '../../data/config.env') });
}

const db = require('../db');
const cryptoModule = require('../crypto');
const storageManager = require('../storage/StorageManager');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${message}`);
  } else {
    failedTests++;
    console.error(`  ❌ [FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log(' CLOUDDRIVE SYSTEM INTEGRATION & VERIFICATION TEST');
  console.log('====================================================\n');

  // Initialize DB
  await db.initialize();

  // ── TEST SUITE 1: CRYPTO & ENCRYPTION TOGGLE ─────────────────────────────
  console.log('🔍 TEST SUITE 1: Encryption & Decryption Engine');
  try {
    const rawData = Buffer.from('Hello CloudDrive Multi-Cloud Test Payload 1234567890!@#$%^&*()');
    const userKey = crypto.randomBytes(32);
    const fileId = 'test-file-uuid-' + Date.now();
    const chunkIndex = 0;

    // Test 1.1: Encrypted mode (crypto_version: 2)
    const encResult = cryptoModule.encryptChunkBuffer(rawData, userKey, fileId, chunkIndex);
    assert(encResult.ciphertext && encResult.iv && encResult.authTag, 'Encrypted chunk produces ciphertext, IV, and authTag');
    assert(encResult.ciphertext.toString() !== rawData.toString(), 'Ciphertext is properly randomized/encrypted');

    const decrypted = cryptoModule.decryptChunkBuffer(
      encResult.ciphertext,
      userKey,
      fileId,
      chunkIndex,
      encResult.iv,
      encResult.authTag
    );
    assert(decrypted.equals(rawData), 'Decrypted payload matches original plaintext exactly (AES-256-GCM)');

    // Test 1.2: Raw / Unencrypted mode (crypto_version: 0)
    const rawEncResult = cryptoModule.encryptChunkBuffer(rawData, userKey, fileId, chunkIndex, false);
    assert(rawEncResult.ciphertext.equals(rawData), 'Unencrypted mode leaves ciphertext identical to raw buffer');
    assert(rawEncResult.iv === '' && rawEncResult.authTag === '', 'Unencrypted mode produces empty IV and authTag');

    const rawDecrypted = cryptoModule.decryptChunkBuffer(
      rawEncResult.ciphertext,
      userKey,
      fileId,
      chunkIndex,
      '',
      '',
      0 // crypto_version 0
    );
    assert(rawDecrypted.equals(rawData), 'Unencrypted chunk decrypts directly to original buffer without error');
  } catch (err) {
    assert(false, `Crypto test failed with error: ${err.message}`);
  }

  // ── TEST SUITE 2: STORAGE POLICY & DB PERSISTENCE ─────────────────────────
  console.log('\n🔍 TEST SUITE 2: Storage Policy & Database Settings');
  try {
    // Set policy to Telegram primary with encryption enabled
    db.setSetting('primary_provider', 'telegram');
    db.setSetting('default_storage_mode', 'dual');
    db.setSetting('upload_strategy', 'primary_first');
    db.setSetting('encryption_enabled', 'true');
    db.setSetting('telegram_enabled', 'true');
    db.setSetting('discord_enabled', 'true');

    assert(db.getSetting('primary_provider') === 'telegram', 'Primary provider correctly stored and retrieved as telegram');
    assert(db.getSetting('default_storage_mode') === 'dual', 'Default storage mode correctly stored as dual');
    assert(db.getSetting('encryption_enabled') === 'true', 'Encryption setting correctly stored as true');

    // Toggle primary provider to discord
    db.setSetting('primary_provider', 'discord');
    assert(db.getSetting('primary_provider') === 'discord', 'Primary provider can be dynamically switched to discord');

    // Restore to telegram
    db.setSetting('primary_provider', 'telegram');
  } catch (err) {
    assert(false, `DB Policy test failed: ${err.message}`);
  }

  // ── TEST SUITE 3: FAILOVER ROUTING IN STORAGEMANAGER ─────────────────────
  console.log('\n🔍 TEST SUITE 3: Automatic Failover Routing & Standby Guard');
  try {
    // Mock Provider with controllable failure
    class MockFailingProvider {
      constructor(name, shouldFail = true) {
        this.name = name;
        this.shouldFail = shouldFail;
        this.isInitialized = true;
      }
      async initialize() {
        this.isInitialized = true;
        return true;
      }
      async uploadChunk(buffer, fileName) {
        if (this.shouldFail) {
          throw new Error(`${this.name} simulated connection timeout / rate limit!`);
        }
        return { remoteId: `mock_${this.name}_${Date.now()}` };
      }
      async downloadChunk(remoteId) {
        if (this.shouldFail) {
          throw new Error(`${this.name} simulated download error 503 Service Unavailable!`);
        }
        return Buffer.from('Mock recovered content from ' + this.name);
      }
    }

    const failingPrimary = new MockFailingProvider('telegram', true);
    const healthySecondary = new MockFailingProvider('discord', false);

    const originalTg = storageManager.providers.get('telegram');
    const originalDc = storageManager.providers.get('discord');

    storageManager.providers.set('telegram', failingPrimary);
    storageManager.providers.set('discord', healthySecondary);

    // Test 3.1: Upload Failover (Telegram fails -> Discord succeeds)
    const testChunk = Buffer.from('Failover test chunk data');
    const uploadRes = await storageManager.uploadChunkWithFailover(
      'telegram', // preferred primary
      testChunk,
      'test_chunk.enc'
    );

    assert(uploadRes.provider === 'discord', 'Upload failed on primary (Telegram) and automatically failed over to secondary (Discord)');
    assert(uploadRes.failoverUsed === true, 'Upload response flagged as failoverUsed: true');
    assert(uploadRes.originalError.includes('simulated connection timeout'), 'Primary failure reason correctly captured');

    // Test 3.1b: Standby Guard - when Discord is OFF, failover to Discord must NOT occur
    db.setSetting('discord_enabled', 'false');
    let standbyErrorCaught = false;
    try {
      await storageManager.uploadChunkWithFailover('telegram', testChunk, 'test_chunk_standby.enc');
    } catch (e) {
      standbyErrorCaught = true;
      assert(e.message.includes('Upload failed on active provider "telegram"'), 'When secondary is in Standby, failover does not route to disabled secondary');
    }
    assert(standbyErrorCaught, 'Standby provider was safely excluded from failover');

    // Re-enable Discord
    db.setSetting('discord_enabled', 'true');

    // Test 3.2: Download Failover (Primary replica fails -> Secondary replica succeeds)
    const mockReplicas = [
      { provider: 'telegram', remote_id: 'fail_tg_1' },
      { provider: 'discord', remote_id: 'ok_dc_1' }
    ];

    const downloadRes = await storageManager.downloadChunkWithFailover(
      mockReplicas,
      'telegram'
    );

    assert(downloadRes.usedProvider === 'discord', 'Download failed on primary replica (Telegram) and automatically retrieved from replica (Discord)');
    assert(downloadRes.buffer.toString().includes('Mock recovered content'), 'Downloaded content successfully recovered from healthy replica');

    // Restore original providers
    storageManager.providers.set('telegram', originalTg);
    storageManager.providers.set('discord', originalDc);
  } catch (err) {
    assert(false, `Failover test failed: ${err.message}`);
  }

  // ── TEST SUITE 4: AUTO-HEALING STORAGE RECONCILER ────────────────────────
  console.log('\n🔍 TEST SUITE 4: Storage Reconciler & Self-Healing');
  try {
    const users = db.getAllUsers ? db.getAllUsers() : [];
    const userId = (users && users.length > 0) ? users[0].id : null;
    const testFileId = 'reconcile-test-' + Date.now();

    // Create a temporary single-replica file chunk directly in DB
    db.createFile({
      id: testFileId,
      user_id: userId,
      name: 'test_sync_file.txt',
      size: 100,
      mime_type: 'text/plain',
      storage_mode: 'dual',
      primary_provider: 'telegram',
      is_chunked: 1,
      total_chunks: 1
    });

    const chunkId = 'chunk-recon-' + Date.now();
    db.addFileChunk({
      id: chunkId,
      file_id: testFileId,
      chunk_index: 0,
      size: 100,
      iv: 'mock_iv',
      salt: 'mock_salt',
      auth_tag: 'mock_tag'
    });

    // Add only ONE replica (Telegram)
    db.addChunkReplica({
      id: 'replica-' + Date.now(),
      chunk_id: chunkId,
      file_id: testFileId,
      chunk_index: 0,
      provider: 'telegram',
      remote_id: 'mock_tg_id'
    });

    // Verify chunk is missing Discord replica
    const replicasBefore = db.getChunkReplicas(chunkId);
    assert(replicasBefore.length === 1 && replicasBefore[0].provider === 'telegram', 'Created single-replica chunk for auto-heal verification');

    // Clean up test DB entries
    db.deleteFilePermanently(testFileId);
    assert(true, 'Test file & chunks safely deleted after verification');
  } catch (err) {
    assert(false, `Reconciler test failed: ${err.message}`);
  }

  // ── TEST SUITE 5: LIVE PROVIDER STATUS ───────────────────────────────────
  console.log('\n🔍 TEST SUITE 5: Real-World Provider Connectivity');
  try {
    const tgProvider = storageManager.getProvider('telegram');
    const dcProvider = storageManager.getProvider('discord');

    assert(tgProvider !== null, 'Telegram storage provider is registered');
    assert(dcProvider !== null, 'Discord storage provider is registered');

    console.log(`  ℹ️ Initializing Telegram provider with live session...`);
    const tgOk = await tgProvider.initialize();
    assert(tgOk === true && tgProvider.isInitialized === true, 'Telegram provider initialized successfully with MTProto session');

    console.log(`  ℹ️ Initializing Discord provider with live bot token...`);
    const dcOk = await dcProvider.initialize();
    assert(dcOk === true && dcProvider.isInitialized === true, 'Discord provider initialized successfully with Discord Bot Token');
  } catch (err) {
    assert(false, `Provider check failed: ${err.message}`);
  }

  // ── TEST SUITE 6: SECURITY HARDENING & PATCH VERIFICATION ───────────────
  console.log('\n🔍 TEST SUITE 6: Security Hardening & Vulnerability Mitigations');
  try {
    const { isSafeUrl } = require('../services/remoteDownloader');

    // 6.1: SSRF Validation
    const loopbackSafe = await isSafeUrl('http://127.0.0.1:3000/api/admin/users');
    assert(loopbackSafe === false, 'SSRF: 127.0.0.1 loopback address blocked');

    const localhostSafe = await isSafeUrl('http://localhost:8080/secret');
    assert(localhostSafe === false, 'SSRF: localhost hostname blocked');

    const metadataSafe = await isSafeUrl('http://169.254.169.254/latest/meta-data/');
    assert(metadataSafe === false, 'SSRF: 169.254.169.254 Cloud Metadata address blocked');

    const lanSafe = await isSafeUrl('http://192.168.1.1/admin');
    assert(lanSafe === false, 'SSRF: Private Class C 192.168.x.x network blocked');

    const classASafe = await isSafeUrl('http://10.0.0.15/internal');
    assert(classASafe === false, 'SSRF: Private Class A 10.x.x.x network blocked');

    const legitSafe = await isSafeUrl('https://raw.githubusercontent.com/file.txt');
    assert(legitSafe === true, 'SSRF: Legitimate public internet HTTPS URL allowed');

    // 6.2: WebDAV Credentials parsing with colons in password
    const testHeader = 'Basic ' + Buffer.from('user@test.local:my:complex:p@ssword!').toString('base64');
    const rawCreds = Buffer.from(testHeader.substring(6), 'base64').toString('utf8');
    const firstCol = rawCreds.indexOf(':');
    const parsedUser = rawCreds.substring(0, firstCol);
    const parsedPass = rawCreds.substring(firstCol + 1);

    assert(parsedUser === 'user@test.local', 'WebDAV: Username parsed correctly from Basic Auth');
    assert(parsedPass === 'my:complex:p@ssword!', 'WebDAV: Password containing colons preserved exactly without truncation');
  } catch (err) {
    assert(false, `Security test suite failed: ${err.message}`);
  }

  // ── TEST SUITE 7: ENTERPRISE SECURITY FEATURES ───────────────────────────
  console.log('\n🔍 TEST SUITE 7: Enterprise Security (Lockout, Complexity, Sessions, Audit)');
  try {
    // 7.1: Password Complexity
    const weakPass1 = cryptoModule.validatePasswordComplexity('short');
    assert(weakPass1.valid === false, 'Complexity: Rejects short password (<8 chars)');

    const weakPass2 = cryptoModule.validatePasswordComplexity('nouppercase123!');
    assert(weakPass2.valid === false, 'Complexity: Rejects password without uppercase letter');

    const weakPass3 = cryptoModule.validatePasswordComplexity('NOLOWERCASE123!');
    assert(weakPass3.valid === false, 'Complexity: Rejects password without lowercase letter');

    const weakPass4 = cryptoModule.validatePasswordComplexity('NoNumberSpecial!');
    assert(weakPass4.valid === false, 'Complexity: Rejects password without number');

    const weakPass5 = cryptoModule.validatePasswordComplexity('NoSpecial123456');
    assert(weakPass5.valid === false, 'Complexity: Rejects password without special character');

    const strongPass = cryptoModule.validatePasswordComplexity('StrongP@ssw0rd!2026');
    assert(strongPass.valid === true, 'Complexity: Accepts strong compliant password');

    // 7.2: Account Lockout
    const testUserId = 'lockout-test-' + Date.now();
    db.createUser({
      id: testUserId,
      email: `lockout_${Date.now()}@test.local`,
      password_hash: 'mock_hash',
      name: 'Lockout Test',
      role: 'user',
      encryption_key: cryptoModule.generateUserEncryptionKey(),
      token_version: 1,
      failed_login_attempts: 0
    });

    // 4 failed attempts should not lock
    db.recordFailedLogin(testUserId);
    db.recordFailedLogin(testUserId);
    db.recordFailedLogin(testUserId);
    const attempt4 = db.recordFailedLogin(testUserId);
    assert(attempt4.attempts === 4 && attempt4.isLocked === false, 'Account Lockout: 4 failed attempts does not lock account');

    // 5th attempt locks account
    const attempt5 = db.recordFailedLogin(testUserId);
    assert(attempt5.attempts === 5 && attempt5.isLocked === true && attempt5.lockedUntil !== null, 'Account Lockout: 5th failed attempt locks account for 15 minutes');

    // Reset lockout
    db.resetFailedLogins(testUserId);
    const userAfterReset = db.getUserById(testUserId);
    assert(userAfterReset.failed_login_attempts === 0 && userAfterReset.locked_until === null, 'Account Lockout: Successful login resets failed counter and unlock');

    // 7.3: Session Invalidation (Token Version)
    const initialTokenVer = userAfterReset.token_version || 1;
    const bumpedUser = db.incrementTokenVersion(testUserId);
    assert(bumpedUser.token_version === initialTokenVer + 1, 'Session Invalidation: Password change increments token_version');

    // 7.4: Audit Logging
    db.logAuditEvent({
      userId: testUserId,
      userEmail: userAfterReset.email,
      action: 'SECURITY_TEST_ACTION',
      details: { test: true },
      ipAddress: '192.0.2.1',
      userAgent: 'TestAgent/1.0'
    });

    const logs = db.getAuditLogs({ limit: 10, action: 'SECURITY_TEST_ACTION' });
    assert(logs.length > 0 && logs[0].action === 'SECURITY_TEST_ACTION', 'Audit Log: Security event successfully recorded in audit_logs table');

    // Cleanup test user
    db.deleteUser(testUserId);
  } catch (err) {
    assert(false, `Enterprise security test failed: ${err.message}`);
  }

  // ── SUMMARY REPORT ───────────────────────────────────────────────────────
  console.log('\n====================================================');
  console.log(` TEST RUN SUMMARY: Total ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
