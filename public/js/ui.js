/**
 * UI Utilities and DOM Renderers for CloudDrive
 */
const UI = {
  selectedItems: new Map(),

  /**
   * Small, dependency-free flat icon set used by dynamically rendered UI.
   * Icons inherit text colour, so they remain legible in every theme.
   */
  icons: {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4 4L19 7"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    warning: '<path d="M12 3L2.8 20h18.4L12 3z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    file: '<path d="M6 2.5h8l4 4V21H6z"/><path d="M14 2.5v5h4M9 12h6M9 16h6"/>',
    folder: '<path d="M3 6.5h7l2 2h9v10.5H3z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="M4 17l5-5 3.5 3 2.5-2 5 4"/>',
    video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    archive: '<path d="M4 7h16v14H4zM3 3h18v4H3zM9 11h6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3M12 14v3"/>',
    unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M16 10V7a4 4 0 00-7.5-2M12 14v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M15 8l2 2M17 6l2 2"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    tag: '<path d="M3 4h7l11 11-6 6L4 10z"/><circle cx="8" cy="8" r="1"/>',
    bolt: '<path d="M13 2L5 14h6l-1 8 9-13h-6z"/>',
    rocket: '<path d="M14 4c3-2 6-2 6-2s0 3-2 6l-6 6-4-4zM8 10l-4 2 3 2M12 14l-2 4 3-1M5 19l3-3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    cloud: '<path d="M7 18h11a4 4 0 00.7-7.9A7 7 0 005.4 8.5 4.8 4.8 0 007 18z"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    retry: '<path d="M20 7v5h-5M19 12a7 7 0 10-1.5 4.3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M5.5 16c.8-2 4.2-2 5 0M13 10h5M13 14h5"/>'
  },

  icon(name, size = 16, className = '') {
    const body = this.icons[name] || this.icons.info;
    const safeSize = Number.isFinite(Number(size)) ? Math.max(10, Math.min(96, Number(size))) : 16;
    const safeClass = String(className || '').replace(/[^a-zA-Z0-9 _-]/g, '');
    return `<svg class="flat-icon ${safeClass}" viewBox="0 0 24 24" width="${safeSize}" height="${safeSize}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  },

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  },

  escapeAttr(value) {
    return this.escapeHtml(value).replace(/`/g, '&#96;');
  },

  // ─── Direct Background Download (No Blank Tabs) ────────────────────
  triggerDownload(url, filename) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.setAttribute('download', filename);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  },

  // ─── Toasts ────────────────────────────────────────────────────────
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#1a73e8"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
    if (type === 'success') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#34a853"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    } else if (type === 'error') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    } else if (type === 'warning') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#fbbc05"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
    }

    const iconWrap = document.createElement('span');
    iconWrap.className = 'toast-icon';
    iconWrap.style.cssText = 'display:inline-flex;align-items:center;';
    iconWrap.innerHTML = icon;
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message ?? '');
    toast.append(iconWrap, msg);

    container.appendChild(toast);

    setTimeout(() => toast.classList.add('visible'), 10);

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  // ─── Modals ────────────────────────────────────────────────────────
  showModal(modalId) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById(modalId);
    if (overlay && modal) {
      overlay.style.display = 'block';
      overlay.classList.add('visible');
      modal.style.display = (modal.classList.contains('settings-modal') || modal.classList.contains('share-modal')) ? 'flex' : 'block';
      modal.classList.add('visible');
      modal.removeAttribute('inert');
      modal.removeAttribute('aria-hidden');
      modal.querySelectorAll('input, button, select, textarea').forEach(el => {
        el.disabled = false;
        el.removeAttribute('inert');
      });
    }
  },

  hideModal(modalId) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('visible');
      modal.style.display = 'none';
      modal.setAttribute('inert', '');
      modal.setAttribute('aria-hidden', 'true');
      modal.querySelectorAll('input, button, select, textarea').forEach(el => el.blur());
    }
    const anyVisible = document.querySelector('.modal.visible');
    if (!anyVisible && overlay) {
      overlay.classList.remove('visible');
      overlay.style.display = 'none';
    }
  },

  hideAllModals() {
    document.querySelectorAll('.modal').forEach(m => {
      m.classList.remove('visible');
      m.style.display = 'none';
      m.setAttribute('inert', '');
      m.setAttribute('aria-hidden', 'true');
      m.querySelectorAll('input, button, select, textarea').forEach(el => el.blur());
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
      overlay.style.display = 'none';
    }
  },

  hideModals() {
    this.hideAllModals();
  },

  /**
   * Modern, Promise-based custom confirmation dialog with beautiful UI
   * @param {Object} options
   * @param {string} options.title - Header title
   * @param {string} options.message - Primary question / message
   * @param {string} [options.description] - Additional warning or details
   * @param {string} [options.icon='danger'] - 'danger' | 'trash' | 'warning' | 'info'
   * @param {string} [options.confirmText='Confirm'] - Action button text
   * @param {string} [options.cancelText='Cancel'] - Cancel button text
   * @param {string} [options.confirmType='danger'] - 'danger' | 'primary' | 'warning'
   * @returns {Promise<boolean>}
   */
  confirm({
    title = 'Are you sure?',
    message = 'Do you want to proceed?',
    description = '',
    icon = 'danger',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    confirmType = 'danger'
  } = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById('custom-confirm-modal');
      const titleEl = document.getElementById('confirm-modal-title');
      const msgEl = document.getElementById('confirm-modal-message');
      const descEl = document.getElementById('confirm-modal-description');
      const iconWrap = document.getElementById('confirm-icon-wrapper');
      const iconEl = document.getElementById('confirm-icon');
      const cancelBtn = document.getElementById('confirm-btn-cancel');
      const actionBtn = document.getElementById('confirm-btn-action');

      if (!modal || !titleEl || !msgEl || !actionBtn || !cancelBtn) {
        return resolve(window.confirm(`${title}\n\n${message}`));
      }

      titleEl.textContent = title;
      msgEl.textContent = message;

      if (description) {
        descEl.textContent = description;
        descEl.style.display = 'block';
        descEl.className = `confirm-subtext ${confirmType === 'danger' ? 'danger' : (confirmType === 'warning' ? 'warning' : '')}`;
      } else {
        descEl.style.display = 'none';
      }

      // Set icon style and SVG
      if (iconWrap) iconWrap.className = `confirm-icon-wrapper ${confirmType || icon}`;
      const icons = {
        danger: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9V8zm4 0h2v9h-2V8z"/></svg>`,
        warning: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
        info: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`
      };
      if (iconEl) iconEl.innerHTML = icons[icon] || icons.danger;

      // Button styling & text
      cancelBtn.textContent = cancelText;
      actionBtn.textContent = confirmText;
      actionBtn.className = `btn-${confirmType || 'danger'}`;

      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        this.hideModal('custom-confirm-modal');
        document.removeEventListener('keydown', onKeyDown);
      };

      const onConfirm = () => {
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onConfirm();
        }
      };

      cancelBtn.onclick = onCancel;
      actionBtn.onclick = onConfirm;

      // Close on backdrop overlay click
      const overlay = document.getElementById('modal-overlay');
      if (overlay) {
        overlay.onclick = () => {
          if (modal.classList.contains('visible')) {
            onCancel();
          }
        };
      }

      document.addEventListener('keydown', onKeyDown);
      this.showModal('custom-confirm-modal');
      actionBtn.focus();
    });
  },

  // ─── Loading Skeletons ─────────────────────────────────────────────
  showSkeletons() {
    const sk = document.getElementById('skeleton-container');
    const fc = document.getElementById('file-container');
    const empty = document.getElementById('empty-state');
    if (sk) {
      sk.classList.remove('hidden');
      const mode = (typeof App !== 'undefined' && App.viewMode) || localStorage.getItem('discorddrive_view_mode') || 'grid';
      if (mode === 'list') {
        sk.className = 'skeleton-container list-view';
        sk.style.display = 'flex';
        sk.innerHTML = Array(8).fill(`
          <div class="skeleton-row">
            <div class="skeleton-icon skeleton-shimmer"></div>
            <div class="skeleton-text-group">
              <div class="skeleton-line skeleton-title skeleton-shimmer"></div>
              <div class="skeleton-line skeleton-sub skeleton-shimmer"></div>
            </div>
            <div class="skeleton-line skeleton-meta skeleton-shimmer"></div>
          </div>
        `).join('');
      } else {
        sk.className = 'skeleton-container grid-view';
        sk.style.display = 'grid';
        sk.innerHTML = Array(8).fill(`
          <div class="skeleton-card">
            <div class="skeleton-card-thumb skeleton-shimmer"></div>
            <div class="skeleton-card-body">
              <div class="skeleton-line skeleton-title skeleton-shimmer"></div>
              <div class="skeleton-line skeleton-sub skeleton-shimmer"></div>
            </div>
          </div>
        `).join('');
      }
    }
    if (fc) fc.style.display = 'none';
    if (empty) empty.style.display = 'none';
  },

  hideSkeletons() {
    const sk = document.getElementById('skeleton-container');
    if (sk) {
      sk.classList.add('hidden');
      sk.style.display = 'none';
      sk.innerHTML = '';
    }
  },

  // ─── Selection Management ──────────────────────────────────────────
  toggleSelection(id, type, item, forceState) {
    const shouldSelect = forceState !== undefined ? forceState : !this.selectedItems.has(id);
    if (shouldSelect) {
      this.selectedItems.set(id, { id, type, item });
    } else {
      this.selectedItems.delete(id);
    }

    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.classList.toggle('selected', shouldSelect);
    }

    this.updateActionBar();
  },

  selectAll(itemsList) {
    if (!itemsList || itemsList.length === 0) return;
    itemsList.forEach(item => {
      const type = item.type || (item.mime_type ? 'file' : 'folder');
      this.selectedItems.set(item.id, { id: item.id, type, item });
      const card = document.querySelector(`[data-id="${item.id}"]`);
      if (card) card.classList.add('selected');
    });
    this.updateActionBar();
  },

  clearSelection() {
    this.selectedItems.clear();
    const actionBar = document.getElementById('action-bar');
    if (actionBar) actionBar.style.display = 'none';
    document.querySelectorAll('.file-card, .folder-card').forEach(c => c.classList.remove('selected'));
  },

  updateActionBar() {
    const actionBar = document.getElementById('action-bar');
    const selectedCount = document.getElementById('selected-count');
    if (!actionBar) return;

    const count = this.selectedItems.size;
    if (count === 0) {
      actionBar.style.display = 'none';
      return;
    }

    actionBar.style.display = 'flex';
    if (selectedCount) {
      selectedCount.textContent = `${count} selected`;
    }

    const isTrashView = typeof App !== 'undefined' && App.currentView === 'trash';
    const restoreBtn = document.getElementById('action-restore');
    const permDeleteBtn = document.getElementById('action-permanent-delete');
    const downloadBtn = document.getElementById('action-download');
    const moveBtn = document.getElementById('action-move');
    const starBtn = document.getElementById('action-star');
    const deleteBtn = document.getElementById('action-delete');

    if (isTrashView) {
      if (restoreBtn) restoreBtn.style.display = 'inline-flex';
      if (permDeleteBtn) permDeleteBtn.style.display = 'inline-flex';
      if (deleteBtn) deleteBtn.style.display = 'none';
      if (downloadBtn) downloadBtn.style.display = 'none';
      if (moveBtn) moveBtn.style.display = 'none';
      if (starBtn) starBtn.style.display = 'none';
    } else {
      if (restoreBtn) restoreBtn.style.display = 'none';
      if (permDeleteBtn) permDeleteBtn.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
      if (moveBtn) moveBtn.style.display = 'inline-flex';

      const hasFiles = Array.from(this.selectedItems.values()).some(i => i.type === 'file');
      if (downloadBtn) downloadBtn.style.display = hasFiles ? 'inline-flex' : 'none';
      if (starBtn) starBtn.style.display = hasFiles ? 'inline-flex' : 'none';

      const shareBtn = document.getElementById('action-share');
      if (shareBtn) {
        const selectedFiles = Array.from(this.selectedItems.values()).filter(i => i.type === 'file');
        shareBtn.style.display = (!isTrashView && selectedFiles.length === 1) ? 'inline-flex' : 'none';
      }
    }
  },

  // ─── Formatters ────────────────────────────────────────────────────
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(i >= 3 ? 2 : 1)) + ' ' + sizes[i];
  },

  formatSize(bytes) {
    return this.formatFileSize(bytes);
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    let d = new Date(dateStr);
    if (isNaN(d.getTime()) && typeof dateStr === 'string') {
      d = new Date(dateStr.replace(' ', 'T') + 'Z');
    }
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  },

  formatFullDateTime(dateStr) {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  },

  getFileTypeCategory(mimeType, fileName = '') {
    const mime = (mimeType || '').toLowerCase();
    const ext = (fileName || '').split('.').pop().toLowerCase();

    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif', 'tiff', 'tif', 'avif', 'raw', 'cr2', 'nef', 'arw'].includes(ext)) return 'image';
    if (mime.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', '3g2', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'divx', 'xvid', 'rm', 'rmvb', 'asf', 'f4v', 'mpg', 'mpeg', 'm2v', 'h264', 'h265', 'hevc'].includes(ext)) return 'video';
    if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'alac', 'mid', 'midi', 'amr'].includes(ext)) return 'audio';
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z') || mime.includes('tar') || mime.includes('gzip') || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(ext)) return 'archive';
    if (mime.includes('pdf') || ext === 'pdf') return 'document';
    return 'document';
  },

  getFileIconSvg(mimeType, fileName = '') {
    const cat = this.getFileTypeCategory(mimeType, fileName);
    if (cat === 'image') {
      return `<svg viewBox="0 0 24 24" width="30" height="30" fill="var(--cat-image, #10b981)"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
    }
    if (cat === 'video') {
      return `<svg viewBox="0 0 24 24" width="30" height="30" fill="var(--cat-video, #f43f5e)"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
    }
    if (cat === 'audio') {
      return `<svg viewBox="0 0 24 24" width="30" height="30" fill="var(--cat-audio, #8b5cf6)"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    }
    if (cat === 'archive') {
      return `<svg viewBox="0 0 24 24" width="30" height="30" fill="var(--cat-archive, #f59e0b)"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10v-2h-4v2H8v-4h2v2h4v-2h2v4h-2z"/></svg>`;
    }
    if ((mimeType && mimeType.includes('pdf')) || (fileName && fileName.toLowerCase().endsWith('.pdf'))) {
      return `<svg viewBox="0 0 24 24" width="30" height="30" fill="#ef4444"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v4zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="30" height="30" fill="var(--cat-doc, #0ea5e9)"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
  },

  getProviderBadgeHtml(file) {
    if (!file) return '';
    const mode = file.storage_mode || 'dual';
    if (mode === 'dual') {
      if (file.replication_status === 'completed') {
        return '<span class="provider-badge provider-badge-dual" title="Dual Cloud (Discord + Telegram)">Dual</span>';
      } else if (file.replication_status === 'in_progress' || file.replication_status === 'pending') {
        return '<span class="provider-badge provider-badge-replicating" title="Replicating to secondary cloud">Sync</span>';
      } else if (file.replication_status === 'failed') {
        return '<span class="provider-badge provider-badge-failed" title="Secondary replication failed">Desync</span>';
      }
      return '<span class="provider-badge provider-badge-dual" title="Dual Cloud">Dual</span>';
    } else if (mode === 'discord') {
      return '<span class="provider-badge provider-badge-discord" title="Discord Cloud">Discord</span>';
    } else if (mode === 'telegram') {
      return '<span class="provider-badge provider-badge-telegram" title="Telegram Cloud">TG</span>';
    }
    return '';
  },

  // ─── Render Card HTML (Clean & Robust, No broken inline JS) ───────
  renderFolderCard(folder) {
    const folderIdStr = String(folder.id);
    const safeName = this.escapeHtml(folder.name);
    const isSelected = this.selectedItems.has(folderIdStr) || this.selectedItems.has(folder.id);
    const selectedClass = isSelected ? ' selected' : '';
    const hasLock = Boolean(folder.is_locked);
    const isUnlocked = typeof App !== 'undefined' && App.unlockedFolders && App.unlockedFolders.has(folderIdStr);

    let lockBadge = '';
    let iconFill = 'var(--cat-folder, #3b82f6)';
    if (hasLock) {
      if (isUnlocked) {
        lockBadge = `<span class="folder-lock-badge unlocked" title="Unlocked Folder (Protected by Password)"><svg viewBox="0 0 24 24" width="11" height="11" fill="var(--success-color, #10b981)"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg></span>`;
        iconFill = 'var(--success-color, #10b981)';
      } else {
        lockBadge = `<span class="folder-lock-badge" title="Password Protected Folder (Locked)"><svg viewBox="0 0 24 24" width="11" height="11" fill="var(--danger-color, #ef4444)"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></span>`;
        iconFill = 'var(--danger-color, #ef4444)';
      }
    }

    return `
      <div class="folder-card${selectedClass}${hasLock ? ' is-locked' : ''}${isUnlocked ? ' is-unlocked' : ''}" data-id="${folderIdStr}" data-type="folder" data-locked="${hasLock ? '1' : '0'}" data-unlocked="${isUnlocked ? '1' : '0'}" draggable="true">
        <button class="card-select-btn" title="Select folder" data-id="${folderIdStr}" data-type="folder" aria-label="Select">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        <div class="folder-icon-wrap">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="${iconFill}">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
          ${lockBadge}
        </div>
        <div class="folder-name" title="${safeName}">${safeName}</div>
        <button class="item-more-btn" title="More options" data-id="${folderIdStr}" data-type="folder">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  renderFileCard(file) {
    const fileIdStr = String(file.id);
    const safeName = this.escapeHtml(file.name);
    const safeFileNameAttr = this.escapeAttr(file.name || '');
    const isSelected = this.selectedItems.has(fileIdStr) || this.selectedItems.has(file.id);
    const selectedClass = isSelected ? ' selected' : '';
    const cat = this.getFileTypeCategory(file.mime_type, file.name);
    const icon = this.getFileIconSvg(file.mime_type, file.name);
    const size = this.formatFileSize(file.size);
    const date = this.formatDate(file.created_at);
    const isShared = Boolean(file.is_shared && Number(file.is_shared) !== 0);
    const shareIcon = isShared ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align: -1px; margin-right: 3px; color: var(--accent-color, #0061ff); display: inline-block;" title="Shared link active"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg>' : '';
    const starIcon = file.is_starred ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fbbf24" style="vertical-align: -2px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>' : '';
    const ext = (file.name || '').split('.').pop().toUpperCase();
    const extBadge = (ext && ext.length <= 4) ? `<span class="file-ext-badge cat-${cat}">${this.escapeHtml(ext)}</span>` : '';
    const providerBadge = this.getProviderBadgeHtml(file);

    let previewHtml = '';
    if (cat === 'image') {
      const thumbUrl = API.getThumbnailUrl(file.id);
      previewHtml = `
        <div class="file-card-preview has-thumbnail">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img src="${thumbUrl}" class="file-thumb-media" loading="lazy" width="300" height="200" alt="${safeFileNameAttr}" onload="this.classList.add('loaded')" onerror="this.style.display='none'">
        </div>
      `;
    } else if (cat === 'video') {
      const thumbUrl = API.getThumbnailUrl(file.id);
      const cached = localStorage.getItem(`vthumb_${file.id}`) || sessionStorage.getItem(`vthumb_${file.id}`);
      const hasCached = (cached && typeof cached === 'string' && cached.startsWith('data:image') && cached.length > 500);
      const imgSrc = hasCached ? cached : thumbUrl;
      const loadedClass = hasCached ? ' loaded' : '';
      previewHtml = `
        <div class="file-card-preview has-thumbnail video-preview">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img id="vthumb-${file.id}" class="file-thumb-media${loadedClass}" src="${imgSrc}" loading="lazy" width="300" height="200" alt="${safeFileNameAttr}" onload="this.classList.add('loaded')" onerror="UI.onVideoThumbError(this, '${file.id}')">
          <div class="video-play-badge">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      `;
    } else {
      previewHtml = `
        <div class="file-card-preview cat-bg-${cat}">
          <div class="file-type-icon-lg">${icon}</div>
        </div>
      `;
    }

    return `
      <div class="file-card cat-${cat}${selectedClass}" data-id="${fileIdStr}" data-type="file" draggable="true">
        <button class="card-select-btn" title="Select file" data-id="${fileIdStr}" data-type="file" aria-label="Select">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        ${previewHtml}
        <div class="file-card-info">
          <div class="file-card-title-row">
            <span class="file-name" title="${safeName}">${safeName}</span>
            <span class="file-star">${starIcon}</span>
          </div>
          <div class="file-meta-row">
            <span class="file-size">${extBadge}${providerBadge}${size}</span>
            <span class="file-date">${shareIcon}${date}</span>
          </div>
        </div>
        <button class="item-more-btn" title="More options" data-id="${fileIdStr}" data-type="file">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  // ─── Breadcrumbs ───────────────────────────────────────────────────
  renderBreadcrumbs(breadcrumbs, currentFolder = null) {
    const container = document.getElementById('breadcrumb');
    if (!container) return;

    let relockBtnHtml = '';
    if (currentFolder && Boolean(currentFolder.is_locked)) {
      relockBtnHtml = ` <button type="button" class="btn-relock-folder" id="btn-header-relock" data-folder-id="${currentFolder.id}" title="Lock and exit this folder" style="display:inline-flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg><span>Lock Folder</span></button>`;
    }

    container.innerHTML = breadcrumbs.map((b, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      const safeName = this.escapeHtml(b.name);
      if (isLast) {
        return `<span class="breadcrumb-item active">${safeName}</span>${relockBtnHtml}`;
      }
      return `
        <a class="breadcrumb-item" href="#" data-folder-id="${b.id || ''}">${safeName}</a>
        <span class="breadcrumb-sep">›</span>
      `;
    }).join('');

    // Attach click listeners to breadcrumbs
    container.querySelectorAll('a.breadcrumb-item').forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        const fid = link.getAttribute('data-folder-id') || null;
        App.navigateToFolder(fid);
      };
    });

    const relockBtn = container.querySelector('#btn-header-relock');
    if (relockBtn) {
      relockBtn.onclick = (e) => {
        e.preventDefault();
        const fid = relockBtn.getAttribute('data-folder-id');
        if (fid && typeof App !== 'undefined' && App.relockFolder) {
          App.relockFolder(fid);
        }
      };
    }
  },

  // ─── Folder Tree for Move Modal ────────────────────────────────────
  renderFolderTree(container, tree, onSelect) {
    let html = `
      <div class="tree-item active" data-folder-id="null">
        <span class="tree-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent-color)" style="vertical-align:-2px; margin-right:6px;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
        <span class="tree-label">My Drive (Root)</span>
      </div>
    `;

    const renderNodes = (nodes, depth = 1) => {
      nodes.forEach(node => {
        const padding = depth * 18;
        const safeName = this.escapeHtml(node.name || '');
        html += `
          <div class="tree-item" data-folder-id="${node.id}" style="padding-left: ${padding}px">
            <span class="tree-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent-color)" style="vertical-align:-2px; margin-right:6px;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
            <span class="tree-label">${safeName}</span>
          </div>
        `;
        if (node.children && node.children.length > 0) {
          renderNodes(node.children, depth + 1);
        }
      });
    };

    if (tree && tree.length > 0) {
      renderNodes(tree);
    }

    container.innerHTML = html;

    container.querySelectorAll('.tree-item').forEach(item => {
      item.onclick = () => {
        container.querySelectorAll('.tree-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const rawId = item.getAttribute('data-folder-id');
        const folderId = rawId === 'null' ? null : rawId;
        if (onSelect) onSelect(folderId);
      };
    });

    if (onSelect) onSelect(null);
  },

  // ─── Show Context Menu ─────────────────────────────────────────────
  showContextMenu(event, item) {
    if (!item) return;
    App.selectedItem = item;

    const menu = document.getElementById('context-menu');
    if (!menu) return;

    const isTrashed = App.currentView === 'trash';
    const trashBtn = menu.querySelector('[data-action="trash"]');
    const restoreBtn = menu.querySelector('[data-action="restore"]');
    const permDeleteBtn = menu.querySelector('[data-action="permanent-delete"]');
    const downloadBtn = menu.querySelector('[data-action="download"]');
    const starBtn = menu.querySelector('[data-action="star"]');
    const shareBtn = menu.querySelector('[data-action="share"]');
    const infoBtn = menu.querySelector('[data-action="info"]');
    const backupStatusBtn = menu.querySelector('[data-action="backup-status"]');
    const repTgBtn = menu.querySelector('[data-action="replicate-telegram"]');
    const repDcBtn = menu.querySelector('[data-action="replicate-discord"]');
    const repairBtn = menu.querySelector('[data-action="repair"]');

    if (trashBtn) trashBtn.style.display = isTrashed ? 'none' : 'flex';
    if (restoreBtn) restoreBtn.style.display = isTrashed ? 'flex' : 'none';
    if (permDeleteBtn) permDeleteBtn.style.display = isTrashed ? 'flex' : 'none';
    if (downloadBtn) downloadBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    if (starBtn) starBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    if (shareBtn) shareBtn.style.display = (!isTrashed && item.type === 'file') ? 'flex' : 'none';
    if (infoBtn) {
      infoBtn.style.display = !isTrashed ? 'flex' : 'none';
      const infoSpan = infoBtn.querySelector('span');
      if (infoSpan) {
        infoSpan.textContent = 'Properties';
      }
    }
    if (backupStatusBtn) backupStatusBtn.style.display = (!isTrashed && item.type === 'file') ? 'flex' : 'none';
    if (repTgBtn) repTgBtn.style.display = 'none'; // Replicas managed directly inside Backup & Replicas Status modal
    if (repDcBtn) repDcBtn.style.display = 'none';
    if (repairBtn) repairBtn.style.display = 'none';
    const lockFolderBtn = menu.querySelector('[data-action="lock-folder"]');
    const lockFolderText = document.getElementById('ctx-lock-folder-text');
    const relockFolderBtn = menu.querySelector('[data-action="relock-folder"]');
    if (lockFolderBtn) {
      if (!isTrashed && item.type === 'folder') {
        const isProtected = Boolean(item.is_locked);
        const isUnlocked = typeof App !== 'undefined' && App.unlockedFolders && App.unlockedFolders.has(String(item.id));

        if (isProtected) {
          if (isUnlocked) {
            if (relockFolderBtn) relockFolderBtn.style.display = 'flex';
            lockFolderBtn.style.display = 'flex';
            if (lockFolderText) lockFolderText.textContent = 'Manage / Remove Password';
          } else {
            if (relockFolderBtn) relockFolderBtn.style.display = 'none';
            lockFolderBtn.style.display = 'flex';
            if (lockFolderText) lockFolderText.textContent = 'Unlock Folder';
          }
        } else {
          if (relockFolderBtn) relockFolderBtn.style.display = 'none';
          lockFolderBtn.style.display = 'flex';
          if (lockFolderText) lockFolderText.textContent = 'Lock Folder (Set Password)';
        }
      } else {
        lockFolderBtn.style.display = 'none';
        if (relockFolderBtn) relockFolderBtn.style.display = 'none';
      }
    }

    menu.style.display = 'block';

    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || 220;
    const menuHeight = menuRect.height || 340;
    const padding = 10;

    let x = 0;
    let y = 0;

    const moreBtn = event && event.target ? event.target.closest('.item-more-btn') : null;
    if (moreBtn) {
      const btnRect = moreBtn.getBoundingClientRect();
      // Align with button right edge
      x = btnRect.right - menuWidth;
      // Default to opening below button
      y = btnRect.bottom + 4;

      // If overflows bottom of viewport, flip above the button
      if (y + menuHeight > window.innerHeight - padding) {
        y = btnRect.top - menuHeight - 4;
      }
    } else if (event) {
      const clientX = event.clientX !== undefined ? event.clientX : (event.pageX - (window.scrollX || window.pageXOffset || 0));
      const clientY = event.clientY !== undefined ? event.clientY : (event.pageY - (window.scrollY || window.pageYOffset || 0));

      x = clientX;
      y = clientY;

      if (x + menuWidth > window.innerWidth - padding) {
        x = clientX - menuWidth;
      }
      if (y + menuHeight > window.innerHeight - padding) {
        y = clientY - menuHeight;
      }
    }

    // Keep completely within screen viewport bounds
    if (x < padding) x = padding;
    if (x + menuWidth > window.innerWidth - padding) {
      x = Math.max(padding, window.innerWidth - menuWidth - padding);
    }
    if (y < padding) y = padding;
    if (y + menuHeight > window.innerHeight - padding) {
      y = Math.max(padding, window.innerHeight - menuHeight - padding);
    }

    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
  },

  // ─── Generate Real Video Thumbnails via Canvas (Lazy & Concurrency-Throttled) ───
  _videoObserver: null,
  _thumbnailQueue: [],
  _activeThumbnailWorkers: 0,
  _MAX_THUMBNAIL_WORKERS: 2,
  _isQueuePaused: false,

  pauseThumbnailQueue() {
    this._isQueuePaused = true;
  },

  resumeThumbnailQueue() {
    this._isQueuePaused = false;
    this._processThumbnailQueue();
  },

  isCanvasBlankOrBlack(canvas) {
    try {
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let totalLuminance = 0;
      let brightPixels = 0;
      const totalPixels = canvas.width * canvas.height;
      const step = Math.max(1, Math.floor(totalPixels / 400));
      let sampled = 0;
      for (let i = 0; i < imgData.length; i += step * 4) {
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        const a = imgData[i + 3];
        if (a > 0) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          totalLuminance += lum;
          if (lum > 30) brightPixels++;
          sampled++;
        }
      }
      const avgLuminance = sampled > 0 ? (totalLuminance / sampled) : 0;
      const brightRatio = sampled > 0 ? (brightPixels / sampled) : 0;
      return avgLuminance < 18 && brightRatio < 0.05;
    } catch (e) {
      return false;
    }
  },

  onVideoThumbError(imgEl, fileId) {
    if (!imgEl) return;
    imgEl.style.display = 'none';
    imgEl.removeAttribute('src');
    const file = (typeof App !== 'undefined' && App.filesMap) ? App.filesMap.get(String(fileId)) : null;
    if (file && !this._thumbnailQueue.some(t => t.file && t.file.id === file.id)) {
      this._thumbnailQueue.push({ file, imgEl });
      this._processThumbnailQueue();
    }
  },

  extractVideoThumbnail(blob) {
    return new Promise((resolve) => {
      if (!blob) return resolve(null);
      try {
        const blobUrl = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.setAttribute('muted', '');
        video.preload = 'auto';
        video.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:180px;opacity:0.001;pointer-events:none;z-index:-9999;clip:rect(0,0,0,0);';
        document.body.appendChild(video);

        let done = false;
        let seekAttempts = 0;
        const cleanup = (res = null) => {
          if (done) return;
          done = true;
          try {
            URL.revokeObjectURL(blobUrl);
            video.removeAttribute('src');
            video.load();
            if (video.parentNode) video.parentNode.removeChild(video);
          } catch (e) {}
          resolve(res);
        };

        const tryCapture = () => {
          if (done) return false;
          try {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              const canvas = document.createElement('canvas');
              const targetWidth = Math.min(240, video.videoWidth);
              const targetHeight = Math.round((targetWidth / video.videoWidth) * video.videoHeight);
              canvas.width = targetWidth;
              canvas.height = targetHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

              if (this.isCanvasBlankOrBlack(canvas) && seekAttempts < 3) {
                seekAttempts++;
                try {
                  const jumpTime = seekAttempts === 1 ? Math.min(10.0, (video.duration || 60) * 0.2) : Math.min(30.0, (video.duration || 60) * 0.4);
                  video.currentTime = jumpTime;
                } catch (e) {}
                return false;
              }

              let dataUrl = null;
              try { dataUrl = canvas.toDataURL('image/jpeg', 0.65); } catch (e) {}
              if (dataUrl && dataUrl.length > 300) {
                cleanup(dataUrl);
                return true;
              }
            }
          } catch (e) {}
          return false;
        };

        video.onloadedmetadata = () => {
          try {
            const initialSeek = Math.min(5.0, Math.max(2.0, (video.duration || 60) * 0.1));
            video.currentTime = initialSeek;
          } catch (e) {}
        };

        video.onseeked = () => {
          setTimeout(() => {
            if (tryCapture()) cleanup();
          }, 60);
        };

        video.onerror = () => cleanup(null);
        setTimeout(() => cleanup(null), 6000);

        video.src = blobUrl;
        video.load();
      } catch (e) {
        resolve(null);
      }
    });
  },

  _processThumbnailQueue() {
    if (this._isQueuePaused) return;
    // Purge legacy black thumbnails once
    if (!localStorage.getItem('discorddrive_vthumb_v6_cleared')) {
      try {
        Object.keys(localStorage).forEach(k => {
          if (k.startsWith('vthumb_')) localStorage.removeItem(k);
        });
        localStorage.setItem('discorddrive_vthumb_v6_cleared', '1');
      } catch (e) {}
    }

    while (this._activeThumbnailWorkers < this._MAX_THUMBNAIL_WORKERS && this._thumbnailQueue.length > 0) {
      const task = this._thumbnailQueue.shift();
      this._activeThumbnailWorkers++;

      const { file, imgEl } = task;
      if (!imgEl || !document.body.contains(imgEl) || (imgEl.style.display === 'block' && imgEl.src && imgEl.src.startsWith('data:image'))) {
        this._activeThumbnailWorkers--;
        continue;
      }

      const cached = localStorage.getItem(`vthumb_${file.id}`) || sessionStorage.getItem(`vthumb_${file.id}`);
      if (cached && typeof cached === 'string' && cached.startsWith('data:image') && cached.length > 300) {
        imgEl.src = cached;
        imgEl.style.display = 'block';
        this.syncCachedVideoThumbnail(file.id, cached);
        this._activeThumbnailWorkers--;
        continue;
      }

      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('muted', '');
      // Existing videos are read back from the cloud, unlike a just-uploaded
      // local Blob. Let the browser fetch enough data to reach MP4 metadata.
      video.preload = 'auto';
      video.style.cssText = 'position:fixed;bottom:0;right:0;width:320px;height:180px;opacity:0.001;pointer-events:none;z-index:-9999;clip:rect(0,0,0,0);';
      document.body.appendChild(video);

      let finished = false;
      let seekAttempts = 0;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          video.removeAttribute('src');
          video.load();
          if (video.parentNode) {
            video.parentNode.removeChild(video);
          }
        } catch (e) {}
        this._activeThumbnailWorkers--;
        this._processThumbnailQueue();
      };

      // Remote providers can take longer than a local upload to return the
      // first decodable frame. This is intentionally limited so scrolling a
      // large library never leaves background thumbnail jobs running forever.
      const timeoutId = setTimeout(done, 45000);

      const tryCapture = () => {
        if (finished) return false;
        try {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            const targetWidth = Math.min(240, video.videoWidth);
            const targetHeight = Math.round((targetWidth / video.videoWidth) * video.videoHeight);
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            if (this.isCanvasBlankOrBlack(canvas) && seekAttempts < 3) {
              seekAttempts++;
              try {
                const jumpTime = seekAttempts === 1 ? Math.min(10.0, (video.duration || 60) * 0.2) : Math.min(30.0, (video.duration || 60) * 0.4);
                video.currentTime = jumpTime;
              } catch (e) {}
              return false;
            }

            let dataUrl = null;
            try {
              dataUrl = canvas.toDataURL('image/jpeg', 0.65);
            } catch (e) {
              dataUrl = null;
            }
            
            if (dataUrl && dataUrl.length > 300) {
              if (imgEl && document.body.contains(imgEl)) {
                imgEl.src = dataUrl;
                imgEl.style.display = 'block';
              }
              try {
                localStorage.setItem(`vthumb_${file.id}`, dataUrl);
              } catch(e) {
                try { sessionStorage.setItem(`vthumb_${file.id}`, dataUrl); } catch(e2) {}
              }
              // Upload to server so all devices/sessions get this thumbnail permanently.
              this.syncCachedVideoThumbnail(file.id, dataUrl);
              clearTimeout(timeoutId);
              done();
              return true;
            }
          }
        } catch (e) {}
        return false;
      };

      video.onloadedmetadata = () => {
        try {
          const initialSeek = Math.min(6.0, Math.max(2.0, (video.duration || 60) * 0.1));
          video.currentTime = initialSeek;
        } catch (e) {}
      };

      video.onseeked = () => {
        setTimeout(() => {
          if (tryCapture()) {
            done();
          }
        }, 80);
      };

      video.onerror = () => {
        clearTimeout(timeoutId);
        done();
      };

      video.src = API.getStreamUrl(file.id);
      video.load();
    }
  },

  generateVideoThumbnailFromBlob(blob, fileId, imgEl) {
    if (!blob || !fileId) return;
    this.extractVideoThumbnail(blob).then(dataUrl => {
      if (dataUrl && dataUrl.length > 500) {
        if (imgEl && document.body.contains(imgEl)) {
          imgEl.src = dataUrl;
          imgEl.style.display = 'block';
        }
        try {
          localStorage.setItem(`vthumb_${fileId}`, dataUrl);
        } catch(e) {
          try { sessionStorage.setItem(`vthumb_${fileId}`, dataUrl); } catch(e2) {}
        }
        this.syncCachedVideoThumbnail(fileId, dataUrl);
      }
    }).catch(() => {});
  },

  loadVideoThumbnails(files) {
    if (!files || files.length === 0) return;
    const videoFiles = files.filter(f => this.getFileTypeCategory(f.mime_type, f.name) === 'video');
    if (videoFiles.length === 0) return;

    if (!this._videoObserver && window.IntersectionObserver) {
      this._videoObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const el = entry.target;
            this._videoObserver.unobserve(el);
            const fileId = el.getAttribute('data-vid');
            const file = (typeof App !== 'undefined' && App.filesMap) ? App.filesMap.get(String(fileId)) : null;
            if (file && !this._thumbnailQueue.some(t => t.file && t.file.id === file.id)) {
              this._thumbnailQueue.push({ file, imgEl: el });
              this._processThumbnailQueue();
            }
          }
        });
      }, { rootMargin: '200px' });
    }

    videoFiles.forEach(file => {
      const imgEl = document.getElementById(`vthumb-${file.id}`);
      if (!imgEl) return;

      const cached = localStorage.getItem(`vthumb_${file.id}`) || sessionStorage.getItem(`vthumb_${file.id}`);
      if (cached && typeof cached === 'string' && cached.startsWith('data:image') && cached.length > 500) {
        imgEl.src = cached;
        imgEl.style.display = 'block';
        this.syncCachedVideoThumbnail(file.id, cached);
        return;
      }

      // Check if local Blob exists for instant client-side thumbnail creation
      const localBlob = file.localBlob || (typeof App !== 'undefined' && App.filesMap && App.filesMap.get(String(file.id)) && App.filesMap.get(String(file.id)).localBlob);
      if (localBlob) {
        this.generateVideoThumbnailFromBlob(localBlob, file.id, imgEl);
        return;
      }

      imgEl.setAttribute('data-vid', String(file.id));
      if (this._videoObserver) {
        this._videoObserver.observe(imgEl);
      } else {
        if (!this._thumbnailQueue.some(t => t.file && t.file.id === file.id)) {
          this._thumbnailQueue.push({ file, imgEl });
          this._processThumbnailQueue();
        }
      }
    });
  },

  syncCachedVideoThumbnail(fileId, dataUrl) {
    const syncKey = `vthumb_server_v2_${fileId}`;
    try {
      if (localStorage.getItem(syncKey)) return;
    } catch (e) {}
    if (typeof API === 'undefined' || !API.uploadThumbnail) return;
    API.uploadThumbnail(fileId, dataUrl).then(result => {
      if (result && result.success) {
        try { localStorage.setItem(syncKey, '1'); } catch (e) {}
      }
    }).catch(() => {});
  },

  async copyToClipboard(text, fallbackInputEl = null) {
    if (!text && fallbackInputEl && fallbackInputEl.value) {
      text = fallbackInputEl.value;
    }
    if (!text) return false;

    // 1. Try modern Clipboard API if available and permitted
    if (navigator.clipboard && navigator.clipboard.writeText && (window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        console.warn('navigator.clipboard.writeText failed, falling back to execCommand:', err);
      }
    }

    // 2. Fallback: input element selection or temporary offscreen textarea
    try {
      if (fallbackInputEl && typeof fallbackInputEl.select === 'function') {
        fallbackInputEl.focus();
        fallbackInputEl.select();
        if (fallbackInputEl.setSelectionRange) {
          fallbackInputEl.setSelectionRange(0, 99999);
        }
        const success = document.execCommand('copy');
        if (success) return true;
      }

      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.top = '-9999px';
      textArea.style.left = '-9999px';
      textArea.style.opacity = '0';
      textArea.setAttribute('readonly', '');
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      if (textArea.setSelectionRange) {
        textArea.setSelectionRange(0, 99999);
      }
      const success = document.execCommand('copy');
      document.body.removeChild(textArea);
      return !!success;
    } catch (err) {
      console.error('Clipboard copy fallback failed:', err);
      return false;
    }
  }
};
