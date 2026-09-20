const fs = require('fs');
const path = require('path');
const config = require('../config');

class CacheManager {
  constructor() {
    this.cacheDir = config.CACHE_DIR;
    this.enabled = process.env.ALLOW_PLAINTEXT_CACHE === 'true';
    this.maxCacheBytes = 3 * 1024 * 1024 * 1024; // 3 GB
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    if (!this.enabled) {
      this.clear();
      try {
        if (fs.existsSync(config.THUMBNAILS_DIR)) {
          for (const file of fs.readdirSync(config.THUMBNAILS_DIR)) {
            try { fs.unlinkSync(path.join(config.THUMBNAILS_DIR, file)); } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }

  getCachePath(fileId, chunkIndex = null) {
    if (chunkIndex !== null && chunkIndex !== undefined) {
      return path.join(this.cacheDir, `${fileId}_chunk_${chunkIndex}.dec`);
    }
    return path.join(this.cacheDir, `${fileId}.dec`);
  }

  has(fileId, chunkIndex = null) {
    if (!this.enabled) return false;
    const p = this.getCachePath(fileId, chunkIndex);
    return fs.existsSync(p);
  }

  get(fileId, chunkIndex = null) {
    if (!this.enabled) return null;
    const p = this.getCachePath(fileId, chunkIndex);
    if (!fs.existsSync(p)) return null;
    try {
      // Touch file for LRU
      fs.utimesSync(p, new Date(), new Date());
      return fs.readFileSync(p);
    } catch (e) {
      return null;
    }
  }

  set(fileId, buffer, chunkIndex = null) {
    if (!this.enabled) return;
    try {
      this.pruneIfNeeded(buffer.length);
      const p = this.getCachePath(fileId, chunkIndex);
      fs.writeFileSync(p, buffer);
    } catch (e) {
      console.warn('[CacheManager] Error saving to cache:', e.message);
    }
  }

  getTotalCacheSize() {
    if (!this.enabled) return 0;
    try {
      const files = fs.readdirSync(this.cacheDir);
      let total = 0;
      for (const f of files) {
        const stats = fs.statSync(path.join(this.cacheDir, f));
        total += stats.size;
      }
      return total;
    } catch (e) {
      return 0;
    }
  }

  pruneIfNeeded(requiredSpace = 0) {
    try {
      let currentSize = this.getTotalCacheSize();
      if (currentSize + requiredSpace <= this.maxCacheBytes) return;

      const files = fs.readdirSync(this.cacheDir).map(f => {
        const fullPath = path.join(this.cacheDir, f);
        const stats = fs.statSync(fullPath);
        return { path: fullPath, atime: stats.atimeMs, size: stats.size };
      });

      // Sort by oldest accessed
      files.sort((a, b) => a.atime - b.atime);

      for (const file of files) {
        if (currentSize + requiredSpace <= this.maxCacheBytes) break;
        try {
          fs.unlinkSync(file.path);
          currentSize -= file.size;
        } catch (e) {}
      }
    } catch (e) {
      console.warn('[CacheManager] Error pruning cache:', e.message);
    }
  }

  clear() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch (e) {}
      }
      return true;
    } catch (e) {
      return false;
    }
  }
}

const cacheManager = new CacheManager();
module.exports = cacheManager;
