const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const crypto = require('../crypto');
const storageManager = require('../storage/StorageManager');
const config = require('../config');
const { notifySecurityEvent } = require('./notificationService');

let backupInterval = null;
let isBackingUp = false;

async function performDatabaseBackup(userId = null, targetProvider = 'all') {
  if (isBackingUp) throw new Error('Backup already in progress');
  isBackingUp = true;

  const dbPath = path.join(config.DATA_DIR, 'clouddrive.db');
  if (!fs.existsSync(dbPath)) {
    isBackingUp = false;
    throw new Error('Database file not found');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `clouddrive-backup-${timestamp}.db.enc`;
  const tempEncPath = path.join(config.TMP_DIR, backupFileName);

  try {
    await crypto.encryptFile(
      dbPath,
      tempEncPath,
      config.ENCRYPTION_KEY,
      'db-backup'
    );

    const stats = fs.statSync(tempEncPath);

    const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
    const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

    if (!isDiscordEnabled && !isTelegramEnabled) {
      throw new Error('Cannot perform database backup: All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings.');
    }

    const providersToUpload = [];
    if (targetProvider === 'all' || !targetProvider) {
      if (isTelegramEnabled) providersToUpload.push('telegram');
      if (isDiscordEnabled) providersToUpload.push('discord');
    } else if (targetProvider === 'telegram' && isTelegramEnabled) {
      providersToUpload.push('telegram');
    } else if (targetProvider === 'discord' && isDiscordEnabled) {
      providersToUpload.push('discord');
    } else {
      if (isTelegramEnabled) providersToUpload.push('telegram');
      else if (isDiscordEnabled) providersToUpload.push('discord');
    }

    const uploadedRecords = [];
    let lastError = null;

    for (const prov of providersToUpload) {
      try {
        const remoteResult = await storageManager.uploadChunk(prov, tempEncPath, backupFileName);
        const backupRecord = {
          id: uuidv4(),
          user_id: userId,
          file_name: backupFileName,
          provider: prov,
          remote_id: remoteResult.remoteId,
          size: stats.size
        };

        db.addBackup(
          backupRecord.id,
          backupRecord.file_name,
          backupRecord.remote_id,
          backupRecord.size,
          backupRecord.provider,
          backupRecord.user_id
        );
        uploadedRecords.push(backupRecord);
        console.log(`[BackupService] Database backup completed successfully on ${prov} (ID: ${remoteResult.remoteId})`);
      } catch (err) {
        console.warn(`[BackupService] Backup upload to ${prov} failed:`, err.message);
        lastError = err;
      }
    }

    try { fs.unlinkSync(tempEncPath); } catch (e) {}

    if (uploadedRecords.length === 0) {
      throw new Error(`Failed to upload backup to any cloud provider: ${lastError ? lastError.message : 'Unknown error'}`);
    }

    const provNames = uploadedRecords.map(r => r.provider === 'telegram' ? 'Telegram' : 'Discord').join(' & ');
    return {
      success: true,
      backups: uploadedRecords,
      backup: uploadedRecords[0],
      message: `Cloud backup created and encrypted successfully on ${provNames}!`
    };
  } catch (err) {
    if (fs.existsSync(tempEncPath)) {
      try { fs.unlinkSync(tempEncPath); } catch (e) {}
    }
    console.error('[BackupService] Database backup failed:', err.message);
    notifySecurityEvent('Backup failure', { scope: userId ? 'user backup' : 'database backup', provider: targetProvider, error: err.message });
    throw err;
  } finally {
    isBackingUp = false;
  }
}

async function restoreBackupFromDiscord(remoteId, providerName = null) {
  return restoreBackup(remoteId, providerName);
}

async function restoreBackup(remoteId, providerName = null) {
  const tempDir = config.TMP_DIR;
  const timestamp = Date.now();
  const encPath = path.join(tempDir, `restore_${timestamp}.enc.db`);
  const decPath = path.join(tempDir, `restore_${timestamp}.db`);
  const activeDbPath = path.join(config.DATA_DIR, 'clouddrive.db');
  const backupDbPath = path.join(config.DATA_DIR, 'clouddrive.db.bak');

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    throw new Error('Cannot restore backup: All storage providers are currently in Standby / Disabled mode. Please enable at least one provider in Settings.');
  }

  try {
    console.log(`[BackupService] Downloading encrypted backup #${remoteId}...`);
    let downloaded = false;
    let lastErr = null;

    const candidateProviders = [];
    if (providerName && (providerName === 'discord' || providerName === 'telegram')) {
      candidateProviders.push(providerName);
    } else {
      const backupRec = db.getBackupByRemoteId ? db.getBackupByRemoteId(remoteId) : null;
      if (backupRec && backupRec.provider) {
        candidateProviders.push(backupRec.provider);
      }
      if (isTelegramEnabled && !candidateProviders.includes('telegram')) candidateProviders.push('telegram');
      if (isDiscordEnabled && !candidateProviders.includes('discord')) candidateProviders.push('discord');
    }

    for (const prov of candidateProviders) {
      const isProvEnabled = db.getSetting(`${prov}_enabled`) !== 'false';
      if (!isProvEnabled) continue;
      try {
        const providerInst = storageManager.getProvider(prov);
        if (!providerInst.isInitialized) await providerInst.initialize();
        const buffer = await providerInst.downloadChunk(remoteId);
        if (buffer && buffer.length > 0) {
          fs.writeFileSync(encPath, buffer);
          downloaded = true;
          break;
        }
      } catch (e) {
        console.warn(`[BackupService] Downloading backup from ${prov} failed:`, e.message);
        lastErr = e;
      }
    }

    if (!downloaded || !fs.existsSync(encPath)) {
      throw new Error(`Failed to download backup file from storage providers: ${lastErr ? lastErr.message : 'No enabled provider available'}`);
    }

    console.log('[BackupService] Decrypting backup file...');
    await crypto.decryptFile(encPath, decPath, config.ENCRYPTION_KEY, null, null, 'db-backup');

    // Create safety backup of active db
    if (fs.existsSync(activeDbPath)) {
      try { fs.copyFileSync(activeDbPath, backupDbPath); } catch (e) {}
    }

    // Replace database
    fs.copyFileSync(decPath, activeDbPath);
    await db.initialize();

    console.log(`[BackupService] Database restored successfully from backup #${remoteId}`);
    return {
      success: true,
      message: 'Database restored successfully from cloud backup!'
    };
  } finally {
    try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch (e) {}
    try { if (fs.existsSync(decPath)) fs.unlinkSync(decPath); } catch (e) {}
  }
}

