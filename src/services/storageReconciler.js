const db = require('../db');
const replicationWorker = require('./replicationWorker');
const storageManager = require('../storage/StorageManager');
const eventBroadcaster = require('./eventBroadcaster');

class StorageReconciler {
  constructor() {
    this.intervalHandle = null;
    this.isReconciling = false;
    this.lastReconcileTime = null;
    this.lastResult = null;
  }

  /**
   * Scans the entire database for any files missing replicas across clouds,
   * resets failed jobs, and queues smart background sync jobs.
   * @param {string|null} userId - Optional filter by user
   * @returns {Promise<Object>} Summary of scanned and queued sync operations
   */
  async scanAndHealMissingReplicas(userId = null) {
    if (this.isReconciling) {
      console.log('[StorageReconciler] Reconciliation already in progress. Skipping duplicate run.');
      return this.lastResult || { status: 'already_running' };
    }

    this.isReconciling = true;
    const startTime = Date.now();
    console.log('[StorageReconciler] 🔄 Starting smart cross-cloud health scan & auto-heal...');

    let scannedFilesCount = 0;
    let missingReplicasQueued = 0;
    let resetJobsCount = 0;
    const filesToHeal = [];

    try {
      // 1. Reset any failed or stuck jobs to 'pending' if providers are accessible
      const failedJobs = db.all(
        "SELECT * FROM replication_jobs WHERE status IN ('failed', 'retrying') ORDER BY created_at ASC"
      ) || [];

      for (const job of failedJobs) {
        db.updateReplicationJob(job.id, {
          status: 'pending',
          next_run_at: new Date().toISOString()
        });
        resetJobsCount++;
      }

      if (resetJobsCount > 0) {
        console.log(`[StorageReconciler] Reset ${resetJobsCount} failed/stuck sync jobs for automatic retry.`);
      }

      // 2. Query all active files that should be replicated (dual storage mode or pending replication)
      const query = userId
        ? "SELECT * FROM files WHERE user_id = ? AND is_trashed = 0"
        : "SELECT * FROM files WHERE is_trashed = 0";
      const files = (userId ? db.all(query, [userId]) : db.all(query)) || [];
      scannedFilesCount = files.length;

      for (const file of files) {
        // Only enforce dual sync if storage_mode is dual, or if file was marked pending
        const isDual = file.storage_mode === 'dual';
        if (!isDual && file.replication_status === 'completed') {
          continue;
        }

        const chunks = db.getFileChunks(file.id) || [];
        if (chunks.length === 0) continue;

        const replicas = db.getFileReplicas(file.id) || [];
        const telegramReplicas = new Set(
          replicas.filter(r => r.provider === 'telegram' && r.status === 'completed').map(r => r.chunk_index)
        );
        const discordReplicas = new Set(
          replicas.filter(r => r.provider === 'discord' && r.status === 'completed').map(r => r.chunk_index)
        );

        let needsDiscordSync = false;
        let needsTelegramSync = false;

        for (const chunk of chunks) {
          const hasTg = telegramReplicas.has(chunk.chunk_index);
          const hasDc = discordReplicas.has(chunk.chunk_index);

          if (isDual) {
            if (hasTg && !hasDc) {
              needsDiscordSync = true;
            }
            if (hasDc && !hasTg) {
              needsTelegramSync = true;
            }
          }
        }

        if (needsDiscordSync && db.getSetting('discord_enabled') !== 'false') {
          replicationWorker.enqueueFileReplication(file.id, 'discord');
          missingReplicasQueued++;
          filesToHeal.push({ id: file.id, name: file.name, target: 'discord' });
        }

        if (needsTelegramSync && db.getSetting('telegram_enabled') !== 'false') {
          replicationWorker.enqueueFileReplication(file.id, 'telegram');
          missingReplicasQueued++;
          filesToHeal.push({ id: file.id, name: file.name, target: 'telegram' });
        }

        if (isDual && !needsDiscordSync && !needsTelegramSync) {
          if (file.replication_status !== 'completed' || file.discord_status !== 'completed' || file.telegram_status !== 'completed') {
            db.updateFile(file.id, {
              replication_status: 'completed',
              discord_status: 'completed',
              telegram_status: 'completed'
            });
          }
        }
      }

      const durationMs = Date.now() - startTime;
      this.lastReconcileTime = new Date().toISOString();
      this.lastResult = {
        success: true,
        scannedFiles: scannedFilesCount,
        missingReplicasQueued,
        resetJobs: resetJobsCount,
        durationMs,
        healedFiles: filesToHeal
      };

      console.log(
        `[StorageReconciler] ✅ Scan complete in ${durationMs}ms: Scanned ${scannedFilesCount} files, ` +
        `Queued ${missingReplicasQueued} missing sync tasks, Reset ${resetJobsCount} retry jobs.`
      );

      // Trigger replication worker to immediately begin processing
      if (missingReplicasQueued > 0 || resetJobsCount > 0) {
        replicationWorker.processQueue().catch(() => {});
      }

      return this.lastResult;
    } catch (err) {
      console.error('[StorageReconciler] Reconciliation error:', err.message);
      return {
        success: false,
        error: err.message,
        scannedFiles: scannedFilesCount,
        missingReplicasQueued,
        resetJobs: resetJobsCount
      };
    } finally {
      this.isReconciling = false;
    }
  }

