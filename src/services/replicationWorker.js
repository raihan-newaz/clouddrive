const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const storageManager = require('../storage/StorageManager');
const crypto = require('../crypto');
const eventBroadcaster = require('./eventBroadcaster');

class ReplicationWorker {
  constructor() {
    this.isRunning = false;
    this.intervalHandle = null;
    this.POLL_INTERVAL_MS = 3000;
    this.concurrency = 1;
    this.activeJobs = 0;
    this.cancelledFileIds = new Set();
  }

  /**
   * Cancels all pending and in-flight replication tasks for a file
   * and marks the file ID as cancelled so any in-flight uploads clean up immediately.
   * @param {string} fileId
   */
  cancelFileReplication(fileId) {
    if (!fileId) return;
    const strId = String(fileId);
    this.cancelledFileIds.add(strId);
    try {
      // ONLY delete replication jobs belonging to this specific file_id
      db.run("DELETE FROM replication_jobs WHERE file_id = ?", [fileId]);
    } catch (e) {}
    // Immediately process queue for any other queued files
    this.processQueue().catch(() => {});
    setTimeout(() => {
      this.cancelledFileIds.delete(strId);
    }, 120000); // 2-minute tombstone window
  }

  /**
   * Starts the background replication worker loop
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[ReplicationWorker] Background replication worker started.');

    // Recover any jobs that were in 'processing' state during server restart
    try {
      db.run("UPDATE replication_jobs SET status = 'pending' WHERE status = 'processing'");
    } catch (e) {}

    this.intervalHandle = setInterval(() => {
      this.processQueue().catch(err => {
        console.error('[ReplicationWorker] Error during queue processing:', err.message);
      });
    }, this.POLL_INTERVAL_MS);
  }

  /**
   * Stops the worker loop
   */
  stop() {
    this.isRunning = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[ReplicationWorker] Background replication worker stopped.');
  }

  /**
   * Enqueues replication jobs for all chunks of a file to a target provider
   * @param {string} fileId
   * @param {string} targetProvider - 'discord' | 'telegram'
   * @param {string} [sourceProvider] - Provider that has valid completed replicas
   */
  enqueueFileReplication(fileId, targetProvider, sourceProvider = null) {
    if (db.getSetting(`${targetProvider}_enabled`) === 'false') {
      // Do not enqueue replication to a disabled/standby provider
      return;
    }

    const file = db.getFileById(fileId);
    if (!file) return;

    const chunks = db.getFileChunks(fileId);
    if (!chunks || chunks.length === 0) return;

    // Check which chunks already have targetProvider replica
    const existingReplicas = db.getFileReplicas(fileId);
    const targetChunkIndices = new Set(
      existingReplicas
        .filter(r => r.provider === targetProvider && r.status === 'completed')
        .map(r => r.chunk_index)
    );

    let enqueuedCount = 0;

    for (const chunk of chunks) {
      if (targetChunkIndices.has(chunk.chunk_index)) {
        continue; // Already replicated
      }

      // Prevent duplicate jobs for the same file, chunk, and target provider
      const existingJob = db.get(
        "SELECT id FROM replication_jobs WHERE file_id = ? AND chunk_index = ? AND target_provider = ? AND status IN ('pending', 'processing', 'retrying')",
        [fileId, chunk.chunk_index, targetProvider]
      );
      if (existingJob) {
        continue; // Job already pending or processing
      }

      // Find available source replica for this chunk from a DIFFERENT provider
      const availableSources = existingReplicas.filter(
        r => r.chunk_index === chunk.chunk_index && r.provider !== targetProvider && r.status === 'completed'
      );

      if (availableSources.length === 0) {
        continue;
      }

      const selectedSource = (sourceProvider && availableSources.find(s => s.provider === sourceProvider))
        || availableSources[0];

      const job = {
        id: uuidv4(),
        file_id: fileId,
        chunk_index: chunk.chunk_index,
        source_provider: selectedSource.provider,
        target_provider: targetProvider,
        status: 'pending',
        retry_count: 0,
        max_retries: 5,
        last_error: null,
        next_run_at: new Date().toISOString()
      };

      db.createReplicationJob(job);
      enqueuedCount++;
    }

    if (enqueuedCount > 0) {
      db.updateFile(fileId, {
        replication_status: 'in_progress',
        [`${targetProvider}_status`]: 'pending'
      });
      console.log(`[ReplicationWorker] Enqueued ${enqueuedCount} chunk replication jobs for file "${file.name}" to ${targetProvider}`);
    }
  }