async function deleteBackup(id, userId = null, isAdmin = false) {
  const backup = db.getBackupById(id);
  if (!backup) {
    throw new Error('Backup record not found');
  }

  if (!isAdmin && userId && backup.user_id && backup.user_id !== userId) {
    throw new Error('Unauthorized: You can only delete your own backups');
  }

  if (backup.provider && backup.remote_id) {
    try {
      const providerInst = storageManager.getProvider(backup.provider);
      if (providerInst) {
        if (!providerInst.isInitialized) await providerInst.initialize();
        await providerInst.deleteChunk(backup.remote_id);
      }
    } catch (e) {
      console.warn(`[BackupService] Remote delete chunk warning (${backup.provider}):`, e.message);
    }
  }

  db.deleteBackup(id);
  return {
    success: true,
    message: 'Cloud backup deleted successfully!'
  };
}

async function performUserBackup(userId, targetProvider = 'all') {
  if (!userId) throw new Error('User ID is required for user backup');
  if (isBackingUp) throw new Error('Backup already in progress');
  isBackingUp = true;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const user = db.getUserById(userId);
  const userSlug = (user?.name || user?.email || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const backupFileName = `user-backup-${userSlug}-${timestamp}.db.enc`;
  const tempJsonPath = path.join(config.TMP_DIR, `user_pkg_${timestamp}.json`);
  const tempEncPath = path.join(config.TMP_DIR, backupFileName);

  try {
    const userPackage = db.exportUserData(userId);
    fs.writeFileSync(tempJsonPath, JSON.stringify(userPackage, null, 2), 'utf8');

    await crypto.encryptFile(
      tempJsonPath,
      tempEncPath,
      config.ENCRYPTION_KEY,
      'db-backup'
    );

    const stats = fs.statSync(tempEncPath);

    const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
    const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

    if (!isDiscordEnabled && !isTelegramEnabled) {
      throw new Error('Cannot perform backup: All storage providers (Discord and Telegram) are currently disabled.');
    }

    const providersToUpload = [];
    if (targetProvider === 'all' || !targetProvider) {
      if (isTelegramEnabled) providersToUpload.push('telegram');
      if (isDiscordEnabled) providersToUpload.push('discord');
    } else if (targetProvider === 'telegram' && isTelegramEnabled) {
      providersToUpload.push('telegram');
    } else if (targetProvider === 'discord' && isDiscordEnabled) {
      providersToUpload.push('discord');
    } else {
      if (isTelegramEnabled) providersToUpload.push('telegram');
      else if (isDiscordEnabled) providersToUpload.push('discord');
    }

    const uploadedRecords = [];
    let lastError = null;

    for (const prov of providersToUpload) {
      try {
        const remoteResult = await storageManager.uploadChunk(prov, tempEncPath, backupFileName);
        const backupRecord = {
          id: uuidv4(),
          user_id: userId,
          file_name: backupFileName,
          provider: prov,
          remote_id: remoteResult.remoteId,
          size: stats.size
        };

        db.addBackup(
          backupRecord.id,
          backupRecord.file_name,
          backupRecord.remote_id,
          backupRecord.size,
          backupRecord.provider,
          backupRecord.user_id
        );
        uploadedRecords.push(backupRecord);
        console.log(`[BackupService] User ${userId} backup completed successfully on ${prov} (ID: ${remoteResult.remoteId})`);
      } catch (err) {
        console.warn(`[BackupService] User backup upload to ${prov} failed:`, err.message);
        lastError = err;
      }
    }

    if (uploadedRecords.length === 0) {
      throw new Error(`Failed to upload user backup to any cloud provider: ${lastError ? lastError.message : 'Unknown error'}`);
    }

    const provNames = uploadedRecords.map(r => r.provider === 'telegram' ? 'Telegram' : 'Discord').join(' & ');
    return {
      success: true,
      backups: uploadedRecords,
      backup: uploadedRecords[0],
      message: `Personal cloud backup created and encrypted successfully on ${provNames}!`
    };
  } catch (err) {
    notifySecurityEvent('Backup failure', { scope: 'user backup', userId, provider: targetProvider, error: err.message });
    throw err;
  } finally {
    try { if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath); } catch (e) {}
    try { if (fs.existsSync(tempEncPath)) fs.unlinkSync(tempEncPath); } catch (e) {}
    isBackingUp = false;
  }
}

