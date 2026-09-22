/**
 * CloudDrive Unified Multi-Cloud Upload Controller
 * Supports: Chunked & Resumable Uploads, Dual Cloud (Discord + Telegram),
 * Folder Hierarchy Uploads, Remote Downloads, and Instant UI Updates.
 */
const UploadManager = {
  CHUNK_SIZE: 9.5 * 1024 * 1024, // Fallback default
  activeUploads: new Map(),
  queue: [],
  isProcessing: false,
  MAX_CONCURRENT_UPLOADS: 2,
  wakeLock: null,
  isUploading: false,
  isMinimized: false,
  _dragDropInitialized: false,
  _renderThrottleTimer: null,
  _lastRenderTime: 0,

  /**
   * Calculates smooth real-time upload speed and estimated time remaining (ETA)
   */
  updateItemSpeedAndEta(item) {
    if (!item) return;
    const now = Date.now();
    const elapsedTotalSec = (now - item.startTime) / 1000;
    if (elapsedTotalSec <= 0.1 || item.bytesSent <= 0) return;

    if (!item.speedHistory) item.speedHistory = [];
    item.speedHistory.push({ time: now, bytes: item.bytesSent });

    // Keep up to 3 seconds of recent samples for instantaneous smooth rate
    while (item.speedHistory.length > 1 && now - item.speedHistory[0].time > 3000) {
      item.speedHistory.shift();
    }

    let speedBps = 0;
    if (item.speedHistory.length > 1) {
      const oldest = item.speedHistory[0];
      const deltaBytes = item.bytesSent - oldest.bytes;
      const deltaTime = (now - oldest.time) / 1000;
      if (deltaTime > 0.1 && deltaBytes >= 0) {
        speedBps = deltaBytes / deltaTime;
      }
    }
    if (speedBps <= 0) {
      speedBps = item.bytesSent / elapsedTotalSec;
    }

    if (speedBps > 0) {
      const formatFn = (typeof UI !== 'undefined' && UI.formatFileSize) ? UI.formatFileSize : (b => `${(b / (1024 * 1024)).toFixed(1)} MB`);
      item.speed = formatFn(speedBps) + '/s';
      const remainingBytes = Math.max(0, item.size - item.bytesSent);
      const etaSec = remainingBytes / speedBps;
      item.eta = this.formatEta(etaSec);
    }
  },

  /**
   * Throttles UI re-renders during high-frequency upload progress events (max ~10fps)
   */
  scheduleRenderWidget() {
    const now = Date.now();
    if (now - this._lastRenderTime > 100) {
      this._lastRenderTime = now;
      this.renderUploadWidget();
    } else if (!this._renderThrottleTimer) {
      this._renderThrottleTimer = setTimeout(() => {
        this._renderThrottleTimer = null;
        this._lastRenderTime = Date.now();
        this.renderUploadWidget();
      }, 100);
    }
  },

  /**
   * Toggles minimized / expanded state of the upload panel
   */
  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    const widget = document.getElementById('upload-status-widget');
    // Update the existing panel immediately. Rebuilding the widget while an
    // upload callback is finishing used to swallow the click on mobile.
    if (widget) widget.classList.toggle('minimized', this.isMinimized);
    this.renderUploadWidget();
  },

  /**
   * Retrieves user-configured chunk size for Discord (default: 9.5 MB)
   */
  getDiscordChunkSize() {
    try {
      const saved = localStorage.getItem('clouddrive_discord_chunk_size') || localStorage.getItem('discorddrive_chunk_size');
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= 1024 * 1024) return val;
      }
    } catch (e) {}
    return 9.5 * 1024 * 1024;
  },

  /**
   * Checks if Zero-Knowledge AES-256 Encryption is enabled (default: true)
   */
  isEncryptionEnabled() {
    try {
      const saved = localStorage.getItem('clouddrive_encryption_enabled');
      if (saved !== null) return saved !== 'false';
      const toggle = document.getElementById('settings-encryption-toggle');
      if (toggle) return toggle.checked;
    } catch (e) {}
    return true;
  },

  /**
   * Retrieves user-configured chunk size for Telegram (default: 20 MB)
   */
  getTelegramChunkSize() {
    try {
      const saved = localStorage.getItem('clouddrive_telegram_chunk_size');
      if (saved) {
        const val = parseFloat(saved);
        if (!isNaN(val) && val >= 1024 * 1024) return val;
      }
    } catch (e) {}
    return 20 * 1024 * 1024;
  },

  /**
   * Dynamically retrieves user-configured chunk size in bytes based on storage mode
   * @param {string|null} mode - 'telegram', 'discord', or 'dual'
   */
  getChunkSize(mode = null) {
    const effectiveMode = mode || this.getEffectiveStorageMode();
    const discordSize = this.getDiscordChunkSize();
    const telegramSize = this.getTelegramChunkSize();

    if (effectiveMode === 'telegram') {
      return telegramSize;
    } else if (effectiveMode === 'discord') {
      return discordSize;
    } else {
      // In Dual Cloud mode, chunk size must be compatible with both providers to ensure cross-replication
      return Math.min(discordSize, telegramSize);
    }
  },

  /**
   * Dynamically retrieves parallel upload streams limit
   */
  getConcurrentUploads() {
    try {
      const saved = localStorage.getItem('discorddrive_concurrent_chunks');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 1) return Math.min(5, val);
      }
    } catch (e) {}
    return 2;
  },

  /**
   * Dynamically retrieves chunk concurrency per multi-part file
   */
  getChunkConcurrency() {
    try {
      const saved = localStorage.getItem('discorddrive_concurrent_chunks');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 1) return Math.min(5, val);
      }
    } catch (e) {}
    return 2;
  },

  /**
   * Resolves effective storage policy (override -> folder -> user -> localStorage -> dual)
   */
  getEffectiveStorageMode(storageModeOverride = null) {
    let mode = storageModeOverride;
    if (!mode && typeof App !== 'undefined' && App.user && App.user.default_storage_mode) {
      mode = App.user.default_storage_mode;
    }
    if (!mode) {
      try {
        mode = localStorage.getItem('clouddrive_default_storage_mode') || 'dual';
      } catch (e) {
        mode = 'dual';
      }
    }

    const dcConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.discord?.connected !== false) : true;
    const tgConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.telegram?.connected !== false) : true;

    if (mode === 'dual') {
      if (!dcConnected && tgConnected) return 'telegram';
      if (!tgConnected && dcConnected) return 'discord';
    }
    return mode;
  },

  /**
   * Resolves effective primary cloud provider (user -> localStorage -> telegram)
   */
  getEffectivePrimaryProvider() {
    let primary = null;
    if (typeof App !== 'undefined' && App.user && App.user.primary_provider) {
      primary = App.user.primary_provider;
    }
    if (!primary) {
      try {
        primary = localStorage.getItem('clouddrive_primary_provider') || 'telegram';
      } catch (e) {
        primary = 'telegram';
      }
    }

    const dcConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.discord?.connected !== false) : true;
    const tgConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.telegram?.connected !== false) : true;

    if (primary === 'discord' && !dcConnected && tgConnected) return 'telegram';
    if (primary === 'telegram' && !tgConnected && dcConnected) return 'discord';
    return primary;
  },

  /**
   * Formats remaining time (ETA)
   */
  formatEta(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 2) return '< 1s left';
    if (seconds < 60) return `${Math.round(seconds)}s left`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m < 60) {
      return s > 0 ? `${m}m ${s}s left` : `${m}m left`;
    }
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m left` : `${h}h left`;
  },

  /**
   * Initializes all file inputs, folder inputs, and drag & drop handlers
   */
  init() {
    this.initInputs();
    this.initDragDrop();
  },

  initInputs() {
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    if (fileInput) {
      fileInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const files = Array.from(e.target.files);
          fileInput.value = '';
          await this.addFiles(files, typeof App !== 'undefined' ? App.currentFolderId : null);
        }
      };
    }

    if (folderInput) {
      folderInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const files = Array.from(e.target.files);
          folderInput.value = '';
          await this.addFiles(files, typeof App !== 'undefined' ? App.currentFolderId : null);
        }
      };
    }
  },

  /**
   * Initializes Drag & Drop overlay and dropzone listeners
   */
  initDragDrop() {
    if (this._dragDropInitialized) return;
    this._dragDropInitialized = true;

    let dragCounter = 0;

    const isFileDrag = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return false;
      const types = Array.from(e.dataTransfer.types);
      return types.includes('Files') || types.includes('application/x-moz-file') || types.includes('public.file-url');
    };
    const isInternalMove = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return false;
      return Array.from(e.dataTransfer.types).includes('application/x-clouddrive-item');
    };

    window.addEventListener('dragenter', (e) => {
      // A file/folder card being moved inside CloudDrive is not an upload.
      // Leave it to App's folder drop handler so the two systems never compete.
      if (isInternalMove(e)) return;
      e.preventDefault();
      if (isFileDrag(e)) {
        dragCounter++;
        document.body.classList.add('dragging');
      }
    });

    window.addEventListener('dragover', (e) => {
      if (isInternalMove(e)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!document.body.classList.contains('dragging') && isFileDrag(e)) {
        document.body.classList.add('dragging');
      }
    });

    window.addEventListener('dragleave', (e) => {
      if (isInternalMove(e)) return;
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0 || (e.clientX === 0 && e.clientY === 0)) {
        document.body.classList.remove('dragging');
        dragCounter = 0;
      }
    });

    const handleDrop = async (e) => {
      if (isInternalMove(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      document.body.classList.remove('dragging');

      if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        const items = e.dataTransfer.items;
        const files = [];

        // Check for directory support via DataTransferItem.webkitGetAsEntry
        const entries = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
          if (entry) {
            entries.push(entry);
          }
        }

        if (entries.length > 0) {
          for (const entry of entries) {
            await this.traverseFileTree(entry, '', files);
          }
          if (files.length > 0) {
            await this.addFiles(files, typeof App !== 'undefined' ? App.currentFolderId : null);
            return;
          }
        }
      }

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        await this.addFiles(files, typeof App !== 'undefined' ? App.currentFolderId : null);
      }
    };

    window.addEventListener('drop', handleDrop);

    const dropZoneEl = document.getElementById('drop-zone');
    if (dropZoneEl) {
      dropZoneEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
    }
  },

  /**
   * Recursively traverses dropped directories
   */
  async traverseFileTree(item, currentPath, fileList) {
    if (item.isFile) {
      const file = await new Promise((resolve) => item.file(resolve));
      if (file) {
        file.relativePath = currentPath + file.name;
        fileList.push(file);
      }
    } else if (item.isDirectory) {
      const dirReader = item.createReader();
      const entries = await new Promise((resolve) => {
        dirReader.readEntries(resolve, () => resolve([]));
      });
      for (const subEntry of entries) {
        await this.traverseFileTree(subEntry, currentPath + item.name + '/', fileList);
      }
    }
  },

  /**
   * Main entry point for adding files to the upload queue
   */
  async addFiles(fileList, targetFolderId = null, storageModeOverride = null) {
    if (!fileList || fileList.length === 0) return;

    const dcConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.discord?.connected !== false) : true;
    const tgConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.telegram?.connected !== false) : true;

    if (!dcConnected && !tgConnected) {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings to upload files.', 'error', 5000);
      } else {
        alert('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings to upload files.');
      }
      return;
    }

    const folderId = targetFolderId !== null ? targetFolderId : (typeof App !== 'undefined' ? App.currentFolderId : null);
    const mode = this.getEffectiveStorageMode(storageModeOverride);
    const chunkSize = this.getChunkSize(mode);

    // Handle directory structures if files have relative paths
    const folderCache = new Map(); // path -> folderId

    for (const file of fileList) {
      let assignedFolderId = folderId;

      // If relative path exists (from folder upload or drag & drop), auto-create folder structure
      const relPath = file.webkitRelativePath || file.relativePath || '';
      if (relPath && relPath.includes('/')) {
        const parts = relPath.split('/').slice(0, -1);
        let parentFid = folderId;
        let cumulativePath = '';

        for (const segment of parts) {
          cumulativePath += (cumulativePath ? '/' : '') + segment;
          if (folderCache.has(cumulativePath)) {
            parentFid = folderCache.get(cumulativePath);
          } else {
            try {
              const res = await API.createFolder(segment, parentFid, mode);
              if (res && res.folder && res.folder.id) {
                parentFid = res.folder.id;
                folderCache.set(cumulativePath, parentFid);
              }
            } catch (err) {
              console.warn(`[Upload] Auto-creating subfolder "${segment}" error:`, err);
            }
          }
        }
        assignedFolderId = parentFid;
      }

      const totalChunks = Math.ceil(file.size / chunkSize) || 1;
      const uploadId = 'up_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      const uploadItem = {
        id: uploadId,
        file,
        name: file.name,
        size: file.size,
        folderId: assignedFolderId,
        storageMode: mode,
        chunkSize: chunkSize,
        progress: 0,
        speed: '',
        eta: '',
        startTime: Date.now(),
        bytesSent: 0,
        status: 'queued', // queued, uploading, paused, completed, error
        error: null,
        cancelToken: false,
        sessionId: null,
        totalChunks: totalChunks,
        uploadedChunks: new Set(),
        activeControllers: new Map(),
        activeChunkLoaded: new Map(),
        speedHistory: []
      };

      this.queue.push(uploadItem);
    }

    // Render once after the complete selection is queued. Rendering inside the
    // loop caused the panel to jump/reflow repeatedly for large selections.
    this.renderUploadWidget();
    this.processQueue();
  },

  handleFiles(fileList, targetFolderId = null, storageModeOverride = null) {
    return this.addFiles(fileList, targetFolderId, storageModeOverride);
  },

  /**
   * Queue processor maintaining concurrency limits
   */
  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    const maxConcurrent = this.getConcurrentUploads();

    try {
      while (this.queue.some(item => item.status === 'queued')) {
        const queuedItems = this.queue.filter(item => item.status === 'queued');
        const activeCount = this.queue.filter(item => item.status === 'uploading').length;
        const availableSlots = maxConcurrent - activeCount;

        if (availableSlots <= 0) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }

        const batch = queuedItems.slice(0, availableSlots);
        for (const item of batch) {
          item.status = 'uploading';
          item.cancelToken = false;
          item.startTime = Date.now();
          item.speedHistory = [];
          this.uploadFile(item).catch(err => {
            console.error(`[Upload] File "${item.name}" failed:`, err);
          });
        }
      }
    } finally {
      this.isProcessing = false;
      const anyActive = this.queue.some(item => item.status === 'uploading');
      if (!anyActive) {
        this.releaseWakeLock();
        this.isUploading = false;
      }
    }
  },

  /**
   * Uploads a single file (single-chunk direct or multi-chunk resumable with parallel chunks)
   */
  async uploadFile(item) {
    this.isUploading = true;
    this.acquireWakeLock();
    item.uploadedChunks = item.uploadedChunks || new Set();
    item.activeControllers = item.activeControllers || new Map();
    item.activeChunkLoaded = item.activeChunkLoaded || new Map();
    const chunkSize = item.chunkSize || this.getChunkSize();
    item.chunkSize = chunkSize;
    const totalChunks = item.totalChunks || Math.ceil(item.size / chunkSize) || 1;
    item.totalChunks = totalChunks;
    item.startTime = Date.now();
    this.renderUploadWidget();

    try {
      if (totalChunks === 1) {
        // Direct single-part upload for fast transfer
        const formData = new FormData();
        formData.append('file', item.file);
        if (item.folderId) formData.append('folderId', item.folderId);
        if (item.storageMode) formData.append('storageMode', item.storageMode);
        const primaryProv = this.getEffectivePrimaryProvider();
        formData.append('primaryProvider', primaryProv);
        const uploadStrat = localStorage.getItem('clouddrive_upload_strategy') || 'primary_first';
        formData.append('uploadStrategy', uploadStrat);
        formData.append('encryptionEnabled', this.isEncryptionEnabled());

        const controller = new AbortController();
        item.activeControllers.set(0, controller);

        const res = await API.uploadSingleFile(formData, {
          signal: controller.signal,
          onProgress: (loaded, total) => {
            if (item.status === 'paused' || item.cancelToken) return;
            item.bytesSent = loaded;
            const denom = total > 0 ? total : (item.size || 1);
            item.progress = Math.min(99, Math.round((loaded / denom) * 100));
            this.updateItemSpeedAndEta(item);
            this.scheduleRenderWidget();
          }
        });
        item.activeControllers.delete(0);

        if (item.status === 'paused' || item.cancelToken) return;

        item.bytesSent = item.size;
        item.progress = 100;
        item.status = 'completed';
        item.speed = '';
        item.eta = '';
        this.renderUploadWidget();

        UI.showToast(`"${item.name}" uploaded successfully!`, 'success');

        // Auto-generate and cache client-side thumbnail for instant preview
        if (res && res.file) {
          this.autoGenerateAndUploadThumbnail(res.file.id, item.file);
        }

        if (typeof App !== 'undefined') {
          if (res && res.file && App.addUploadedFileLocally) {
            App.addUploadedFileLocally(res.file, item.file);
          } else if (App.loadFolderContents) {
            App.loadFolderContents(App.currentFolderId, { silent: true });
          }
          if (App.loadStorageStats) App.loadStorageStats(true);
        }
        return;
      }

      // Multi-chunk resumable upload
      const activeUploadStrat = localStorage.getItem('clouddrive_upload_strategy') || 'primary_first';
      const effectivePrimary = this.getEffectivePrimaryProvider();
      const isEncActive = this.isEncryptionEnabled();
      if (!item.sessionId) {
        const initRes = await API.initUploadSession({
          fileName: item.name,
          fileSize: item.size,
          folderId: item.folderId,
          storageMode: item.storageMode,
          primaryProvider: effectivePrimary,
          uploadStrategy: activeUploadStrat,
          totalChunks,
          encryptionEnabled: isEncActive
        });
        item.sessionId = initRes.sessionId;
      } else {
        // Query server to verify previously uploaded chunks upon resume
        try {
          const sessionStatus = await API.getUploadSession(item.sessionId);
          if (sessionStatus && sessionStatus.uploadedChunks) {
            sessionStatus.uploadedChunks.forEach(idx => item.uploadedChunks.add(idx));
          }
        } catch (sErr) {
          console.warn('[Upload] Session verify error, re-initializing session:', sErr.message);
          const initRes = await API.initUploadSession({
            fileName: item.name,
            fileSize: item.size,
            folderId: item.folderId,
            storageMode: item.storageMode,
            primaryProvider: effectivePrimary,
            uploadStrategy: activeUploadStrat,
            totalChunks,
            encryptionEnabled: isEncActive
          });
          item.sessionId = initRes.sessionId;
          item.uploadedChunks.clear();
        }
      }

      const sessionId = item.sessionId;
      const CHUNK_CONCURRENCY = this.getChunkConcurrency();

      // Build queue of remaining un-uploaded chunk indices
      const pendingIndices = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!item.uploadedChunks.has(i)) {
          pendingIndices.push(i);
        }
      }

      let chunkQueueIndex = 0;

      const runChunkWorker = async () => {
        while (chunkQueueIndex < pendingIndices.length) {
          if (item.status === 'paused' || item.cancelToken) {
            return;
          }

          const currentIdx = pendingIndices[chunkQueueIndex++];
          if (item.uploadedChunks.has(currentIdx)) continue;

          const start = currentIdx * chunkSize;
          const end = Math.min(start + chunkSize, item.size);
          const chunkBlob = item.file.slice(start, end);

          const formData = new FormData();
          formData.append('sessionId', sessionId);
          formData.append('chunkIndex', currentIdx);
          formData.append('chunk', chunkBlob, `chunk_${currentIdx}.bin`);

          const controller = new AbortController();
          item.activeControllers.set(currentIdx, controller);

          try {
            await API.uploadChunk(formData, {
              signal: controller.signal,
              onProgress: (loaded, total) => {
                if (item.status === 'paused' || item.cancelToken) return;
                item.activeChunkLoaded.set(currentIdx, loaded);

                let totalLoaded = 0;
                for (const doneIdx of item.uploadedChunks) {
                  const cStart = doneIdx * chunkSize;
                  const cEnd = Math.min(cStart + chunkSize, item.size);
                  totalLoaded += (cEnd - cStart);
                }
                for (const [idx, bytes] of item.activeChunkLoaded.entries()) {
                  if (!item.uploadedChunks.has(idx)) {
                    totalLoaded += bytes;
                  }
                }

                item.bytesSent = Math.min(item.size, totalLoaded);
                item.progress = Math.min(99, Math.round((item.bytesSent / item.size) * 100));
                this.updateItemSpeedAndEta(item);
                this.scheduleRenderWidget();
              }
            });

            item.activeControllers.delete(currentIdx);
            item.activeChunkLoaded.delete(currentIdx);
            item.uploadedChunks.add(currentIdx);

            // Re-calculate accurately upon chunk completion
            let totalLoaded = 0;
            for (const doneIdx of item.uploadedChunks) {
              const cStart = doneIdx * chunkSize;
              const cEnd = Math.min(cStart + chunkSize, item.size);
              totalLoaded += (cEnd - cStart);
            }
            item.bytesSent = Math.min(item.size, totalLoaded);
            item.progress = Math.min(99, Math.round((item.bytesSent / item.size) * 100));
            this.updateItemSpeedAndEta(item);
            this.renderUploadWidget();
          } catch (chunkErr) {
            item.activeControllers.delete(currentIdx);
            item.activeChunkLoaded.delete(currentIdx);
            if (item.status === 'paused' || item.cancelToken) {
              return;
            }
            throw chunkErr;
          }
        }
      };

      // Launch parallel chunk workers
      const workers = [];
      const workerCount = Math.min(CHUNK_CONCURRENCY, pendingIndices.length || 1);
      for (let w = 0; w < workerCount; w++) {
        workers.push(runChunkWorker());
      }
      await Promise.all(workers);

      if (item.status === 'paused' || item.cancelToken) {
        return;
      }

      // Check if all chunks completed
      if (item.uploadedChunks.size < totalChunks) {
        if (item.status !== 'paused') {
          throw new Error('Not all chunks finished uploading');
        }
        return;
      }

      // Complete session
      const completeRes = await API.completeUploadSession(sessionId);
      item.bytesSent = item.size;
      item.progress = 100;
      item.status = 'completed';
      item.speed = '';
      item.eta = '';
      this.renderUploadWidget();

      const isDual = (item.storageMode === 'dual');
      UI.showToast(
        `"${item.name}" uploaded! ${isDual ? '(Secondary backup running in background)' : ''}`,
        'success'
      );

      // Auto-generate and cache client-side thumbnail for instant preview
      if (completeRes && completeRes.file) {
        this.autoGenerateAndUploadThumbnail(completeRes.file.id, item.file);
      }

      // Immediately update UI file list
      if (typeof App !== 'undefined') {
        if (completeRes && completeRes.file && App.addUploadedFileLocally) {
          App.addUploadedFileLocally(completeRes.file, item.file);
        } else if (App.loadFolderContents) {
          App.loadFolderContents(App.currentFolderId, { silent: true });
        }
        if (App.loadStorageStats) App.loadStorageStats(true);
      }

    } catch (err) {
      if (item.status === 'paused' || item.cancelToken) {
        return;
      }
      item.status = 'error';
      item.error = err.message || 'Upload failed';
      item.speed = '';
      item.eta = '';
      this.renderUploadWidget();
      UI.showToast(`Upload failed for "${item.name}": ${item.error}`, 'error');
    } finally {
      const anyActive = this.queue.some(q => q.status === 'uploading');
      if (!anyActive) {
        this.releaseWakeLock();
        this.isUploading = false;
      }
      this.processQueue();
    }
  },

  /**
   * Client-side automatic thumbnail generator & server uploader
   */
  autoGenerateAndUploadThumbnail(fileId, fileBlob) {
    if (!fileId || !fileBlob) return;
    const type = fileBlob.type || '';

    if (type.startsWith('image/')) {
      try {
        const img = new Image();
        const url = URL.createObjectURL(fileBlob);
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const targetW = Math.min(300, img.naturalWidth || 300);
            const targetH = Math.round((targetW / (img.naturalWidth || 1)) * (img.naturalHeight || 200));
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, targetW, targetH);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            if (dataUrl && dataUrl.length > 200) {
              API.uploadThumbnail(fileId, dataUrl);
            }
          } catch(e) {}
          URL.revokeObjectURL(url);
        };
        img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
      } catch (e) {}
    } else if (type.startsWith('video/')) {
      if (typeof UI !== 'undefined' && UI.generateVideoThumbnailFromBlob) {
        UI.generateVideoThumbnailFromBlob(fileBlob, fileId, null);
      }
    }
  },

  /**
   * Starts a remote URL download or Google Drive import
   */
  async startRemoteDownload(url, fileName, folderId) {
    if (!url) throw new Error('Download URL is required');
    const mode = this.getEffectiveStorageMode();
    return API.startRemoteUpload(url, fileName, folderId, mode);
  },

  handleRemoteProgress(data) {
    if (!data || !data.taskId) return;
    const existing = this.queue.find(q => q.id === data.taskId);
    if (existing) {
      existing.progress = data.progress || 0;
      existing.status = data.status === 'completed' ? 'completed' : (data.status === 'failed' ? 'error' : 'uploading');
      if (data.error) existing.error = data.error;
      this.renderUploadWidget();
    } else {
      this.queue.push({
        id: data.taskId,
        name: data.fileName || 'Remote Download',
        size: data.totalBytes || 0,
        folderId: data.folderId || null,
        storageMode: data.storageMode || 'dual',
        progress: data.progress || 0,
        status: data.status === 'completed' ? 'completed' : 'uploading',
        error: null,
        cancelToken: false
      });
      this.renderUploadWidget();
    }
  },

  handleRemoteCompleted(data) {
    if (!data) return;
    const existing = this.queue.find(q => q.id === data.taskId);
    if (existing) {
      existing.progress = 100;
      existing.status = 'completed';
      this.renderUploadWidget();
    }
    UI.showToast(`Remote download "${data.fileName || 'file'}" completed!`, 'success');
    if (typeof App !== 'undefined') {
      if (data.file && App.addUploadedFileLocally) {
        App.addUploadedFileLocally(data.file);
      } else if (App.loadFolderContents) {
        App.loadFolderContents(App.currentFolderId, { silent: true });
      }
      if (App.loadStorageStats) App.loadStorageStats(true);
    }
  },

  pauseUpload(uploadId) {
    const item = this.queue.find(q => q.id === uploadId);
    if (item && (item.status === 'uploading' || item.status === 'queued')) {
      item.status = 'paused';
      item.speed = '';
      item.eta = '';
      if (item.activeControllers) {
        item.activeControllers.forEach(ctrl => {
          try { ctrl.abort(); } catch(e) {}
        });
        item.activeControllers.clear();
      }
      this.renderUploadWidget();
      UI.showToast(`Paused "${item.name}"`, 'info');
    }
  },

  resumeUpload(uploadId) {
    const item = this.queue.find(q => q.id === uploadId);
    if (item && (item.status === 'paused' || item.status === 'error')) {
      item.status = 'queued';
      item.error = null;
      item.cancelToken = false;
      item.startTime = Date.now();
      item.speedHistory = [];
      this.renderUploadWidget();
      UI.showToast(`Resuming "${item.name}"...`, 'info');
      this.processQueue();
    }
  },

  retryUpload(uploadId) {
    const item = this.queue.find(q => q.id === uploadId);
    if (item && item.status === 'error') {
      item.status = 'queued';
      item.error = null;
      item.cancelToken = false;
      item.startTime = Date.now();
      item.speedHistory = [];
      this.renderUploadWidget();
      UI.showToast(`Retrying "${item.name}"...`, 'info');
      this.processQueue();
    }
  },

  async cancelUpload(uploadId) {
    const item = this.queue.find(q => q.id === uploadId);
    if (item) {
      item.cancelToken = true;
      item.status = 'error';
      item.error = 'Cancelled';
      item.speed = '';
      item.eta = '';
      if (item.activeControllers) {
        item.activeControllers.forEach(ctrl => {
          try { ctrl.abort(); } catch(e) {}
        });
        item.activeControllers.clear();
      }

      // If an upload session was active with uploaded chunks, purge them from cloud providers
      const sessId = item.sessionId;
      if (sessId) {
        API.cancelUploadSession(sessId).catch(err => {
          console.warn('[Upload] Cancel session cleanup warning:', err.message);
        });
      }

      this.renderUploadWidget();
      UI.showToast(`Upload cancelled for "${item.name}"`, 'info');
    }
  },

  scheduleRenderWidget() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.renderUploadWidget(true);
    });
  },

  renderUploadWidget(isIncremental = false) {
    let widget = document.getElementById('upload-status-widget');
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'upload-status-widget';
      widget.className = 'upload-status-widget';
      document.body.appendChild(widget);
    }

    // Bind once through delegation because this widget is frequently re-rendered.
    // Inline onclick attributes are blocked by the app's Content-Security-Policy.
    if (widget.dataset.eventsBound !== 'true') {
      widget.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-upload-widget-toggle]');
        if (toggle) {
          event.preventDefault();
          event.stopPropagation();
          this.toggleMinimize();
          return;
        }
        const close = event.target.closest('[data-upload-widget-close]');
        if (close) {
          event.preventDefault();
          event.stopPropagation();
          this.clearCompleted();
          return;
        }
        if (event.target.closest('[data-upload-widget-header]')) {
          this.toggleMinimize();
        }
      });
      widget.dataset.eventsBound = 'true';
    }

    if (this.queue.length === 0) {
      widget.style.display = 'none';
      return;
    }

    widget.style.display = 'flex';
    if (this.isMinimized) {
      widget.classList.add('minimized');
    } else {
      widget.classList.remove('minimized');
    }

    const totalCount = this.queue.length;
    const completedCount = this.queue.filter(q => q.status === 'completed').length;
    const hasActive = this.queue.some(q => q.status === 'uploading' || q.status === 'queued');

    // Aggregate progress & active speed
    let totalBytesSum = 0;
    let sentBytesSum = 0;
    let activeSpeedStr = '';

    for (const q of this.queue) {
      totalBytesSum += (q.size || 0);
      sentBytesSum += (q.bytesSent || 0);
      if (!activeSpeedStr && q.status === 'uploading' && q.speed) {
        activeSpeedStr = q.speed;
      }
    }
    const overallProgress = totalBytesSum > 0 ? Math.min(100, Math.round((sentBytesSum / totalBytesSum) * 100)) : (hasActive ? 0 : 100);

    let headerTitle = '';
    if (this.isMinimized) {
      if (hasActive) {
        headerTitle = `Uploading ${completedCount}/${totalCount} (${overallProgress}%${activeSpeedStr ? ` • ${activeSpeedStr}` : ''})`;
      } else {
        headerTitle = `Upload Complete (${completedCount}/${totalCount})`;
      }
    } else {
      headerTitle = hasActive ? `Uploading ${completedCount}/${totalCount} files` : `Upload Complete (${completedCount}/${totalCount})`;
    }

    const minimizeIcon = this.isMinimized
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`
      : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

    // Check if in-place update of existing DOM elements is possible
    const existingList = widget.querySelector('.upload-widget-list');
    const existingHeaderTitle = widget.querySelector('.upload-widget-title-text');
    const existingMiniBar = widget.querySelector('.upload-widget-mini-bar');

    if (existingList && !this.isMinimized) {
      const domItems = existingList.querySelectorAll('.upload-widget-item');
      const domIds = Array.from(domItems).map(el => el.getAttribute('data-id'));
      const queueIds = this.queue.map(q => String(q.id));

      const sameStructure = (domIds.length === queueIds.length) && domIds.every((id, idx) => id === queueIds[idx]);

      if (sameStructure) {
        if (existingHeaderTitle) existingHeaderTitle.textContent = headerTitle;
        if (existingMiniBar) existingMiniBar.style.width = `${overallProgress}%`;

        this.queue.forEach((item, index) => {
          const itemEl = domItems[index];
          if (!itemEl) return;

          const sizeFormatted = (typeof UI !== 'undefined' && UI.formatFileSize) ? UI.formatFileSize(item.size || 0) : `${item.size} B`;
          const sentFormatted = (typeof UI !== 'undefined' && UI.formatFileSize) ? UI.formatFileSize(item.bytesSent || 0) : `${item.bytesSent} B`;

          let statusText = `${item.progress}%`;
          let statusIconName = 'cloud';
          if (item.status === 'completed') {
            statusText = `Completed • ${sizeFormatted}`;
            statusIconName = 'check';
          } else if (item.status === 'paused') {
            statusText = `Paused (${item.progress}%) • ${sentFormatted} of ${sizeFormatted}`;
            statusIconName = 'pause';
          } else if (item.status === 'error') {
            statusText = `${item.error || 'Failed'} • ${sizeFormatted}`;
            statusIconName = 'error';
          } else if (item.status === 'queued') {
            statusText = `Queued • ${sizeFormatted}`;
            statusIconName = 'clock';
          } else if (item.status === 'uploading') {
            let metaParts = [`${item.progress}%`, `${sentFormatted} of ${sizeFormatted}`];
            if (item.speed) metaParts.push(item.speed);
            if (item.eta) metaParts.push(item.eta);
            statusText = metaParts.join(' • ');
          }

          // In-place update progress fill width & status class
          const fill = itemEl.querySelector('.upload-widget-progress-fill');
          if (fill) {
            fill.className = `upload-widget-progress-fill ${item.status}`;
            fill.style.width = `${item.progress}%`;
          }

          // In-place update meta text
          const metaSpan = itemEl.querySelector('.upload-widget-item-meta > span');
          if (metaSpan && metaSpan.textContent.trim() !== statusText) {
            metaSpan.replaceChildren();
            if (typeof UI !== 'undefined' && UI.icon) metaSpan.insertAdjacentHTML('afterbegin', UI.icon(statusIconName, 13));
            metaSpan.appendChild(document.createTextNode(` ${statusText}`));
          }

          // In-place update action buttons if status changed
          const actionsContainer = itemEl.querySelector('.upload-widget-item-actions');
          if (actionsContainer && itemEl.getAttribute('data-status') !== item.status) {
            itemEl.setAttribute('data-status', item.status);
            let actionButtons = '';
            if (item.status === 'uploading') {
              actionButtons = `
                <button class="btn-pause-upload" onclick="UploadManager.pauseUpload('${item.id}')" title="Pause" aria-label="Pause upload">${UI.icon('pause', 14)}</button>
                <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
              `;
            } else if (item.status === 'paused') {
              actionButtons = `
                <button class="btn-resume-upload" onclick="UploadManager.resumeUpload('${item.id}')" title="Resume" aria-label="Resume upload">${UI.icon('play', 14)}</button>
                <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
              `;
            } else if (item.status === 'error') {
              actionButtons = `
                <button class="btn-retry-upload" onclick="UploadManager.retryUpload('${item.id}')" title="Retry" aria-label="Retry upload">${UI.icon('retry', 14)}</button>
                <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Remove" aria-label="Remove upload">${UI.icon('close', 14)}</button>
              `;
            } else if (item.status === 'queued') {
              actionButtons = `
                <button class="btn-pause-upload" onclick="UploadManager.pauseUpload('${item.id}')" title="Pause" aria-label="Pause upload">${UI.icon('pause', 14)}</button>
                <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
              `;
            }
            actionsContainer.innerHTML = actionButtons;
          }
        });
        return;
      }
    }

    // Preserve scroll position if list is being fully re-rendered
    let savedScroll = 0;
    if (existingList) {
      savedScroll = existingList.scrollTop;
    } else if (this._savedScrollTop) {
      savedScroll = this._savedScrollTop;
    }

    let html = `
      <div class="upload-widget-header" data-upload-widget-header title="Click to ${this.isMinimized ? 'expand' : 'minimize'}">
        <div class="upload-widget-title-area">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="flex-shrink:0; opacity:0.85;">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
          </svg>
          <span class="upload-widget-title-text">${headerTitle}</span>
        </div>
        <div class="upload-widget-actions">
          <button type="button" class="upload-widget-btn upload-widget-toggle" data-upload-widget-toggle title="${this.isMinimized ? 'Expand panel' : 'Minimize panel'}" aria-label="Toggle panel">
            ${minimizeIcon}
          </button>
          <button type="button" class="upload-widget-btn upload-widget-close" data-upload-widget-close title="Clear Completed / Close" aria-label="Close">
            ${UI.icon('close', 15)}
          </button>
        </div>
        ${this.isMinimized && hasActive ? `<div class="upload-widget-mini-bar" style="width: ${overallProgress}%"></div>` : ''}
      </div>
      ${this.isMinimized ? '' : `
      <div class="upload-widget-list">
        ${this.queue.map(item => {
          const safeItemName = (typeof UI !== 'undefined' && UI.escapeHtml) ? UI.escapeHtml(item.name) : '';
          const modeBadge = item.storageMode === 'dual'
            ? '<span class="provider-badge provider-badge-dual">Dual</span>'
            : (item.storageMode === 'telegram'
              ? '<span class="provider-badge provider-badge-telegram">TG</span>'
              : '<span class="provider-badge provider-badge-discord">Discord</span>');

          const sizeFormatted = (typeof UI !== 'undefined' && UI.formatFileSize) ? UI.formatFileSize(item.size || 0) : `${item.size} B`;
          const sentFormatted = (typeof UI !== 'undefined' && UI.formatFileSize) ? UI.formatFileSize(item.bytesSent || 0) : `${item.bytesSent} B`;

          let statusText = `${item.progress}%`;
          let statusIconName = 'cloud';
          if (item.status === 'completed') {
            statusText = `Completed • ${sizeFormatted}`;
            statusIconName = 'check';
          } else if (item.status === 'paused') {
            statusText = `Paused (${item.progress}%) • ${sentFormatted} of ${sizeFormatted}`;
            statusIconName = 'pause';
          } else if (item.status === 'error') {
            statusText = `${item.error || 'Failed'} • ${sizeFormatted}`;
            statusIconName = 'error';
          } else if (item.status === 'queued') {
            statusText = `Queued • ${sizeFormatted}`;
            statusIconName = 'clock';
          } else if (item.status === 'uploading') {
            let metaParts = [`${item.progress}%`, `${sentFormatted} of ${sizeFormatted}`];
            if (item.speed) metaParts.push(item.speed);
            if (item.eta) metaParts.push(item.eta);
            statusText = metaParts.join(' • ');
          }

          let actionButtons = '';
          if (item.status === 'uploading') {
            actionButtons = `
              <button class="btn-pause-upload" onclick="UploadManager.pauseUpload('${item.id}')" title="Pause" aria-label="Pause upload">${UI.icon('pause', 14)}</button>
              <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
            `;
          } else if (item.status === 'paused') {
            actionButtons = `
              <button class="btn-resume-upload" onclick="UploadManager.resumeUpload('${item.id}')" title="Resume" aria-label="Resume upload">${UI.icon('play', 14)}</button>
              <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
            `;
          } else if (item.status === 'error') {
            actionButtons = `
              <button class="btn-retry-upload" onclick="UploadManager.retryUpload('${item.id}')" title="Retry" aria-label="Retry upload">${UI.icon('retry', 14)}</button>
              <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Remove" aria-label="Remove upload">${UI.icon('close', 14)}</button>
            `;
          } else if (item.status === 'queued') {
            actionButtons = `
              <button class="btn-pause-upload" onclick="UploadManager.pauseUpload('${item.id}')" title="Pause" aria-label="Pause upload">${UI.icon('pause', 14)}</button>
              <button class="btn-cancel-upload" onclick="UploadManager.cancelUpload('${item.id}')" title="Cancel" aria-label="Cancel upload">${UI.icon('close', 14)}</button>
            `;
          }

          return `
            <div class="upload-widget-item" data-id="${item.id}" data-status="${item.status}">
              <div class="upload-widget-item-title" title="${safeItemName}">${safeItemName}</div>
              <div class="upload-widget-progress-bar">
                <div class="upload-widget-progress-fill ${item.status}" style="width: ${item.progress}%"></div>
              </div>
              <div class="upload-widget-item-meta">
                <span class="flat-icon-label">${UI.icon(statusIconName, 13)} ${UI.escapeHtml(statusText)}</span>
                <div style="display: flex; align-items: center; gap: 6px;">
                  ${modeBadge}
                  <span class="upload-widget-item-actions" style="display: flex; align-items: center; gap: 4px;">
                    ${actionButtons}
                  </span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
      `}
    `;

    widget.innerHTML = html;

    const newList = widget.querySelector('.upload-widget-list');
    if (newList) {
      if (savedScroll > 0) {
        newList.scrollTop = savedScroll;
      }
      newList.addEventListener('scroll', () => {
        this._savedScrollTop = newList.scrollTop;
      }, { passive: true });
    }
  },

  clearCompleted() {
    this.queue = this.queue.filter(q => q.status !== 'completed' && q.status !== 'error');
    if (this.queue.length === 0) {
      if (this._renderThrottleTimer) { clearTimeout(this._renderThrottleTimer); this._renderThrottleTimer = null; }
      if (this._renderScheduled) this._renderScheduled = false;
      const widget = document.getElementById('upload-status-widget');
      if (widget) widget.remove();
      this.isMinimized = false;
      return;
    }
    this.renderUploadWidget();
  },

  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  },

  releaseWakeLock() {
    try {
      if (this.wakeLock) {
        this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (e) {}
  }
};

// Aliases for flawless backwards & cross-component compatibility
window.UploadManager = UploadManager;
window.Upload = UploadManager;
