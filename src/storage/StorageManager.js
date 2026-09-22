const DiscordStorageProvider = require('./DiscordStorageProvider');
const TelegramStorageProvider = require('./TelegramStorageProvider');
const config = require('../config');
const db = require('../db');

class StorageManager {
  constructor() {
    this.providers = new Map();
    
    // Register built-in providers
    this.registerProvider(new DiscordStorageProvider());
    this.registerProvider(new TelegramStorageProvider());
  }

  /**
   * Registers a storage provider instance
   * @param {StorageProvider} providerInstance
   */
  registerProvider(providerInstance) {
    if (!providerInstance || !providerInstance.name) {
      throw new Error('Invalid provider instance');
    }
    this.providers.set(providerInstance.name, providerInstance);
  }

  /**
   * Retrieves a registered provider by name
   * @param {string} name - 'discord' | 'telegram'
   * @returns {StorageProvider}
   */
  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Storage provider not found: ${name}`);
    }
    return provider;
  }

  /**
   * Initializes all configured storage providers
   * @param {Object} [configOverride]
   * @returns {Promise<Object>} Status map of providers
   */
  async initializeAll(configOverride = {}) {
    const statuses = {};
    for (const [name, provider] of this.providers.entries()) {
      try {
        if (db.getSetting(`${name}_enabled`) === 'false') {
          provider.isInitialized = false;
          provider.isExplicitlyDisconnected = true;
          statuses[name] = false;
          continue;
        }
        const ok = await provider.initialize(configOverride[name] || {});
        statuses[name] = ok;
      } catch (err) {
        console.error(`[StorageManager] Failed to initialize provider "${name}":`, err.message);
        statuses[name] = false;
      }
    }
    return statuses;
  }

  /**
   * Tests connection for a specific provider
   * @param {string} name - 'discord' | 'telegram'
   * @param {Object} credentials
   */
  async testConnection(name, credentials) {
    const provider = this.getProvider(name);
    return provider.testConnection(credentials);
  }

  /**
   * Uploads an encrypted chunk to a specific provider
   * @param {string} providerName - 'discord' | 'telegram'
   * @param {Buffer|string} fileSource - Chunk data
   * @param {string} fileName - Remote filename
   * @param {Function} [progressCallback]
   * @returns {Promise<{ remoteId: string, size: number, provider: string }>}
   */
  async uploadChunk(providerName, fileSource, fileName, progressCallback = null) {
    if (db.getSetting(`${providerName}_enabled`) === 'false') {
      throw new Error(`Cannot upload to disabled/standby provider: ${providerName}`);
    }
    const provider = this.getProvider(providerName);
    if (!provider.isInitialized) {
      await provider.initialize();
    }
    const result = await provider.uploadChunk(fileSource, fileName, progressCallback);
    return {
      ...result,
      provider: providerName
    };
  }

  /**
   * Uploads an encrypted chunk with Automatic Failover
   * If the preferred provider fails, automatically switches to the alternative provider
   * @param {string} preferredProvider - 'telegram' | 'discord'
   * @param {Buffer|string} fileSource - Chunk data
   * @param {string} fileName - Remote filename
   * @param {Function} [progressCallback]
   * @returns {Promise<{ remoteId: string, size: number, provider: string, failoverUsed: boolean }>}
   */
  async uploadChunkWithFailover(preferredProvider, fileSource, fileName, progressCallback = null) {
    const rawPrimary = preferredProvider || config.PRIMARY_PROVIDER || 'telegram';
    const rawFallback = rawPrimary === 'telegram' ? 'discord' : 'telegram';

    const isPrimaryEnabled = db.getSetting(`${rawPrimary}_enabled`) !== 'false';
    const isFallbackEnabled = db.getSetting(`${rawFallback}_enabled`) !== 'false';

    if (!isPrimaryEnabled && !isFallbackEnabled) {
      throw new Error('All storage providers are currently in Standby / Disabled mode. Please enable at least one provider in Settings.');
    }

    const primaryName = isPrimaryEnabled ? rawPrimary : rawFallback;
    const fallbackName = isPrimaryEnabled && isFallbackEnabled ? rawFallback : null;

    try {
      const primaryProvider = this.getProvider(primaryName);
      if (!primaryProvider.isInitialized) {
        await primaryProvider.initialize();
      }
      const result = await primaryProvider.uploadChunk(fileSource, fileName, progressCallback);
      return {
        ...result,
        provider: primaryName,
        failoverUsed: false
      };
    } catch (primaryErr) {
      if (!fallbackName) {
        throw new Error(`Upload failed on active provider "${primaryName}": ${primaryErr.message}`);
      }

      console.warn(`[StorageManager] Upload to primary provider "${primaryName}" failed (${primaryErr.message}). Initiating automatic failover to "${fallbackName}"...`);
      
      try {
        const fallbackProvider = this.getProvider(fallbackName);
        if (!fallbackProvider.isInitialized) {
          await fallbackProvider.initialize();
        }
        const fallbackResult = await fallbackProvider.uploadChunk(fileSource, fileName, progressCallback);
        console.log(`[StorageManager] Automatic failover upload to "${fallbackName}" succeeded.`);
        return {
          ...fallbackResult,
          provider: fallbackName,
          failoverUsed: true,
          originalError: primaryErr.message
        };
      } catch (fallbackErr) {
        console.error(`[StorageManager] Both primary "${primaryName}" and fallback "${fallbackName}" upload failed!`);
        throw new Error(`Upload failed on all available cloud providers: [${primaryName}: ${primaryErr.message}] | [${fallbackName}: ${fallbackErr.message}]`);
      }
    }
  }

  /**
   * Downloads a chunk with automatic failover between available replicas
   * @param {Array<{ provider: string, remote_id: string }>} replicas
   * @param {string} [preferredProvider]
   * @returns {Promise<{ buffer: Buffer, usedProvider: string }>}
   */
  async downloadChunkWithFailover(replicas, preferredProvider = null) {
    if (!replicas || replicas.length === 0) {
      throw new Error('No chunk replicas available for download');
    }

    const preferred = preferredProvider || config.PRIMARY_PROVIDER || 'telegram';

    // Sort replicas so preferred provider is attempted first
    const sortedReplicas = [...replicas].sort((a, b) => {
      if (a.provider === preferred) return -1;
      if (b.provider === preferred) return 1;
      return 0;
    });

    let lastError = null;
    let enabledReplicasCount = 0;

    for (const replica of sortedReplicas) {
      const isEnabled = db.getSetting(`${replica.provider}_enabled`) !== 'false';
      if (!isEnabled) {
        console.warn(`[StorageManager] Skipping download replica from disabled/standby provider: ${replica.provider}`);
        continue;
      }
      enabledReplicasCount++;

      try {
        const provider = this.getProvider(replica.provider);
        if (!provider.isInitialized) {
          await provider.initialize();
        }
        const buffer = await provider.downloadChunk(replica.remote_id);
        if (buffer && buffer.length > 0) {
          return {
            buffer,
            usedProvider: replica.provider
          };
        }
      } catch (err) {
        console.warn(`[StorageManager] Download failed from provider "${replica.provider}" (ID: ${replica.remote_id}): ${err.message}. Trying next replica...`);
        lastError = err;
      }
    }

    if (enabledReplicasCount === 0) {
      throw new Error('All storage providers containing this file are currently in Standby / Disabled mode. Please enable at least one connected provider in Settings.');
    }

    throw new Error(`Failed to download chunk from any provider replica: ${lastError ? lastError.message : 'Unknown error'}`);
  }

  /**
   * Streams a chunk with automatic failover
   * @param {Array<{ provider: string, remote_id: string }>} replicas
   * @param {string} [preferredProvider]
   * @param {number} [chunkSize]
   * @returns {Promise<AsyncGenerator<Buffer>>}
   */
  async iterDownloadChunkWithFailover(replicas, preferredProvider = null, chunkSize = 1024 * 1024) {
    if (!replicas || replicas.length === 0) {
      throw new Error('No chunk replicas available for streaming');
    }

    const preferred = preferredProvider || config.PRIMARY_PROVIDER || 'telegram';

    const sortedReplicas = [...replicas].sort((a, b) => {
      if (a.provider === preferred) return -1;
      if (b.provider === preferred) return 1;
      return 0;
    });

    let enabledReplicasCount = 0;

    for (const replica of sortedReplicas) {
      const isEnabled = db.getSetting(`${replica.provider}_enabled`) !== 'false';
      if (!isEnabled) {
        console.warn(`[StorageManager] Skipping stream replica from disabled/standby provider: ${replica.provider}`);
        continue;
      }
      enabledReplicasCount++;

      try {
        const provider = this.getProvider(replica.provider);
        if (!provider.isInitialized) await provider.initialize();
        return provider.iterDownloadChunk(replica.remote_id, chunkSize);
      } catch (err) {
        console.warn(`[StorageManager] Stream failed from "${replica.provider}": ${err.message}. Trying fallback...`);
      }
    }

    if (enabledReplicasCount === 0) {
      throw new Error('All storage providers containing this file are currently in Standby / Disabled mode. Please enable at least one connected provider in Settings.');
    }

    throw new Error('All provider stream attempts failed');
  }

  /**
   * Deletes a chunk from all associated provider replicas
   * @param {Array<{ provider: string, remote_id: string }>} replicas
   * @returns {Promise<Array<{ provider: string, remote_id: string, success: boolean }>>}
   */
  async deleteChunkFromAllReplicas(replicas) {
    if (!replicas || replicas.length === 0) return [];

    const results = [];
    for (const replica of replicas) {
      try {
        const provider = this.getProvider(replica.provider);
        if (!provider.isInitialized) {
          await provider.initialize();
        }
        const success = await provider.deleteChunk(replica.remote_id);
        results.push({ provider: replica.provider, remote_id: replica.remote_id, success });
      } catch (err) {
        console.warn(`[StorageManager] Failed to delete chunk replica from ${replica.provider} (${replica.remote_id}):`, err.message);
        results.push({ provider: replica.provider, remote_id: replica.remote_id, success: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Alias for deleteChunkFromAllReplicas
   */
  async deleteChunkReplicas(replicas) {
    return this.deleteChunkFromAllReplicas(replicas);
  }

  /**
   * Bulk deletes chunks across all provider replicas efficiently
   * @param {Array<{ provider: string, remote_id: string }>} replicas
   */
  async deleteChunksBulk(replicas, options = {}) {
    if (!replicas || replicas.length === 0) return [];

    // Group replicas by provider
    const byProvider = {};
    for (const replica of replicas) {
      if (!replica || !replica.provider || !replica.remote_id) continue;
      if (!byProvider[replica.provider]) {
        byProvider[replica.provider] = [];
      }
      byProvider[replica.provider].push(replica.remote_id);
    }

    const results = [];
    for (const [providerName, rawRemoteIds] of Object.entries(byProvider)) {
      const remoteIds = [...new Set(rawRemoteIds)];
      try {
        const provider = this.getProvider(providerName);
        if (!provider.isInitialized) {
          const initialized = await provider.initialize({ forceConnect: options.forceConnect === true });
          if (!initialized) throw new Error(`${providerName} is not connected`);
        }
        let success = true;
        if (typeof provider.deleteChunks === 'function') {
          success = await provider.deleteChunks(remoteIds);
        } else {
          for (const id of remoteIds) {
            const deleted = await provider.deleteChunk(id);
            if (!deleted) success = false;
          }
        }
        if (!success) throw new Error(`${providerName} rejected one or more delete requests`);
        results.push({ provider: providerName, attempted: remoteIds.length, deleted: remoteIds.length, success: true });
      } catch (err) {
        console.warn(`[StorageManager] Bulk delete error for provider "${providerName}":`, err.message);
        results.push({ provider: providerName, attempted: remoteIds.length, deleted: 0, success: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Returns live status and connection state for all registered providers
   * @returns {Promise<Object>}
   */
  async getProvidersStatus() {
    const status = {};
    for (const [name, provider] of this.providers.entries()) {
      try {
        const isExplicitlyDisabled = db.getSetting(`${name}_enabled`) === 'false' || provider.isExplicitlyDisconnected;
        if (!provider.isInitialized && !isExplicitlyDisabled) {
          await provider.initialize().catch(() => {});
        }
        const usage = await provider.getStorageUsage();
        status[name] = {
          connected: !isExplicitlyDisabled && provider.isInitialized && (usage.connected !== false),
          ...usage
        };
      } catch (e) {
        status[name] = { connected: false, error: e.message };
      }
    }
    return status;
  }
}

const storageManager = new StorageManager();
module.exports = storageManager;