async function restoreUserBackup(remoteId, targetUserId, providerName = null) {
  if (!targetUserId) throw new Error('Target User ID is required');
  const authorizedBackup = db.getBackupByRemoteId ? db.getBackupByRemoteId(remoteId) : null;
  if (!authorizedBackup || authorizedBackup.user_id !== targetUserId) {
    throw new Error('Backup not found or not owned by this user');
  }
  providerName = authorizedBackup.provider;
  const tempDir = config.TMP_DIR;
  const timestamp = Date.now();
  const encPath = path.join(tempDir, `restore_user_${timestamp}.enc`);
  const decPath = path.join(tempDir, `restore_user_${timestamp}.json`);

  const isDiscordEnabled = db.getSetting('discord_enabled') !== 'false';
  const isTelegramEnabled = db.getSetting('telegram_enabled') !== 'false';

  if (!isDiscordEnabled && !isTelegramEnabled) {
    throw new Error('Cannot restore backup: All storage providers are currently disabled.');
  }

  try {
    console.log(`[BackupService] Downloading encrypted user backup #${remoteId}...`);
    let downloaded = false;
    let lastErr = null;

    const candidateProviders = [];
    if (providerName && (providerName === 'discord' || providerName === 'telegram')) {
      candidateProviders.push(providerName);
    } else {
      const backupRec = db.getBackupByRemoteId ? db.getBackupByRemoteId(remoteId) : null;
      if (backupRec && backupRec.provider) {
        candidateProviders.push(backupRec.provider);
      }
      if (isTelegramEnabled && !candidateProviders.includes('telegram')) candidateProviders.push('telegram');
      if (isDiscordEnabled && !candidateProviders.includes('discord')) candidateProviders.push('discord');
    }

    for (const prov of candidateProviders) {
      const isProvEnabled = db.getSetting(`${prov}_enabled`) !== 'false';
      if (!isProvEnabled) continue;
      try {
        const providerInst = storageManager.getProvider(prov);
        if (!providerInst.isInitialized) await providerInst.initialize();
        const buffer = await providerInst.downloadChunk(remoteId);
        if (buffer && buffer.length > 0) {
          fs.writeFileSync(encPath, buffer);
          downloaded = true;
          break;
        }
      } catch (e) {
        console.warn(`[BackupService] Downloading user backup from ${prov} failed:`, e.message);
        lastErr = e;
      }
    }

    if (!downloaded || !fs.existsSync(encPath)) {
      throw new Error(`Failed to download backup file from storage providers: ${lastErr ? lastErr.message : 'No enabled provider available'}`);
    }

    console.log('[BackupService] Decrypting user backup file...');
    await crypto.decryptFile(encPath, decPath, config.ENCRYPTION_KEY, null, null, 'db-backup');

    const jsonStr = fs.readFileSync(decPath, 'utf8');
    const dataPackage = JSON.parse(jsonStr);

    const importResult = db.importUserData(targetUserId, dataPackage);
    console.log(`[BackupService] User ${targetUserId} data restored successfully:`, importResult);

    return {
      success: true,
      message: `Personal data restored successfully! (${importResult.importedFiles} files, ${importResult.importedFolders} folders restored)`,
      details: importResult
    };
  } finally {
    try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch (e) {}
    try { if (fs.existsSync(decPath)) fs.unlinkSync(decPath); } catch (e) {}
  }
}