  /**
   * Starts periodic background scan (e.g. every 10 minutes)
   */
  startPeriodicReconciliation(intervalMinutes = 10) {
    if (this.intervalHandle) return;
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

    console.log(`[StorageReconciler] Auto-reconciliation service scheduled every ${intervalMinutes} minutes.`);

    // Run initial scan after 10 seconds of startup
    setTimeout(() => {
      this.scanAndHealMissingReplicas().catch(err => {
        console.warn('[StorageReconciler] Initial startup scan warning:', err.message);
      });
    }, 10000);

    this.intervalHandle = setInterval(() => {
      this.scanAndHealMissingReplicas().catch(err => {
        console.warn('[StorageReconciler] Periodic scan warning:', err.message);
      });
    }, intervalMs);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Returns live synchronization status and metrics
   */
  async getSyncStatus(userId = null) {
    const whereUser = userId ? 'WHERE user_id = ?' : '';
    const params = userId ? [userId] : [];

    const totalFiles = (db.get(`SELECT COUNT(*) as count FROM files ${whereUser}`, params))?.count || 0;
    const dualFiles = (db.get(`SELECT COUNT(*) as count FROM files WHERE storage_mode = 'dual' ${userId ? 'AND user_id = ?' : ''}`, params))?.count || 0;
    const fullySynced = (db.get(`SELECT COUNT(*) as count FROM files WHERE storage_mode = 'dual' AND discord_status = 'completed' AND telegram_status = 'completed' ${userId ? 'AND user_id = ?' : ''}`, params))?.count || 0;
    const pendingReplication = (db.get(`SELECT COUNT(*) as count FROM files WHERE replication_status IN ('pending', 'in_progress') ${userId ? 'AND user_id = ?' : ''}`, params))?.count || 0;

    const pendingJobs = (db.get("SELECT COUNT(*) as count FROM replication_jobs WHERE status IN ('pending', 'retrying', 'processing')"))?.count || 0;
    const failedJobs = (db.get("SELECT COUNT(*) as count FROM replication_jobs WHERE status = 'failed'"))?.count || 0;
    const recentErrors = db.all("SELECT id, file_id, source_provider, target_provider, retry_count, last_error, updated_at FROM replication_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 10") || [];

    return {
      totalFiles,
      dualFiles,
      fullySynced,
      pendingReplication,
      activeSyncQueue: pendingJobs,
      failedJobs,
      recentErrors,
      isReconciling: this.isReconciling,
      lastReconcileTime: this.lastReconcileTime,
      lastResult: this.lastResult
    };
  }
}

const storageReconciler = new StorageReconciler();
module.exports = storageReconciler;
