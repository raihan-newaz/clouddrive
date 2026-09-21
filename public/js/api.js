/**
 * CloudDrive API Client
 * Complete unified API for CloudDrive supporting multi-cloud (Discord & Telegram), WebDAV, and Multi-User
 */
const API = {
  baseUrl: '/api',

  token: null,
  
  folderTokens: (() => {
    const tokens = {};
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && (key.startsWith('discorddrive_ftok_') || key.startsWith('clouddrive_ftok_'))) {
          tokens[key.replace(/^.*_ftok_/, '')] = sessionStorage.getItem(key);
        }
      }
    } catch (e) {}
    return tokens;
  })(),

  setToken(t) {
    this.token = null;
    localStorage.removeItem('clouddrive_token');
    localStorage.removeItem('discorddrive_token');
    localStorage.removeItem('token');
    try { sessionStorage.removeItem('clouddrive_token'); } catch (e) {}
  },

  async refreshToken() {
    if (!this.token) return;
    try {
      const res = await this.request('POST', '/api/auth/refresh');
      if (res && res.token) {
        this.setToken(res.token);
      }
    } catch (e) {}
  },

  /**
   * Dual-mode HTTP request helper
   * Mode A (CloudDrive style): request(method, url, body, options)
   * Mode B (CloudDrive legacy style): request(endpoint, options)
   */
  async request(arg1, arg2 = null, arg3 = null, arg4 = {}) {
    let method = 'GET';
    let url = '';
    let body = null;
    let options = {};

    if (typeof arg1 === 'string' && (arg1.startsWith('/') || arg1.startsWith('http'))) {
      // Legacy style: request(endpoint, options)
      url = arg1.startsWith('/api') ? arg1 : `${this.baseUrl}${arg1.startsWith('/') ? '' : '/'}${arg1}`;
      options = arg2 || {};
      method = (options.method || 'GET').toUpperCase();
      body = options.body || null;
    } else {
      // Standard style: request(method, url, body, options)
      method = (arg1 || 'GET').toUpperCase();
      url = arg2 || '';
      if (!url.startsWith('/api') && !url.startsWith('http')) {
        url = `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
      }
      body = arg3;
      options = arg4 || {};
    }

    const { headers: customHeaders, ...restOptions } = options;
    const headers = { ...customHeaders };

    const activeToken = this.token;
    if (activeToken && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }

    if (body && !(body instanceof FormData) && typeof body === 'object') {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, {
        ...restOptions,
        method,
        headers,
        credentials: 'include',
        body: method !== 'GET' && method !== 'HEAD' ? body : null
      });

      const contentType = response.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        data = await response.json();
      }

      if (response.status === 401) {
        const isSubPasswordCheck = url.includes('/verify-lock') || url.includes('/unlock') || url.includes('/share/public');
        const isAuthVerify = url.includes('/auth/verify') || url.includes('/auth/me');
        if (!isSubPasswordCheck && !url.includes('/auth/login')) {
          // Only clear token and redirect if the auth verification endpoint itself rejects us
          if (isAuthVerify) {
            this.setToken(null);
            if (typeof App !== 'undefined' && App.showScreen) {
              App.showScreen('login');
            } else if (typeof App !== 'undefined' && App.onUnauthorized) {
              App.onUnauthorized();
            }
          }
        }
        const err = new Error(data?.error || 'Unauthorized');
        err.status = 401;
        throw err;
      }

      if (!response.ok) {
        const errorMsg = data?.error || `Request failed with status ${response.status}`;
        const error = new Error(errorMsg);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data !== null ? data : response;
    } catch (error) {
      console.error(`[API] ${method} ${url} Error:`, error);
      throw error;
    }
  },

  // ─── Setup & Remote ────────────────────────────────────────────────────────

  async getSetupStatus() {
    return this.request('GET', '/api/setup/status');
  },

  async validateDiscord(botToken, guildId, channelId) {
    return this.request('POST', '/api/setup/validate', { botToken, guildId, channelId });
  },

  async completeSetup(data) {
    return this.request('POST', '/api/setup/complete', data);
  },

  async initSetup(data) {
    return this.request('POST', '/api/setup/init', data);
  },

  // ─── Authentication ────────────────────────────────────────────────────────

  async login(emailOrPassword, maybePassword) {
    let payload = {};
    if (maybePassword !== undefined) {
      payload = { email: emailOrPassword, password: maybePassword };
    } else {
      payload = { password: emailOrPassword };
    }
    const data = await this.request('POST', '/api/auth/login', payload);
    if (data && data.token) {
      this.setToken(data.token);
    }
    return data;
  },

  async register(email, password, name, filePrefix) {
    const data = await this.request('POST', '/api/auth/register', { email, password, name, filePrefix });
    if (data && data.token) {
      this.setToken(data.token);
    }
    return data;
  },

  async verifyAuth() {
    return this.request('GET', '/api/auth/verify');
  },

  async getProfile() {
    return this.request('GET', '/api/auth/me');
  },

  async getMe() {
    return this.request('GET', '/api/auth/me');
  },

  async updateProfile(data) {
    return this.request('PUT', '/api/auth/profile', data);
  },

  async changePassword(currentPassword, newPassword) {
    return this.request('POST', '/api/auth/change-password', { currentPassword, newPassword });
  },

  async logout() {
    try {
      await this.request('POST', '/api/auth/logout');
    } catch (e) {}
    this.folderTokens = {};
    try { sessionStorage.clear(); } catch (e) {}
    this.setToken(null);
  },

  // ─── Admin (Multi-User) ────────────────────────────────────────────────────

  async getAdminUsers() {
    return this.request('GET', '/api/admin/users');
  },

  async createAdminUser(data) {
    return this.request('POST', '/api/admin/users', data);
  },

  async updateAdminUser(id, data) {
    return this.request('PUT', `/api/admin/users/${id}`, data);
  },

  async resetAdminUserPassword(id, password) {
    return this.request('POST', `/api/admin/users/${id}/reset-password`, { newPassword: password, password });
  },

  async deleteAdminUser(id) {
    return this.request('DELETE', `/api/admin/users/${id}`);
  },

  async getAdminStats() {
    return this.request('GET', '/api/admin/stats');
  },

  // ─── Folders ───────────────────────────────────────────────────────────────

  async getFolderContents(folderId = null, search = '', isTrash = false) {
    const fid = (folderId && folderId !== 'null' && folderId !== 'root') ? folderId : null;
    const params = new URLSearchParams();
    if (fid) params.append('parentId', fid);
    if (search && search.trim()) params.append('search', search.trim());
    if (isTrash) params.append('trash', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const headers = {};
    if (fid && this.folderTokens[String(fid)]) {
      headers['X-Folder-Token'] = this.folderTokens[String(fid)];
    }
    return this.request('GET', `/api/folders${qs}`, null, { headers });
  },

  async getFolders(options = null) {
    if (typeof options === 'string' || options === null) {
      const query = options ? `?parentId=${options}` : '';
      return this.request('GET', `/api/folders${query}`);
    }
    const params = new URLSearchParams();
    if (options.parentId) params.append('parentId', options.parentId);
    if (options.trash || options.trashed) params.append('trash', 'true');
    if (options.search) params.append('search', options.search);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request('GET', `/api/folders${qs}`);
  },

  async getFolderTree() {
    return this.request('GET', '/api/folders/tree');
  },

  async getFolderStats(id) {
    const fid = String(id);
    const headers = {};
    if (fid && this.folderTokens[fid]) {
      headers['X-Folder-Token'] = this.folderTokens[fid];
    }
    return this.request('GET', `/api/folders/${id}/stats`, null, { headers });
  },

  async createFolder(name, parentId = null, storagePolicy = null, pinPassword = null) {
    return this.request('POST', '/api/folders', { name, parentId, storagePolicy, pinPassword });
  },

  async renameFolder(id, name) {
    return this.request('PATCH', `/api/folders/${id}`, { name });
  },

  async moveFolder(id, parent_id) {
    return this.request('PATCH', `/api/folders/${id}`, { parent_id });
  },

  async updateFolder(id, updates) {
    return this.request('PUT', `/api/folders/${id}`, updates);
  },

  async deleteFolder(id, permanent = false) {
    return this.request('DELETE', `/api/folders/${id}${permanent ? '?permanent=true' : ''}`);
  },

  async restoreFolder(id) {
    return this.request('POST', `/api/folders/${id}/restore`);
  },

  async lockFolder(id, password) {
    const fid = String(id);
    delete this.folderTokens[fid];
    try {
      sessionStorage.removeItem('discorddrive_ftok_' + fid);
      sessionStorage.removeItem('clouddrive_ftok_' + fid);
      sessionStorage.removeItem('discorddrive_unlocked_' + fid);
    } catch (e) {}
    return this.request('POST', `/api/folders/${id}/lock`, { password, pinPassword: password });
  },

  async verifyFolderLock(id, password) {
    const fid = String(id);
    const res = await this.request('POST', `/api/folders/${id}/verify-lock`, { password, pinPassword: password });
    if (res && res.folderToken) {
      this.folderTokens[fid] = res.folderToken;
      try {
        sessionStorage.setItem('discorddrive_ftok_' + fid, res.folderToken);
        sessionStorage.setItem('clouddrive_ftok_' + fid, res.folderToken);
      } catch (e) {}
    }
    return res;
  },

  async unlockFolderPermanently(id, password) {
    const fid = String(id);
    delete this.folderTokens[fid];
    try {
      sessionStorage.removeItem('discorddrive_ftok_' + fid);
      sessionStorage.removeItem('clouddrive_ftok_' + fid);
      sessionStorage.removeItem('discorddrive_unlocked_' + fid);
    } catch (e) {}
    return this.request('POST', `/api/folders/${id}/unlock-permanently`, { password, pinPassword: password });
  },

  async unlockFolder(id, pinPassword) {
    return this.verifyFolderLock(id, pinPassword);
  },

  // ─── Files ─────────────────────────────────────────────────────────────────

  async getFiles(params = {}) {
    const query = new URLSearchParams();
    if (params.folderId) query.append('folderId', params.folderId);
    if (params.search) query.append('search', params.search);
    if (params.type) query.append('type', params.type);
    if (params.starred) query.append('starred', 'true');
    if (params.trashed) query.append('trashed', 'true');
    const qs = query.toString() ? `?${query.toString()}` : '';
    const res = await this.request('GET', `/api/files${qs}`);
    return Array.isArray(res) ? res : (res?.files || []);
  },

  async renameFile(id, name, folderId = undefined) {
    return this.request('PATCH', `/api/files/${id}`, { name, folder_id: folderId });
  },

  async moveFile(id, folder_id) {
    return this.request('PATCH', `/api/files/${id}`, { folder_id });
  },

  async starFile(id, is_starred = true) {
    return this.request('PATCH', `/api/files/${id}`, { is_starred: is_starred !== false });
  },

  async trashFile(id) {
    return this.request('DELETE', `/api/files/${id}`);
  },

  async permanentDeleteFile(id) {
    return this.request('DELETE', `/api/files/${id}/permanent`);
  },

  async deleteFilePermanently(id) {
    return this.permanentDeleteFile(id);
  },

  async emptyTrash() {
    return this.request('DELETE', '/api/files/trash/empty');
  },

  async restoreFile(id) {
    return this.request('POST', `/api/files/${id}/restore`);
  },

  // ─── Batch Operations ──────────────────────────────────────────────────────

  async batchTrash(fileIds = [], folderIds = []) {
    return this.request('POST', '/api/files/batch-trash', { fileIds, folderIds });
  },

  async batchRestore(fileIds = [], folderIds = []) {
    return this.request('POST', '/api/files/batch-restore', { fileIds, folderIds });
  },

  async batchDelete(fileIds = [], folderIds = []) {
    return this.request('POST', '/api/files/batch-delete', { fileIds, folderIds });
  },

  async batchDeletePermanently(fileIds = [], folderIds = []) {
    return this.batchDelete(fileIds, folderIds);
  },

  async batchStar(fileIds = [], isStarred = true) {
    return this.request('POST', '/api/files/batch-star', { fileIds, isStarred });
  },

  async batchMove(fileIds = [], folderIds = [], targetFolderId = null) {
    return this.request('POST', '/api/files/batch-move', { fileIds, folderIds, targetFolderId });
  },

  // ─── File Uploads ──────────────────────────────────────────────────────────

  uploadWithProgress(url, formData, options = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const method = (options.method || 'POST').toUpperCase();
      const targetUrl = url.startsWith('/api') || url.startsWith('http') ? url : `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;

      xhr.open(method, targetUrl, true);
      xhr.withCredentials = true;

      const activeToken = this.token;
      if (activeToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${activeToken}`);
      }

      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          xhr.setRequestHeader(key, value);
        }
      }

      if (options.signal) {
        if (options.signal.aborted) {
          return reject(new Error('Upload aborted'));
        }
        options.signal.addEventListener('abort', () => {
          xhr.abort();
          reject(new Error('Upload aborted'));
        });
      }

      if (options.onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            try {
              options.onProgress(e.loaded, e.total);
            } catch (err) {}
          }
        };
      }

      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          data = xhr.responseText;
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          const errMsg = (data && data.error) ? data.error : `Upload failed with status ${xhr.status}`;
          const err = new Error(errMsg);
          err.status = xhr.status;
          err.data = data;
          reject(err);
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));

      xhr.send(formData);
    });
  },

  async initUploadSession(data) {
    return this.request('POST', '/api/files/upload/init', data);
  },

  async getUploadSession(sessionId) {
    return this.request('GET', `/api/files/upload/session/${sessionId}`);
  },

  async uploadChunk(formData, options = {}) {
    return this.uploadWithProgress('/api/files/upload/chunk', formData, options);
  },

  async completeUploadSession(sessionId) {
    return this.request('POST', '/api/files/upload/complete', { sessionId });
  },

  async cancelUploadSession(sessionId) {
    return this.request('POST', '/api/files/upload/cancel', { sessionId });
  },

  async uploadSingleFile(formData, options = {}) {
    return this.uploadWithProgress('/api/files/upload', formData, options);
  },

  // ─── Media & Download URLs ─────────────────────────────────────────────────

  buildMediaUrl(fileId, endpoint) {
    const file = typeof App !== 'undefined' && App.filesMap ? App.filesMap.get(String(fileId)) : null;
    const folderToken = file && file.folder_id ? this.folderTokens[String(file.folder_id)] : '';
    const params = new URLSearchParams();
    if (folderToken) params.append('folderToken', folderToken);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return `/api/files/${fileId}/${endpoint}${qs}`;
  },

  getDownloadUrl(fileId) {
    return this.buildMediaUrl(fileId, 'download');
  },

  getThumbnailUrl(fileId) {
    const url = this.buildMediaUrl(fileId, 'thumbnail');
    // Discard cached thumbnail 404s after another device has generated one.
    return `${url}${url.includes('?') ? '&' : '?'}v=3`;
  },

  getStreamUrl(fileId) {
    return this.buildMediaUrl(fileId, 'stream');
  },

  async uploadThumbnail(fileId, thumbnailBase64) {
    if (!fileId || !thumbnailBase64) return null;
    try {
      return await this.request('POST', `/api/files/${fileId}/thumbnail`, { thumbnail: thumbnailBase64 });
    } catch (e) {
      return null;
    }
  },

  // ─── Multi-Cloud Replication & Health ──────────────────────────────────────

  async replicateFile(fileId, targetProvider) {
    return this.request('POST', `/api/files/${fileId}/replicate`, { targetProvider });
  },

  async repairFile(fileId) {
    return this.request('POST', `/api/files/${fileId}/repair`);
  },

  async getFileReplicas(fileId) {
    return this.request('GET', `/api/files/${fileId}/replicas`);
  },

  async getSyncStatus() {
    return this.request('GET', '/api/storage/sync-status');
  },

  async reconcileStorage() {
    return this.request('POST', '/api/storage/reconcile');
  },

  // ─── Settings & Preferences ────────────────────────────────────────────────

  async getSettings() {
    return this.request('GET', '/api/settings');
  },

  async getStorageStats() {
    return this.request('GET', '/api/settings/storage-stats');
  },

  async getPreferences() {
    return this.request('GET', '/api/settings/preferences');
  },

  async updatePreferences(preferences) {
    return this.request('PUT', '/api/settings/preferences', { preferences });
  },

  async updatePolicy(data) {
    return this.request('POST', '/api/settings/policy', data);
  },

  async saveDiscordSettings(data) {
    return this.request('POST', '/api/settings/discord', data);
  },

  async updateDiscordSettings(data) {
    return this.saveDiscordSettings(data);
  },

  async testDiscordSettings(data) {
    return this.request('POST', '/api/settings/discord/test', data);
  },

  async testDiscord(data) {
    return this.testDiscordSettings(data);
  },

  async disconnectDiscord() {
    return this.request('POST', '/api/settings/discord/disconnect');
  },

  async saveTelegramSettings(data) {
    return this.request('POST', '/api/settings/telegram', data);
  },

  async testTelegram(data) {
    return this.request('POST', '/api/settings/telegram/test', data);
  },

  async disconnectTelegram() {
    return this.request('POST', '/api/settings/telegram/disconnect');
  },

  async clearCache() {
    return this.request('POST', '/api/settings/clear-cache');
  },

  async runSpeedTest() {
    return this.request('POST', '/api/settings/speedtest');
  },

  async getStorageStats() {
    return this.request('GET', '/api/storage/stats');
  },

  async getStorageBreakdown() {
    return this.request('GET', '/api/storage/breakdown');
  },

  async getLargestFiles(limit = 10) {
    return this.request('GET', `/api/storage/largest?limit=${limit}`);
  },

  async getRecentStorageActivity(limit = 10) {
    return this.request('GET', `/api/storage/recent?limit=${limit}`);
  },

  async recalculateStorage() {
    return this.request('POST', '/api/storage/recalculate');
  },

  async reconcileStorage() {
    return this.request('POST', '/api/storage/reconcile');
  },

  async getSyncStatus() {
    return this.request('GET', '/api/storage/sync-status');
  },

  // ─── Share ─────────────────────────────────────────────────────────────────

  async getShareStatus(fileId) {
    return this.request('GET', `/api/share/file/${fileId}`);
  },

  async updateShareStatus(fileId, data) {
    return this.request('POST', `/api/share/file/${fileId}`, data);
  },

  async revokeShare(fileId) {
    return this.request('DELETE', `/api/share/file/${fileId}`);
  },

  getExportDbUrl() {
    return '/api/settings/export-db';
  },

  async getBackupStatus() {
    return this.request('GET', '/api/settings/backup-status');
  },

  async backupNow(provider = 'all') {
    return this.request('POST', '/api/settings/backup-now', { provider });
  },

  async restoreCloudBackup(remoteId, provider = null) {
    return this.request('POST', '/api/settings/restore-cloud-backup', { remoteId, provider, discordMessageId: remoteId });
  },

  async deleteCloudBackup(id) {
    return this.request('DELETE', `/api/settings/backup/${id}`);
  },

  async importDatabase(file) {
    const formData = new FormData();
    formData.append('database', file);
    return this.request('POST', '/api/settings/import-db', formData);
  },

  // ─── WebDAV Network Storage ────────────────────────────────────────────────

  async getWebDavSettings() {
    return this.request('GET', '/api/settings/webdav');
  },

  async updateWebDavSettings(data) {
    return this.request('POST', '/api/settings/webdav', data);
  },

  async testWebDavAuth(username, password) {
    return this.request('POST', '/api/settings/webdav/test-auth', { username, password });
  },

  async getWebDavSessions() {
    return this.request('GET', '/api/settings/webdav/sessions');
  },

  async revokeWebDavSession(sessionId) {
    return this.request('POST', '/api/settings/webdav/sessions/revoke', { sessionId });
  },

  async unrevokeWebDavSession(sessionId) {
    return this.request('POST', '/api/settings/webdav/sessions/unrevoke', { sessionId });
  },

  // ─── File Sharing ──────────────────────────────────────────────────────────

  async getShareStatus(fileId) {
    return this.request('GET', `/api/share/file/${fileId}`);
  },

  async updateShareStatus(fileId, options) {
    return this.request('POST', `/api/share/file/${fileId}`, options);
  },

  async createShare(fileId, password = null, expiresDays = null) {
    return this.request('POST', `/api/share/${fileId}`, { password, expiresDays });
  },

  async revokeShare(fileId) {
    return this.request('DELETE', `/api/share/file/${fileId}`);
  },

  // ─── Remote URL Upload ─────────────────────────────────────────────────────

  async startRemoteUpload(url, fileName, folderId, chunkSize) {
    return this.request('POST', '/api/remote-upload/start', { url, fileName, folderId, chunkSize });
  },

  async remoteUpload(url, folderId, storageMode) {
    return this.request('POST', '/api/remote-upload', { url, folderId, storageMode });
  },

  async getRemoteTasks() {
    return this.request('GET', '/api/remote-upload/tasks');
  },

  async cancelRemoteTask(taskId) {
    return this.request('POST', '/api/remote-upload/cancel', { taskId });
  },

  // ─── Duplicate Detection ───────────────────────────────────────────────────

  async checkFileDuplicate(sha256, size, fileName) {
    return this.request('POST', '/api/files/check-duplicate', { sha256, size, fileName });
  },

  // ─── Storage Analytics ─────────────────────────────────────────────────────

  async getStorageStats() {
    return this.request('GET', '/api/storage/stats');
  },

  async getStorageBreakdown() {
    return this.request('GET', '/api/storage/breakdown');
  },

  async getLargestFiles(limit = 10) {
    return this.request('GET', `/api/storage/largest?limit=${limit}`);
  },

  async getRecentStorageActivity(limit = 10) {
    return this.request('GET', `/api/storage/recent?limit=${limit}`);
  },

  // ─── Admin Storage Analytics ───────────────────────────────────────────────

  async getAdminStorageStats() {
    return this.request('GET', '/api/admin/storage/stats');
  },

  async getAdminStorageBreakdown() {
    return this.request('GET', '/api/storage/breakdown');
  },

  async getAdminUserStorage() {
    return this.request('GET', '/api/admin/users');
  }
};

if (typeof window !== 'undefined') {
  window.API = API;
}