function getBackupStatus(userId = null, isAdmin = false) {
  const targetUserId = isAdmin ? null : userId;
  const latest = db.getLatestBackup(targetUserId);
  const history = db.getAllBackups(20, targetUserId);
  return {
    isBackingUp,
    latestBackup: latest || null,
    history: history || [],
    autoBackupEnabled: true,
    intervalHours: 24,
    isAdmin
  };
}

function startAutomatedBackups() {
  if (backupInterval) clearInterval(backupInterval);

  const checkAndRunAutoBackup = async () => {
    try {
      const latest = db.getLatestBackup();
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      let shouldBackup = false;
      if (!latest) {
        shouldBackup = true;
      } else {
        const lastCreated = new Date(latest.created_at).getTime();
        if (isNaN(lastCreated) || (now - lastCreated) >= oneDayMs) {
          shouldBackup = true;
        }
      }

      if (shouldBackup) {
        console.log('[BackupService] ⏰ Automated 24h multi-cloud backup triggered...');
        await performDatabaseBackup(null, 'all');
      }
    } catch (e) {
      console.warn('[BackupService] Automated backup schedule check error:', e.message);
      notifySecurityEvent('Automated backup failure', { error: e.message });
    }
  };

  // Initial check 20s after server startup (once storage providers finish connecting)
  setTimeout(() => {
    checkAndRunAutoBackup();
  }, 20 * 1000);

  // Check hourly if 24 hours have passed since last backup
  backupInterval = setInterval(() => {
    checkAndRunAutoBackup();
  }, 60 * 60 * 1000);

  console.log('[BackupService] 🛡️ Automated Daily Multi-Cloud Backup service active (24h schedule).');
}

module.exports = {
  performDatabaseBackup,
  createEncryptedBackup: performDatabaseBackup,
  performUserBackup,
  restoreBackup,
  restoreBackupFromDiscord,
  restoreUserBackup,
  deleteBackup,
  getBackupStatus,
  startAutomatedBackups,
  startAutoBackupSchedule: startAutomatedBackups
};
