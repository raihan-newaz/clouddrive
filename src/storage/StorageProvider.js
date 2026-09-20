/**
 * Abstract Base Class for CloudDrive Storage Providers
 * Enables pluggable storage backends (Discord, Telegram, S3, etc.)
 */
class StorageProvider {
  /**
   * @param {string} name - Unique identifier for provider (e.g. 'discord', 'telegram')
   */
  constructor(name) {
    if (new.target === StorageProvider) {
      throw new TypeError('Cannot construct StorageProvider instances directly');
    }
    this.name = name;
    this.isInitialized = false;
  }

  /**
   * Initializes the provider connection
   * @param {Object} config - Provider-specific configuration
   * @returns {Promise<boolean>}
   */
  async initialize(config = {}) {
    throw new Error('Method initialize() must be implemented');
  }

  /**
   * Tests connection with given credentials
   * @param {Object} credentials
   * @returns {Promise<{ success: boolean, error?: string, bot?: Object }>}
   */
  async testConnection(credentials = {}) {
    throw new Error('Method testConnection() must be implemented');
  }

  /**
   * Uploads an encrypted chunk
   * @param {Buffer|string} fileSource - Buffer in RAM or file path on disk
   * @param {string} fileName - Remote filename (e.g. 'fileId_chunk_0.enc')
   * @param {Function} [progressCallback] - Optional upload progress callback (bytes)
   * @returns {Promise<{ remoteId: string, size: number, channelId?: string }>}
   */
  async uploadChunk(fileSource, fileName, progressCallback = null) {
    throw new Error('Method uploadChunk() must be implemented');
  }

  /**
   * Downloads a chunk as a Buffer
   * @param {string} remoteId - Provider remote message/file ID
   * @returns {Promise<Buffer>}
   */
  async downloadChunk(remoteId) {
    throw new Error('Method downloadChunk() must be implemented');
  }

  /**
   * Streams a chunk in buffer parts
   * @param {string} remoteId - Provider remote message/file ID
   * @param {number} [chunkSize] - Stream chunk buffer size
   * @returns {AsyncGenerator<Buffer>}
   */
  async *iterDownloadChunk(remoteId, chunkSize = 1024 * 1024) {
    throw new Error('Method iterDownloadChunk() must be implemented');
  }

  /**
   * Deletes a chunk from remote storage
   * @param {string} remoteId - Remote message/file ID
   * @returns {Promise<boolean>}
   */
  async deleteChunk(remoteId) {
    throw new Error('Method deleteChunk() must be implemented');
  }

  /**
   * Retrieves storage usage & status statistics
   * @returns {Promise<{ connected: boolean, totalBytes?: number, error?: string }>}
   */
  async getStorageUsage() {
    return { connected: this.isInitialized };
  }
}

module.exports = StorageProvider;