  /**
   * Processes pending replication jobs
   */
  async processQueue() {
    if (this.activeJobs >= this.concurrency) return;

    const limit = (this.concurrency - this.activeJobs) * 4;
    const jobs = db.getPendingReplicationJobs(limit);
    if (!jobs || jobs.length === 0) return;

    for (const job of jobs) {
      if (this.activeJobs >= this.concurrency) break;

      // Skip jobs if target provider or source provider is disabled / in Standby mode
      if (db.getSetting(`${job.target_provider}_enabled`) === 'false') {
        continue;
      }
      if (db.getSetting(`${job.source_provider}_enabled`) === 'false') {
        continue;
      }

      this.activeJobs++;
      this.processJob(job)
        .catch(err => {
          console.error(`[ReplicationWorker] Job ${job.id} failed:`, err.message);
        })
        .finally(() => {
          this.activeJobs--;
          this.processQueue().catch(() => {});
        });
    }
  }

  /**
   * Executes a single chunk replication job
   * @param {Object} job
   */
  async processJob(job) {
    db.updateReplicationJob(job.id, { status: 'processing' });

    try {
      if (this.cancelledFileIds.has(String(job.file_id))) {
        db.deleteReplicationJob(job.id);
        return;
      }

      const file = db.getFileById(job.file_id);
      if (!file || file.is_trashed === 1) {
        // File deleted or trashed, remove job
        db.deleteReplicationJob(job.id);
        return;
      }

      // Find source chunk replica
      const chunks = db.getFileChunks(job.file_id);
      const chunk = chunks.find(c => c.chunk_index === job.chunk_index);
      if (!chunk) {
        db.deleteReplicationJob(job.id);
        return;
      }

      // Check if target provider replica is ALREADY completed (prevents duplicate uploads)
      const replicas = db.getChunkReplicas(chunk.id);
      const isAlreadyCompleted = replicas.some(r => r.provider === job.target_provider && r.status === 'completed');
      if (isAlreadyCompleted) {
        console.log(`[ReplicationWorker] Chunk ${job.chunk_index} for file "${file.name}" is already completed on ${job.target_provider}. Skipping duplicate.`);
        db.deleteReplicationJob(job.id);
        return;
      }

      const sourceReplica = replicas.find(r => r.provider === job.source_provider && r.status === 'completed')
        || replicas.find(r => r.provider !== job.target_provider && r.status === 'completed');

      if (!sourceReplica) {
        throw new Error(`No completed source replica found on any provider for file ${job.file_id} chunk ${job.chunk_index}`);
      }

      // 1. Download raw encrypted chunk from source provider
      console.log(`[ReplicationWorker] Replicating file "${file.name}" chunk ${job.chunk_index} from ${sourceReplica.provider} to ${job.target_provider}...`);
      const sourceProviderInst = storageManager.getProvider(sourceReplica.provider);
      const encryptedBuffer = await sourceProviderInst.downloadChunk(sourceReplica.remote_id);

      if (!encryptedBuffer || encryptedBuffer.length === 0) {
        throw new Error('Downloaded empty encrypted chunk payload from source provider');
      }

      // Check cancellation again before starting upload
      if (this.cancelledFileIds.has(String(job.file_id))) {
        db.deleteReplicationJob(job.id);
        return;
      }
      const filePreUpload = db.getFileById(job.file_id);
      if (!filePreUpload || filePreUpload.is_trashed === 1) {
        db.deleteReplicationJob(job.id);
        return;
      }

      // 2. Verify SHA-256 integrity of the encrypted chunk if recorded
      if (chunk.sha256) {
        const actualHash = crypto.calculateSha256(encryptedBuffer);
        if (actualHash !== chunk.sha256) {
          throw new Error(`Replication integrity mismatch: expected SHA-256 ${chunk.sha256}, got ${actualHash}`);
        }
      }

      // Check if target provider is enabled
      if (db.getSetting(`${job.target_provider}_enabled`) === 'false') {
        // Target provider is currently disabled by admin. Delay job.
        db.updateReplicationJob(job.id, {
          status: 'pending',
          last_error: `Target provider ${job.target_provider} is in Standby mode`
        });
        return;
      }

      // 3. Upload the encrypted chunk directly to target provider
      const user = db.getUserById(file.user_id);
      const prefix = user?.file_prefix ? user.file_prefix.trim() : null;
      let baseName = file.name;
      if (prefix && !baseName.startsWith(`${prefix}_`)) {
        baseName = `${prefix}_${baseName}`;
      }
      const isMultiChunk = (file.total_chunks && file.total_chunks > 1) || chunks.length > 1;
      const isEnc = (file.encryption_enabled !== undefined && file.encryption_enabled !== null)
        ? (file.encryption_enabled !== 0 && file.encryption_enabled !== false && file.encryption_enabled !== '0')
        : (chunk.crypto_version !== 0 && !!chunk.iv);
      const ext = isEnc ? '.enc' : '';
      const remoteFileName = isMultiChunk
        ? `${baseName}.part${job.chunk_index}${ext}`
        : `${baseName}${ext}`;
      const uploadResult = await storageManager.uploadChunk(
        job.target_provider,
        encryptedBuffer,
        remoteFileName
      );

      // 4. CRITICAL CHECK: Verify if file was deleted or trashed WHILE uploadChunk was in-flight!
      const filePostUpload = db.getFileById(job.file_id);
      if (this.cancelledFileIds.has(String(job.file_id)) || !filePostUpload || filePostUpload.is_trashed === 1) {
        console.log(`[ReplicationWorker] File "${file.name}" was deleted/trashed during replication. Immediately purging newly uploaded chunk replica (${uploadResult.remoteId}) from ${job.target_provider}...`);
        try {
          const targetProv = storageManager.getProvider(job.target_provider);
          await targetProv.deleteChunk(uploadResult.remoteId);
        } catch (cleanErr) {
          console.warn(`[ReplicationWorker] Cleanup error for deleted file on ${job.target_provider}:`, cleanErr.message);
        }
        db.deleteReplicationJob(job.id);
        return;
      }

      // 5. Record new chunk replica
      db.addChunkReplica({
        id: uuidv4(),
        chunk_id: chunk.id,
        file_id: file.id,
        chunk_index: job.chunk_index,
        provider: job.target_provider,
        remote_id: uploadResult.remoteId,
        remote_channel_id: uploadResult.channelId || null,
        status: 'completed'
      });

      // 6. Check replication status across all file chunks
      const allFileChunks = db.getFileChunks(file.id);
      const allReplicas = db.getFileReplicas(file.id);
      const targetReplicas = allReplicas.filter(r => r.provider === job.target_provider && r.status === 'completed');
      const otherProvider = job.target_provider === 'discord' ? 'telegram' : 'discord';
      const otherReplicas = allReplicas.filter(r => r.provider === otherProvider && r.status === 'completed');

      const isTargetComplete = targetReplicas.length >= allFileChunks.length;
      const isOtherComplete = otherReplicas.length >= allFileChunks.length;
      const isDualFullySynced = isTargetComplete && isOtherComplete;

      const fileUpdates = {
        [`${job.target_provider}_status`]: isTargetComplete ? 'completed' : 'partial'
      };
      if (file.storage_mode === 'dual') {
        fileUpdates.replication_status = isDualFullySynced ? 'completed' : 'in_progress';
      } else {
        fileUpdates.replication_status = isTargetComplete ? 'completed' : 'in_progress';
      }

      db.updateFile(file.id, fileUpdates);

      if (isTargetComplete) {
        console.log(`[ReplicationWorker] File "${file.name}" is now fully replicated to ${job.target_provider} (${targetReplicas.length}/${allFileChunks.length} chunks) ✓`);
      }

      try {
        const updatedFile = db.getFileById(file.id);
        if (updatedFile) {
          eventBroadcaster.broadcast('file_updated', {
            file: updatedFile,
            userId: updatedFile.user_id
          }, updatedFile.user_id);
        }
      } catch (e) {
        console.warn('[ReplicationWorker] Broadcast error:', e.message);
      }

      // Delete completed job from queue
      db.deleteReplicationJob(job.id);

    } catch (err) {
      console.error(`[ReplicationWorker] Failed to replicate file ${job.file_id} chunk ${job.chunk_index}: ${err.message}`);
      const nextRetry = job.retry_count + 1;
      if (nextRetry >= job.max_retries) {
        db.updateReplicationJob(job.id, {
          status: 'failed',
          last_error: err.message,
          retry_count: nextRetry
        });
        db.updateFile(job.file_id, {
          replication_status: 'failed',
          [`${job.target_provider}_status`]: 'failed'
        });
        try {
          const updatedFile = db.getFileById(job.file_id);
          if (updatedFile) {
            eventBroadcaster.broadcast('file_updated', {
              file: updatedFile,
              userId: updatedFile.user_id
            }, updatedFile.user_id);
          }
        } catch (e) {}
      } else {
        // Exponential backoff: 5s, 15s, 45s, 120s...
        const backoffSeconds = Math.pow(3, nextRetry) * 5;
        const nextRun = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        db.updateReplicationJob(job.id, {
          status: 'retrying',
          last_error: err.message,
          retry_count: nextRetry,
          next_run_at: nextRun
        });
      }
    }
  }
}

const replicationWorker = new ReplicationWorker();
module.exports = replicationWorker;
