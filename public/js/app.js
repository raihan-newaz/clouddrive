/**
 * CloudDrive — Main Application Controller
 */
const App = {
  currentView: 'drive', // 'drive', 'starred', 'recent', 'trash', 'settings'
  currentFolderId: null,
  viewMode: localStorage.getItem('discorddrive_view_mode') || 'grid',
  sortBy: localStorage.getItem('discorddrive_sort_by') || 'name',
  sortOrder: localStorage.getItem('discorddrive_sort_order') || (localStorage.getItem('discorddrive_sort_by') === 'date' ? 'desc' : 'asc'),
  lastSelectedId: null,
  files: [],
  folders: [],
  filesMap: new Map(),
  foldersMap: new Map(),
  breadcrumbs: [],
  selectedItem: null,
  activeFilter: 'all',
  unlockedFolders: (() => {
    const set = new Set();
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('discorddrive_unlocked_')) {
          set.add(key.replace('discorddrive_unlocked_', ''));
        }
      }
    } catch (e) {}
    return set;
  })(),
  pendingUnlockFolder: null,
  isManagingLock: false,
  _navReqCounter: 0,
  filteredFiles: [],
  renderedFileCount: 0,
  _virtualScrollObserver: null,
  _VIRTUAL_PAGE_SIZE: 40,
  _initialized: false,

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    try {
      this.initTheme();
      this.disableBrowserFormHistory();

      // Check setup status with automatic retry for server startup
      let setupStatus = null;
      let retries = 3;
      while (retries > 0) {
        try {
          setupStatus = await API.getSetupStatus();
          break;
        } catch (e) {
          retries--;
          if (retries > 0) {
            await new Promise(r => setTimeout(r, 600));
          } else {
            console.warn('Could not reach setup status endpoint:', e);
          }
        }
      }

      // If backend explicitly confirms setup is incomplete, show wizard
      if (setupStatus && setupStatus.isComplete === false) {
        this.showScreen('setup');
        Setup.init();
        return;
      }

      // Initialize app listeners & UI components with isolated error handling
      const initializers = [
        ['EventListeners', () => this.initEventListeners()],
        ['SortButtons', () => this.updateSortButtonsUI()],
        ['Sidebar', () => this.initSidebar()],
        ['BottomNav', () => this.initBottomNav()],
        ['Search', () => this.initSearch()],
        ['FileContainerEvents', () => this.initFileContainerEvents()],
        ['DragAndDropMove', () => this.initDragAndDropMove()],
        ['ContextMenu', () => this.initContextMenu()],
        ['Modals', () => this.initModals()],
        ['ShareModal', () => this.initShareModal()],
        ['Upload', () => this.initUpload()],
        ['Settings', () => this.initSettings()],
        ['KeyboardShortcuts', () => this.initKeyboardShortcuts()]
      ];

      for (const [name, fn] of initializers) {
        try {
          fn();
        } catch (initErr) {
          console.error(`Error initializing ${name}:`, initErr);
        }
      }

      // HttpOnly cookie is the authentication source; verify it on every load.
      try {
        const authRes = await API.verifyAuth();
        this.user = authRes?.user || null;
        const adminLink = document.getElementById('sidebar-admin-center-link');
        if (adminLink) adminLink.style.display = this.user?.role === 'admin' ? 'flex' : 'none';
        if (authRes?.preferences) {
          this.applyPreferences(authRes.preferences);
        }
        this.showScreen('app');
        await this.loadUserPreferences();
        try {
          const { view: targetView, folderId: targetFolder } = this.parseCurrentUrl();

          if (targetFolder && targetFolder !== 'null') {
            await this.navigateToFolder(targetFolder, true);
          } else if (targetView && targetView !== 'drive') {
            await this.navigateToView(targetView, true);
          } else {
            await this.navigateToFolder(null, true);
          }
          this.loadStorageStats();
        } catch (loadErr) {
          console.warn('Initial load contents warning:', loadErr);
          await this.navigateToFolder(null, true);
        }
      } catch (authErr) {
        this.showScreen('login');
      }
    } catch (e) {
      console.error('App init error:', e);
      this.showScreen('login');
    }
  },

  // Keep private file names and administrative values out of browser form
  // history. Password managers may still offer their own controls by design.
  disableBrowserFormHistory() {
    try {
      localStorage.removeItem('discorddrive_last_email');
      document.querySelectorAll('input:not([type="file"]):not([type="hidden"]), textarea').forEach(input => {
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('data-lpignore', 'true');
        input.setAttribute('data-1password-ignore', 'true');
      });
    } catch (_) { /* Privacy hints are best-effort across browser vendors. */ }
  },

  showScreen(screen) {
    const loaderEl = document.getElementById('app-loader');
    const setupEl = document.getElementById('setup-screen');
    const loginEl = document.getElementById('login-screen');
    const appEl = document.getElementById('app-screen');
    
    if (loaderEl) loaderEl.style.display = 'none';
    
    if (setupEl) {
      setupEl.style.display = screen === 'setup' ? 'flex' : 'none';
      if (screen === 'setup') {
        setupEl.removeAttribute('inert');
        setupEl.removeAttribute('aria-hidden');
        setupEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = false);
      } else {
        setupEl.setAttribute('inert', '');
        setupEl.setAttribute('aria-hidden', 'true');
        setupEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = true);
      }
    }
    
    if (loginEl) {
      loginEl.style.display = screen === 'login' ? 'flex' : 'none';
      if (screen === 'login') {
        loginEl.removeAttribute('inert');
        loginEl.removeAttribute('aria-hidden');
        loginEl.querySelectorAll('input, button').forEach(el => el.disabled = false);
        setTimeout(() => {
          const emailInput = document.getElementById('login-email');
          const pwdInput = document.getElementById('login-password');
          if (emailInput && !emailInput.value) {
            emailInput.focus();
          } else if (pwdInput) {
            pwdInput.focus();
          }
        }, 50);
      } else {
        loginEl.setAttribute('inert', '');
        loginEl.setAttribute('aria-hidden', 'true');
        const pwdInput = document.getElementById('login-password');
        if (pwdInput) {
          pwdInput.value = '';
          pwdInput.blur();
        }
        loginEl.querySelectorAll('input, button').forEach(el => {
          el.blur();
          el.disabled = true;
        });
      }
    }
    
    if (appEl) {
      appEl.style.display = screen === 'app' ? 'flex' : 'none';
      if (screen === 'app') {
        appEl.removeAttribute('inert');
        appEl.removeAttribute('aria-hidden');
        appEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = false);
        this.initRealtimeEvents();
      } else {
        appEl.setAttribute('inert', '');
        appEl.setAttribute('aria-hidden', 'true');
        if (this._eventSource) {
          try { this._eventSource.close(); } catch (e) {}
          this._eventSource = null;
        }
      }
    }
  },

  // ─── View & Navigation ─────────────────────────────────────────────
  parseCurrentUrl() {
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash || '';

    if (pathname === '/trash' || urlParams.get('view') === 'trash' || hash === '#view=trash' || hash === '#trash') {
      const folderParam = urlParams.get('folder');
      return { view: 'trash', folderId: (folderParam && folderParam !== 'null' && folderParam !== 'root') ? folderParam : null };
    }
    if (pathname === '/starred' || urlParams.get('view') === 'starred' || hash === '#view=starred' || hash === '#starred') {
      return { view: 'starred', folderId: null };
    }
    if (pathname === '/recent' || urlParams.get('view') === 'recent' || hash === '#view=recent' || hash === '#recent') {
      return { view: 'recent', folderId: null };
    }
    if (pathname === '/settings' || urlParams.get('view') === 'settings' || hash === '#view=settings' || hash === '#settings') {
      return { view: 'settings', folderId: null };
    }
    if (pathname === '/admin-center' || urlParams.get('view') === 'admin-center' || hash === '#admin-center') {
      return { view: 'admin-center', folderId: null };
    }
    if (pathname === '/storage' || urlParams.get('view') === 'storage' || hash === '#view=storage' || hash === '#storage') {
      return { view: 'storage', folderId: null };
    }
    if (pathname.startsWith('/folder/')) {
      const fid = pathname.substring('/folder/'.length);
      return { view: 'drive', folderId: fid || null };
    }

    const folderParam = urlParams.get('folder');
    if (folderParam && folderParam !== 'null' && folderParam !== 'root') {
      return { view: 'drive', folderId: folderParam };
    }

    return { view: 'drive', folderId: null };
  },

  async navigateToFolder(folderId, updateUrl = true) {
    const fid = (folderId && folderId !== 'null') ? String(folderId) : null;
    if (this.currentView === 'trash') {
      this.currentFolderId = fid;
      UI.clearSelection();
      if (updateUrl) {
        try {
          const targetPath = fid ? `/trash?folder=${encodeURIComponent(fid)}` : '/trash';
          if (window.location.pathname + window.location.search !== targetPath) {
            window.history.pushState({ folderId: fid, view: 'trash' }, '', targetPath);
          }
        } catch (e) {}
      }
      await this.loadTrashedFiles(fid);
      return;
    }

    if (fid) {
      const folder = this.foldersMap.get(fid);
      if (folder && folder.is_locked && !this.unlockedFolders.has(fid)) {
        this.openUnlockFolderModal(folder, false);
        return;
      }
    }
    this.currentView = 'drive';
    this.currentFolderId = fid;
    this.updateSidebarActive('drive');
    UI.clearSelection();

    if (fid) {
      sessionStorage.setItem('discorddrive_current_folder', fid);
    } else {
      sessionStorage.removeItem('discorddrive_current_folder');
    }
    sessionStorage.setItem('discorddrive_current_view', 'drive');

    if (updateUrl) {
      try {
        const targetPath = fid ? `/folder/${encodeURIComponent(fid)}` : '/';
        if (window.location.pathname !== targetPath || window.location.search || window.location.hash) {
          window.history.pushState({ folderId: fid, view: 'drive' }, '', targetPath);
        }
      } catch (e) {}
    }

    await this.loadFolderContents(fid);
  },

  async navigateToView(view, updateUrl = true) {
    this.currentView = view;
    if (view !== 'admin-center') {
      document.querySelectorAll('.content > *').forEach(el => { if (el.id !== 'admin-center-page') el.style.display = ''; });
      const adminPage = document.getElementById('admin-center-page'); if (adminPage) adminPage.style.display = 'none';
    }
    UI.clearSelection();
    this.updateSidebarActive(view);

    sessionStorage.setItem('discorddrive_current_view', view);
    if (view !== 'drive') {
      sessionStorage.removeItem('discorddrive_current_folder');
    }

    if (updateUrl) {
      try {
        const targetPath = (view === 'drive') ? '/' : `/${view}`;
        if (window.location.pathname !== targetPath || window.location.search || window.location.hash) {
          window.history.pushState({ view }, '', targetPath);
        }
      } catch (e) {}
    }

    switch (view) {
      case 'drive':
        await this.navigateToFolder(null, false);
        break;
      case 'starred':
        await this.loadStarredFiles();
        break;
      case 'recent':
        await this.loadRecentFiles();
        break;
      case 'trash':
        await this.loadTrashedFiles(null);
        break;
      case 'storage':
        await this.openStorageAnalyticsModal();
        break;
      case 'settings':
        this.openSettings();
        break;
      case 'admin-center':
        if (this.user?.role !== 'admin') return this.navigateToView('drive');
        await this.showAdminCenterPage();
        break;
    }
  },

  async openAdminControl(tab = 'account') {
    if (this.user?.role !== 'admin') {
      UI.showToast('Administrator privileges required', 'warning');
      return;
    }
    const paneId = `pane-${tab}`;
    if (document.getElementById('admin-settings-host')) {
      await this.navigateToView('admin-center');
      document.getElementById(paneId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    await this.openSettings();
    document.querySelector(`.settings-tab-btn[data-tab="${tab}"]`)?.click();
  },

  mountAdminSettings() {
    const host = document.getElementById('admin-settings-host');
    if (!host || this.user?.role !== 'admin') return;
    const adminPaneIds = ['pane-users', 'pane-security', 'pane-discord', 'pane-telegram', 'pane-backup', 'pane-webdav'];
    adminPaneIds.forEach(id => {
      const pane = document.getElementById(id);
      if (!pane) return;
      if (pane.parentElement !== host) host.appendChild(pane);
      pane.style.display = 'flex';
    });
    ['tab-users-nav', 'tab-discord-nav', 'tab-telegram-nav'].forEach(id => {
      const tab = document.getElementById(id);
      if (tab) tab.style.display = 'none';
    });
    ['security', 'backup', 'webdav'].forEach(tabName => {
      const tab = document.querySelector(`.settings-tab-btn[data-tab="${tabName}"]`);
      if (tab) tab.style.display = 'none';
    });
  },

  async showAdminCenterPage() {
    document.querySelectorAll('.content > *').forEach(el => { if (el.id !== 'admin-center-page') el.style.display = 'none'; });
    const page = document.getElementById('admin-center-page'); if (page) page.style.display = 'block';
    this.mountAdminSettings();
    const renderAudit = async () => {
      const auditEl = document.getElementById('admin-center-audit');
      const totalEl = document.getElementById('admin-audit-total');
      if (!auditEl) return;
      const query = new URLSearchParams({ limit: '100' });
      const filters = { search: 'admin-audit-search', user: 'admin-audit-user', file: 'admin-audit-file', ip: 'admin-audit-ip', action: 'admin-audit-action' };
      Object.entries(filters).forEach(([key, id]) => {
        const value = document.getElementById(id)?.value?.trim();
        if (value) query.set(key, value);
      });
      auditEl.innerHTML = '<span class="hint">Loading activity…</span>';
      try {
        const data = await API.request('GET', `/api/admin/audit-logs?${query}`);
        const rows = Array.isArray(data) ? data : (data.logs || data.auditLogs || []);
        if (totalEl) totalEl.textContent = `${data.total ?? rows.length} events`;
        auditEl.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>User</th><th>File / request</th><th>Action</th><th>IP</th><th>Browser / client</th><th>Time</th><th></th></tr></thead><tbody>${rows.map(entry => {
          let details = {}; try { details = JSON.parse(entry.details || '{}') || {}; } catch (_) { details = { value: entry.details }; }
          const file = details.fileName || details.fileId || details.path || details.value || '—';
          const ip = entry.ip_address || '';
          return `<tr><td>${UI.escapeHtml(entry.user_email || 'Anonymous')}</td><td title="${UI.escapeHtml(String(file))}">${UI.escapeHtml(String(file))}</td><td><span class="admin-action-pill" title="${UI.escapeHtml(entry.action || '')}">${UI.escapeHtml(entry.action || '—')}</span></td><td class="admin-ip-text">${UI.escapeHtml(ip || '—')}</td><td class="admin-table-client" title="${UI.escapeHtml(entry.user_agent || '')}">${UI.escapeHtml(entry.user_agent || '—')}</td><td class="admin-table-time">${UI.escapeHtml(entry.created_at || '')}</td><td>${ip ? `<button class="btn-secondary btn-sm admin-block-event-ip" data-ip="${UI.escapeHtml(ip)}">Block</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table>` : '<span class="hint">No activity matches these filters.</span>';
        auditEl.querySelectorAll('.admin-block-event-ip').forEach(button => {
          button.onclick = () => { const input = document.getElementById('admin-block-ip'); if (input) { input.value = button.dataset.ip; input.focus(); } };
        });
      } catch (error) {
        if (totalEl) totalEl.textContent = 'Unavailable';
        auditEl.innerHTML = `<span class="hint">Unable to load activity: ${UI.escapeHtml(error.message || 'Request failed')}</span>`;
      }
    };
    const renderBlockedIps = async () => {
      const list = document.getElementById('admin-blocked-ips');
      if (!list) return;
      try {
        const data = await API.request('GET', '/api/admin/blocked-ips');
        const ips = data.blockedIps || [];
        list.innerHTML = ips.length ? ips.map(item => `<div class="admin-blocked-row"><div><strong>${UI.escapeHtml(item.ip_address)}</strong><small>${UI.escapeHtml(item.reason || 'No reason recorded')} · ${UI.escapeHtml(item.created_at || '')}</small></div><button class="btn-secondary btn-sm admin-unblock-ip" data-ip="${UI.escapeHtml(item.ip_address)}">Unblock</button></div>`).join('') : '<span class="hint">No IP addresses are blocked.</span>';
        list.querySelectorAll('.admin-unblock-ip').forEach(button => button.onclick = async () => {
          try { await API.request('DELETE', `/api/admin/blocked-ips/${encodeURIComponent(button.dataset.ip)}`); UI.showToast(`${button.dataset.ip} unblocked`, 'success'); await Promise.all([renderBlockedIps(), renderDashboard()]); }
          catch (error) { UI.showToast(error.message || 'Unable to unblock IP', 'error'); }
        });
      } catch (error) { list.innerHTML = `<span class="hint">Unable to load blocked IPs: ${UI.escapeHtml(error.message || 'Request failed')}</span>`; }
    };
    const renderDashboard = async () => {
      try {
        const data = await API.getAdminStats();
        const stats = data.stats || data;
        const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
        setText('admin-stat-users', stats.activeUsers ?? '—');
        setText('admin-stat-users-detail', `${stats.users ?? 0} total accounts`);
        setText('admin-stat-files', stats.files ?? '—');
        setText('admin-stat-storage', UI.formatFileSize(stats.storageUsed || 0));
        setText('admin-stat-events', stats.securityEvents ?? '—');
        setText('admin-stat-blocked', stats.blockedIps ?? '—');
      } catch (_) { ['admin-stat-users', 'admin-stat-files', 'admin-stat-events', 'admin-stat-blocked'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; }); }
    };
    const renderOperations = async () => {
      try {
        const [maintenance, notificationData, sessionData] = await Promise.all([API.request('GET', '/api/admin/maintenance'), API.request('GET', '/api/admin/notification-settings'), API.request('GET', '/api/admin/sessions')]);
        const maintenanceToggle = document.getElementById('admin-maintenance-mode'); if (maintenanceToggle) maintenanceToggle.checked = Boolean(maintenance.enabled);
        const settings = notificationData.settings || {};
        [['admin-alerts-enabled', 'enabled'], ['admin-alert-telegram', 'telegram'], ['admin-alert-discord', 'discord'], ['admin-alert-email', 'email']].forEach(([id, key]) => { const element = document.getElementById(id); if (element) element.checked = Boolean(settings[key]); });
        const emailTo = document.getElementById('admin-alert-email-to'); if (emailTo) emailTo.value = settings.emailTo || '';
        const status = document.getElementById('admin-notification-status'); if (status) status.textContent = `Configured: Telegram ${settings.telegramConfigured ? '✓' : '—'}, Discord ${settings.discordConfigured ? '✓' : '—'}, Email ${settings.emailConfigured ? '✓' : '—'}. SMTP credentials stay server-side.`;
        const deviceList = document.getElementById('admin-device-sessions'); const sessions = sessionData.sessions || [];
        if (deviceList) {
          deviceList.innerHTML = sessions.length ? sessions.map(session => `<div class="admin-blocked-row"><div><strong>${UI.escapeHtml(session.clientName || session.type || 'Device')}${session.isCurrent ? ' (this browser)' : ''}</strong><small>${UI.escapeHtml(session.username || 'Unknown user')} · ${UI.escapeHtml(session.ip || '—')} · ${UI.escapeHtml(session.status || 'idle')}</small></div>${!session.revoked ? `<button class="btn-secondary btn-sm admin-revoke-session" data-session-id="${UI.escapeHtml(session.id)}">Revoke</button>` : ''}</div>`).join('') : '<span class="hint">No active device sessions recorded yet.</span>';
          deviceList.querySelectorAll('.admin-revoke-session').forEach(button => button.onclick = async () => { try { await API.request('POST', `/api/admin/sessions/${encodeURIComponent(button.dataset.sessionId)}/revoke`); UI.showToast('Device session revoked', 'success'); await renderOperations(); } catch (error) { UI.showToast(error.message || 'Unable to revoke session', 'error'); } });
        }
      } catch (error) { const status = document.getElementById('admin-notification-status'); if (status) status.textContent = `Operational controls unavailable: ${error.message || 'request failed'}`; }
    };
    const setWorkspace = workspace => {
      document.querySelectorAll('[data-admin-workspace]').forEach(button => button.classList.toggle('active', button.dataset.adminWorkspace === workspace));
      document.querySelectorAll('[data-admin-workspace-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.adminWorkspacePanel === workspace));
      document.getElementById('admin-center-page')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    document.querySelectorAll('[data-admin-workspace]').forEach(button => { button.onclick = () => setWorkspace(button.dataset.adminWorkspace); });
    document.querySelectorAll('[data-admin-workspace-target]').forEach(button => { button.onclick = () => setWorkspace(button.dataset.adminWorkspaceTarget); });
    const usersButton = document.getElementById('admin-open-users');
    const securityButton = document.getElementById('admin-open-security');
    const settingsButton = document.getElementById('admin-open-settings');
    if (usersButton) usersButton.onclick = () => { setWorkspace('settings'); document.getElementById('pane-users')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    if (securityButton) securityButton.onclick = () => { setWorkspace('settings'); document.getElementById('pane-security')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    if (settingsButton) settingsButton.onclick = () => { setWorkspace('settings'); document.getElementById('pane-discord')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    document.getElementById('admin-refresh-dashboard')?.addEventListener('click', () => Promise.all([renderDashboard(), renderAudit(), renderBlockedIps(), renderOperations()]));
    document.getElementById('admin-refresh-ui-cache')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        const result = await API.request('POST', '/api/admin/refresh-ui-cache');
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(key => caches.delete(key)));
        }
        UI.showToast(result.message || 'Site cache cleared. Reloading…', 'success');
        window.setTimeout(() => window.location.replace(`${window.location.pathname}?refresh=${result.revision || Date.now()}`), 500);
      } catch (error) {
        UI.showToast(error.message || 'Unable to refresh site cache', 'error');
        button.disabled = false;
      }
    });
    document.getElementById('admin-maintenance-mode')?.addEventListener('change', async event => {
      try { await API.request('PUT', '/api/admin/maintenance', { enabled: event.target.checked }); UI.showToast(event.target.checked ? 'Maintenance mode enabled' : 'Maintenance mode disabled', 'success'); }
      catch (error) { event.target.checked = !event.target.checked; UI.showToast(error.message || 'Unable to update maintenance mode', 'error'); }
    });
    document.getElementById('admin-notification-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      try { await API.request('PUT', '/api/admin/notification-settings', { enabled: document.getElementById('admin-alerts-enabled').checked, telegram: document.getElementById('admin-alert-telegram').checked, discord: document.getElementById('admin-alert-discord').checked, email: document.getElementById('admin-alert-email').checked, emailTo: document.getElementById('admin-alert-email-to').value.trim() }); UI.showToast('Alert settings saved', 'success'); await renderOperations(); }
      catch (error) { UI.showToast(error.message || 'Unable to save alert settings', 'error'); }
    });
    document.getElementById('admin-test-alert')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        const channel = document.getElementById('admin-test-alert-channel')?.value || 'telegram';
        const result = await API.request('POST', '/api/admin/notification-settings/test', { channel });
        UI.showToast(result.message || 'One test alert sent', 'success');
      } catch (error) {
        UI.showToast(error.message || 'Unable to send test alert', 'error');
      } finally {
        window.setTimeout(() => { button.disabled = false; }, 1500);
      }
    });
    ['admin-audit-search', 'admin-audit-user', 'admin-audit-file', 'admin-audit-ip'].forEach(id => document.getElementById(id)?.addEventListener('input', renderAudit));
    document.getElementById('admin-audit-action')?.addEventListener('change', renderAudit);
    const blockForm = document.getElementById('admin-block-ip-form');
    if (blockForm) blockForm.onsubmit = async event => {
      event.preventDefault();
      const ip = document.getElementById('admin-block-ip')?.value.trim();
      const reason = document.getElementById('admin-block-reason')?.value.trim() || '';
      if (!ip) return;
      try {
        await API.request('POST', '/api/admin/blocked-ips', { ip, reason });
        UI.showToast(`${ip} blocked`, 'success');
        blockForm.reset();
        await Promise.all([renderBlockedIps(), renderDashboard(), renderAudit()]);
      } catch (error) { UI.showToast(error.message || 'Unable to block IP', 'error'); }
    };
    document.querySelectorAll('[data-admin-section]').forEach(button => {
      button.onclick = () => { setWorkspace('settings'); document.getElementById(button.dataset.adminSection)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    });
    await Promise.all([renderDashboard(), renderAudit(), renderBlockedIps(), renderOperations(), this.loadAdminUsers(), this.loadSettings(), this.loadBackupStatus(), this.loadWebDavSettings()]);
  },

  _storageStatsTimer: null,
  loadStorageStats(immediate = false) {
    if (immediate) {
      if (this._storageStatsTimer) clearTimeout(this._storageStatsTimer);
      this._doLoadStorageStats();
      return;
    }
    if (this._storageStatsTimer) clearTimeout(this._storageStatsTimer);
    this._storageStatsTimer = setTimeout(() => {
      this._doLoadStorageStats();
    }, 400);
  },

  async _doLoadStorageStats() {
    try {
      const res = await API.getStorageStats();
      const s = (res && res.stats) ? res.stats : res;
      if (!s) return;

      // 1. Left Sidebar Storage Card
      const storageText = document.getElementById('storage-text');
      const storageSubtext = document.getElementById('storage-subtext');
      const storageFill = document.getElementById('storage-fill');

      const usedBytes = s.storageUsed !== undefined ? s.storageUsed : (s.activeFilesSize !== undefined ? s.activeFilesSize : (s.totalBytes || 0));
      const usedFormatted = UI.formatFileSize(usedBytes);
      const fileCount = s.activeFileCount !== undefined ? s.activeFileCount : (s.totalFiles || s.fileCount || 0);

      if (storageText) {
        storageText.textContent = `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${usedFormatted}`;
      }

      const tgBytes = (s.telegram && s.telegram.bytes !== undefined) ? s.telegram.bytes : (s.telegramBytes || 0);
      const dcBytes = (s.discord && s.discord.bytes !== undefined) ? s.discord.bytes : (s.discordBytes || 0);
      const providerUsageHtml = `<span class="storage-provider storage-provider-telegram" title="Telegram storage"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.2 18.5 20c-.24 1.18-.88 1.47-1.78.92l-4.92-3.63-2.37 2.28c-.26.26-.48.48-.98.48l.35-4.98 9.06-8.19c.39-.35-.09-.55-.61-.2L6.05 13.73 1.23 12.22c-1.05-.33-1.07-1.05.22-1.56L20.3 3.4c.87-.32 1.63.2 1.4 1.82Z"/></svg>${UI.formatFileSize(tgBytes)}</span><span class="storage-provider-divider" aria-hidden="true">·</span><span class="storage-provider storage-provider-discord" title="Discord storage"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 4.6A16.3 16.3 0 0 0 15.7 3l-.47.94a14.8 14.8 0 0 0-4.46 0L10.3 3A16.5 16.5 0 0 0 6.5 4.6C4.1 8.2 3.45 11.7 3.78 15.15a15.3 15.3 0 0 0 4.66 2.35l1.13-1.55a9.8 9.8 0 0 1-1.77-.85l.42-.33c3.42 1.57 7.13 1.57 10.5 0l.42.33c-.57.34-1.16.62-1.77.85l1.13 1.55a15.3 15.3 0 0 0 4.66-2.35c.39-4-.67-7.47-3.66-10.55ZM8.72 13.04c-1.03 0-1.87-.95-1.87-2.12s.82-2.12 1.87-2.12c1.05 0 1.89.95 1.87 2.12 0 1.17-.82 2.12-1.87 2.12Zm6.56 0c-1.03 0-1.87-.95-1.87-2.12s.82-2.12 1.87-2.12c1.05 0 1.89.95 1.87 2.12 0 1.17-.82 2.12-1.87 2.12Z"/></svg>${UI.formatFileSize(dcBytes)}</span>`;

      if (s.storageLimit > 0) {
        const quotaFormatted = UI.formatFileSize(s.storageLimit);
        const pct = s.usagePercentage !== undefined ? s.usagePercentage : Math.min(100, Math.round((usedBytes / s.storageLimit) * 100));
        if (storageSubtext) {
          if (tgBytes > 0 || dcBytes > 0) {
            storageSubtext.innerHTML = providerUsageHtml;
          } else {
            storageSubtext.textContent = `${pct}% of ${quotaFormatted} used`;
          }
        }
        if (storageFill) {
          storageFill.style.width = `${Math.min(100, Math.max(4, pct))}%`;
          if (pct >= 95) storageFill.style.background = '#ea4335';
          else if (pct >= 80) storageFill.style.background = '#fbbc05';
          else storageFill.style.background = 'var(--accent-color)';
        }
      } else {
        if (storageSubtext) {
          if (tgBytes > 0 || dcBytes > 0) {
            storageSubtext.innerHTML = providerUsageHtml;
          } else {
            storageSubtext.textContent = 'Unlimited Free Storage';
          }
        }
        if (storageFill) {
          storageFill.style.width = fileCount > 0 ? '100%' : '0%';
          storageFill.style.background = 'var(--accent-color)';
        }
      }

      // 2. Settings Modal Storage Elements
      const filesEl = document.getElementById('settings-storage-files');
      const foldersEl = document.getElementById('settings-storage-folders');
      const bytesEl = document.getElementById('settings-storage-bytes');
      const chunksTotalEl = document.getElementById('settings-storage-chunks-total');
      const dualSyncEl = document.getElementById('settings-dual-sync-text');
      const syncHintEl = document.getElementById('settings-sync-status-hint');

      if (filesEl) filesEl.textContent = `${(s.totalFiles || fileCount || 0).toLocaleString()} Files`;
      if (foldersEl) foldersEl.textContent = `${(s.totalFolders || s.folderCount || 0).toLocaleString()} Folders`;
      if (bytesEl) bytesEl.textContent = UI.formatFileSize(s.totalBytes || usedBytes || 0);
      if (chunksTotalEl) chunksTotalEl.textContent = `${(s.totalChunks || 0).toLocaleString()} Total Chunks`;

      if (dualSyncEl) {
        const total = s.totalFiles || fileCount || 0;
        const dual = s.dualFiles || 0;
        const pct = total > 0 ? ((dual / total) * 100).toFixed(1) : '100.0';
        dualSyncEl.textContent = `${dual} / ${total} (${pct}%)`;
        if (syncHintEl) {
          syncHintEl.textContent = (dual >= total && total > 0) ? '100% Dual Cloud Synchronized' : (total === 0 ? 'No files yet' : `${total - dual} files pending sync`);
        }
      }

      const discFiles = document.getElementById('discord-stats-files');
      const discChunks = document.getElementById('discord-stats-chunks');
      const discBytes = document.getElementById('discord-stats-bytes');
      if (discFiles) discFiles.textContent = `${s.discord?.files || 0} Files`;
      if (discChunks) discChunks.textContent = `${s.discord?.chunks || 0} Chunks`;
      if (discBytes) discBytes.textContent = UI.formatFileSize(s.discord?.bytes || 0);

      const tgFiles = document.getElementById('telegram-stats-files');
      const tgChunks = document.getElementById('telegram-stats-chunks');
      const tgBytesEl = document.getElementById('telegram-stats-bytes');
      if (tgFiles) tgFiles.textContent = `${s.telegram?.files || 0} Files`;
      if (tgChunks) tgChunks.textContent = `${s.telegram?.chunks || 0} Chunks`;
      if (tgBytesEl) tgBytesEl.textContent = UI.formatFileSize(s.telegram?.bytes || 0);
    } catch (e) {
      console.warn('[App] Could not update storage stats:', e);
    }
  },

  async openStorageAnalyticsModal() {
    try {
      UI.showModal('storage-analytics-modal');

      const catList = document.getElementById('storage-categories-list');
      if (catList) {
        catList.innerHTML = '<div style="grid-column: 1 / -1; padding: 14px; text-align: center; color: var(--text-secondary); font-size: 12.5px;">Loading storage breakdown...</div>';
      }

      const largestContainer = document.getElementById('storage-largest-files');
      if (largestContainer) {
        largestContainer.innerHTML = '<div style="padding: 14px; text-align: center; color: var(--text-secondary); font-size: 12.5px;">Loading largest files...</div>';
      }

      const [statsRes, breakdownRes, largestRes] = await Promise.all([
        API.getStorageStats().catch(() => null),
        API.getStorageBreakdown().catch(() => null),
        API.getLargestFiles(10).catch(() => null)
      ]);

      if (statsRes && statsRes.stats) {
        const s = statsRes.stats;
        const usedEl = document.getElementById('storage-modal-used-text');
        const quotaEl = document.getElementById('storage-modal-quota-text');
        const barEl = document.getElementById('storage-modal-bar');
        const percEl = document.getElementById('storage-modal-percentage');
        const freeEl = document.getElementById('storage-modal-free');
        const warnBanner = document.getElementById('storage-warning-banner');
        const warnText = document.getElementById('storage-warning-text');

        if (usedEl) usedEl.textContent = `${UI.formatFileSize(s.storageUsed || s.totalBytes || 0)} used`;
        if (quotaEl) quotaEl.textContent = s.storageLimit > 0 ? `of ${UI.formatFileSize(s.storageLimit)} limit` : 'of Unlimited quota';

        if (s.storageLimit > 0) {
          if (barEl) {
            barEl.style.width = `${s.usagePercentage || 0}%`;
            if (s.usagePercentage >= 95) barEl.style.background = '#ea4335';
            else if (s.usagePercentage >= 80) barEl.style.background = '#fbbc05';
            else barEl.style.background = 'var(--accent-color)';
          }
          if (percEl) percEl.textContent = `${s.usagePercentage || 0}% used`;
          if (freeEl) freeEl.textContent = `${UI.formatFileSize(s.freeStorage || 0)} remaining`;

          if (s.warningLevel && warnBanner) {
            warnBanner.style.display = 'block';
            if (s.warningLevel === '100') warnText.innerHTML = `${UI.icon('warning', 16)} Storage is 100% full! Free up space to upload more files.`;
            else if (s.warningLevel === '95') warnText.innerHTML = `${UI.icon('warning', 16)} Only 5% storage remaining. Storage almost full!`;
            else if (s.warningLevel === '90') warnText.innerHTML = `${UI.icon('warning', 16)} You are using 90% of your storage quota.`;
            else if (s.warningLevel === '80') warnText.textContent = 'ℹ️ You are using 80% of your storage quota.';
          } else if (warnBanner) {
            warnBanner.style.display = 'none';
          }
        } else {
          if (barEl) {
            barEl.style.width = (s.totalFiles || s.activeFileCount) > 0 ? '100%' : '0%';
            barEl.style.background = 'var(--accent-color)';
          }
          if (percEl) percEl.textContent = `${s.activeFileCount || s.totalFiles || 0} active files`;
          if (freeEl) freeEl.textContent = 'Unlimited Free';
          if (warnBanner) warnBanner.style.display = 'none';
        }

        // Multi-Cloud Provider details in modal
        const tgBytesModal = document.getElementById('storage-modal-tg-bytes');
        const tgDetailsModal = document.getElementById('storage-modal-tg-details');
        const dcBytesModal = document.getElementById('storage-modal-dc-bytes');
        const dcDetailsModal = document.getElementById('storage-modal-dc-details');

        if (tgBytesModal) tgBytesModal.textContent = UI.formatFileSize(s.telegram?.bytes || 0);
        if (tgDetailsModal) tgDetailsModal.textContent = `${s.telegram?.files || 0} files • ${s.telegram?.chunks || 0} chunks`;
        if (dcBytesModal) dcBytesModal.textContent = UI.formatFileSize(s.discord?.bytes || 0);
        if (dcDetailsModal) dcDetailsModal.textContent = `${s.discord?.files || 0} files • ${s.discord?.chunks || 0} chunks`;
      }

      // Render Categories Breakdown
      if (catList && breakdownRes && breakdownRes.breakdown) {
        catList.innerHTML = '';
        const b = breakdownRes.breakdown;
        const iconMap = {
          video: 'video',
          image: 'image',
          document: 'file',
          audio: 'audio',
          archive: 'archive',
          other: 'folder'
        };

        for (const [key, item] of Object.entries(b)) {
          const card = document.createElement('div');
          card.style.cssText = 'background: var(--bg-hover); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; gap: 8px;';
          card.innerHTML = `
            <span style="color: var(--accent-color); display: inline-flex;">${UI.icon(iconMap[key] || 'folder', 20)}</span>
            <div style="min-width: 0;">
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${item.label}</div>
              <div style="font-size: 11.5px; color: var(--text-secondary);">${UI.formatFileSize(item.size || 0)} (${item.count || 0})</div>
            </div>
          `;
          catList.appendChild(card);
        }
      } else if (catList) {
        catList.innerHTML = '<div style="grid-column: 1 / -1; padding: 14px; text-align: center; color: var(--text-secondary); font-size: 12.5px;">Could not load storage breakdown. Please try again.</div>';
      }

      // Render Largest Files
      if (largestContainer) {
        if (largestRes && Array.isArray(largestRes.files) && largestRes.files.length > 0) {
          largestContainer.innerHTML = '';
          largestRes.files.forEach((f, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border-color); font-size: 13px; cursor: pointer;';
            row.innerHTML = `
              <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                <span style="color: var(--text-secondary); font-size: 12px; width: 18px;">${idx + 1}.</span>
                <span style="font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.name}</span>
              </div>
              <span style="font-weight: 600; color: var(--text-secondary); font-size: 12px; margin-left: 12px; white-space: nowrap;">${UI.formatFileSize(f.size || 0)}</span>
            `;
            row.onclick = () => {
              UI.hideAllModals();
              if (f.folder_id) {
                App.navigateToFolder(f.folder_id);
              } else {
                App.navigateToFolder(null);
              }
            };
            largestContainer.appendChild(row);
          });
        } else {
          largestContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 13px;">No files yet.</div>';
        }
      }
    } catch (err) {
      console.error('[App] Error opening storage analytics:', err);
    }
  },

  updateSidebarActive(view) {
    document.querySelectorAll('.sidebar-nav .nav-item, .bottom-nav-item').forEach(el => {
      if (el.getAttribute('data-view') === view) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  },

  async loadFolderContents(folderId, options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      const data = await API.getFolderContents(folderId);
      if (reqId !== this._navReqCounter) return;
      if (data.currentFolder && Boolean(data.currentFolder.is_locked) && !this.unlockedFolders.has(String(data.currentFolder.id))) {
        this.openUnlockFolderModal(data.currentFolder, false);
        return;
      }
      this.folders = data.folders || [];
      this.files = data.files || [];
      this.breadcrumbs = data.breadcrumbs || [{ id: null, name: 'My Drive' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs, data.currentFolder);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load files: ' + e.message, 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadStarredFiles(options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      this.folders = [];
      const res = await API.getFiles({ starred: true });
      if (reqId !== this._navReqCounter) return;
      this.files = Array.isArray(res) ? res : [];
      this.breadcrumbs = [{ id: null, name: 'Starred' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load starred files', 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadRecentFiles(options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      this.folders = [];
      const res = await API.getFiles();
      if (reqId !== this._navReqCounter) return;
      this.files = Array.isArray(res) ? res : [];
      this.breadcrumbs = [{ id: null, name: 'Recent Files' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load recent files', 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadTrashedFiles(folderId = null, options = {}) {
    if (folderId && typeof folderId === 'object' && !Array.isArray(folderId)) {
      options = folderId;
      folderId = options.folderId || this.currentFolderId || null;
    }
    const fid = (folderId && folderId !== 'null' && folderId !== 'root') ? String(folderId) : null;
    this.currentFolderId = fid;
    this.currentView = 'trash';
    this.updateSidebarActive('trash');

    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      const data = await API.getFolderContents(fid, '', true);
      if (reqId !== this._navReqCounter) return;
      this.folders = data.folders || [];
      this.files = data.files || [];
      this.breadcrumbs = data.breadcrumbs || [{ id: null, name: 'Trash' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs, data.currentFolder);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load trash: ' + (e.message || 'Unknown error'), 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  updateFileLocally(file) {
    if (!file || !file.id) return;
    const fileIdStr = String(file.id);

    // 1. Update in this.files array
    const fileIdx = this.files.findIndex(f => String(f.id) === fileIdStr);
    if (fileIdx !== -1) {
      this.files[fileIdx] = { ...this.files[fileIdx], ...file };
    }

    // 2. Update in this.filesMap
    if (this.filesMap.has(fileIdStr)) {
      const existing = this.filesMap.get(fileIdStr);
      this.filesMap.set(fileIdStr, { ...existing, ...file });
    }

    // 3. Update DOM card in place without re-rendering entire grid
    const card = document.querySelector(`.file-card[data-id="${fileIdStr}"]`);
    if (card) {
      const mergedFile = fileIdx !== -1 ? this.files[fileIdx] : file;
      const newBadgeHtml = UI.getProviderBadgeHtml(mergedFile);
      const currentBadge = card.querySelector('.provider-badge');

      if (currentBadge) {
        if (newBadgeHtml) {
          const temp = document.createElement('div');
          temp.innerHTML = newBadgeHtml;
          const newEl = temp.firstElementChild;
          if (newEl) currentBadge.replaceWith(newEl);
        } else {
          currentBadge.remove();
        }
      } else if (newBadgeHtml) {
        const sizeEl = card.querySelector('.file-size');
        if (sizeEl) {
          const extBadge = sizeEl.querySelector('.file-ext-badge');
          if (extBadge) {
            extBadge.insertAdjacentHTML('afterend', newBadgeHtml);
          } else {
            sizeEl.insertAdjacentHTML('afterbegin', newBadgeHtml);
          }
        }
      }

      // Update name if changed
      if (file.name) {
        const nameEl = card.querySelector('.file-name');
        if (nameEl) {
          nameEl.textContent = file.name;
          nameEl.title = file.name;
        }
      }
    }

    // If file was not in our list but belongs to current view, add it
    const currentFolderMatches = (this.currentFolderId === null && !file.folder_id) || (String(this.currentFolderId) === String(file.folder_id));
    if (fileIdx === -1 && ((this.currentView === 'drive' && currentFolderMatches) || this.currentView === 'recent')) {
      this.addUploadedFileLocally(file);
    }
  },

  removeFileLocally(fileId) {
    if (!fileId) return;
    const fileIdStr = String(fileId);
    this.files = this.files.filter(f => String(f.id) !== fileIdStr);
    this.filesMap.delete(fileIdStr);

    const card = document.querySelector(`.file-card[data-id="${fileIdStr}"]`);
    if (card) {
      card.remove();
    }

    const hasFolders = this.folders.length > 0;
    const hasFiles = this.files.length > 0;
    if (!hasFolders && !hasFiles) {
      const emptyState = document.getElementById('empty-state');
      const fileContainer = document.getElementById('file-container');
      const filesSection = document.getElementById('files-section');
      if (filesSection) filesSection.style.display = 'none';
      if (fileContainer) fileContainer.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      this.updateEmptyState();
    }
    this.loadStorageStats();
  },

  removeFolderLocally(folderId) {
    if (!folderId) return;
    const folderIdStr = String(folderId);
    this.folders = this.folders.filter(f => String(f.id) !== folderIdStr);
    this.foldersMap.delete(folderIdStr);

    const card = document.querySelector(`.folder-card[data-id="${folderIdStr}"]`);
    if (card) {
      card.remove();
    }

    const hasFolders = this.folders.length > 0;
    const hasFiles = this.files.length > 0;
    if (!hasFolders && !hasFiles) {
      const emptyState = document.getElementById('empty-state');
      const fileContainer = document.getElementById('file-container');
      const foldersSection = document.getElementById('folders-section');
      if (foldersSection) foldersSection.style.display = 'none';
      if (fileContainer) fileContainer.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      this.updateEmptyState();
    }
  },

  updateFolderLocally(folder) {
    if (!folder || !folder.id) return;
    const folderIdStr = String(folder.id);
    const idx = this.folders.findIndex(f => String(f.id) === folderIdStr);
    if (idx !== -1) {
      this.folders[idx] = { ...this.folders[idx], ...folder };
    }
    if (this.foldersMap.has(folderIdStr)) {
      const existing = this.foldersMap.get(folderIdStr);
      this.foldersMap.set(folderIdStr, { ...existing, ...folder });
    }
    const card = document.querySelector(`.folder-card[data-id="${folderIdStr}"]`);
    if (card && folder.name) {
      const nameEl = card.querySelector('.folder-name');
      if (nameEl) {
        nameEl.textContent = folder.name;
        nameEl.title = folder.name;
      }
    }
  },

  // ─── Dynamic Empty State Renderer ─────────────────────────────────
  updateEmptyState() {
    const emptyTitle = document.getElementById('empty-title');
    const emptyText = document.getElementById('empty-text');
    const emptyIconWrap = document.querySelector('.empty-icon-wrap');
    if (!emptyTitle || !emptyText) return;

    const searchInput = document.getElementById('search-input');
    const searchQuery = searchInput ? searchInput.value.trim() : '';
    if (searchQuery) {
      emptyTitle.textContent = 'No matching items';
      emptyText.textContent = `No files or folders matching "${searchQuery}" were found.`;
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
        `;
      }
      return;
    }

    if (this.currentView === 'trash') {
      emptyTitle.textContent = 'Trash is empty';
      emptyText.textContent = 'Items moved to trash will appear here. Trashed files can be restored or deleted permanently.';
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        `;
      }
    } else if (this.currentView === 'starred') {
      emptyTitle.textContent = 'No starred files';
      emptyText.textContent = 'Add stars to important files or folders to easily find them later.';
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
        `;
      }
    } else if (this.currentView === 'recent') {
      emptyTitle.textContent = 'No recent files';
      emptyText.textContent = 'Files you recently uploaded, downloaded, or viewed will appear here.';
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
          </svg>
        `;
      }
    } else if (this.activeFilter && this.activeFilter !== 'all') {
      emptyTitle.textContent = `No ${this.activeFilter} files found`;
      emptyText.textContent = `There are no ${this.activeFilter} files matching this category in the current view.`;
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        `;
      }
    } else if (this.currentFolderId) {
      emptyTitle.textContent = 'This folder is empty';
      emptyText.textContent = 'Drag and drop files here, or click "New Upload" to add files to this folder.';
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        `;
      }
    } else {
      emptyTitle.textContent = 'Your Drive is empty';
      emptyText.textContent = 'Drag and drop files or folders here, or click "New Upload" to store files securely without size limits.';
      if (emptyIconWrap) {
        emptyIconWrap.innerHTML = `
          <svg viewBox="0 0 24 24" width="72" height="72" fill="var(--text-disabled)">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/>
          </svg>
        `;
      }
    }
  },

  // ─── Rendering ─────────────────────────────────────────────────────
  renderContents() {
    UI.hideSkeletons();
    const fileContainer = document.getElementById('file-container');
    const foldersSection = document.getElementById('folders-section');
    const filesSection = document.getElementById('files-section');
    const foldersGrid = document.getElementById('folders-grid');
    const filesGrid = document.getElementById('files-grid');
    const emptyState = document.getElementById('empty-state');

    // Update Trash Banner visibility
    const trashBanner = document.getElementById('trash-banner');
    if (trashBanner) {
      trashBanner.style.display = this.currentView === 'trash' ? 'flex' : 'none';
    }

    // Build Maps for instant, error-free lookup
    this.foldersMap.clear();
    this.filesMap.clear();
    this.folders.forEach(f => this.foldersMap.set(String(f.id), { ...f, type: 'folder' }));
    this.files.forEach(f => this.filesMap.set(String(f.id), { ...f, type: 'file' }));

    // Filter files
    let filteredFiles = this.files;
    if (this.activeFilter && this.activeFilter !== 'all') {
      filteredFiles = this.files.filter(f => UI.getFileTypeCategory(f.mime_type, f.name) === this.activeFilter);
    }

    // Sort files & folders
    this.sortArray(this.folders);
    this.sortArray(filteredFiles);

    const hasFolders = this.folders.length > 0;
    const hasFiles = filteredFiles.length > 0;

    if (!hasFolders) {
      if (foldersGrid) foldersGrid.innerHTML = '';
      if (foldersSection) foldersSection.style.display = 'none';
    }
    if (!hasFiles) {
      if (filesGrid) filesGrid.innerHTML = '';
      if (filesSection) filesSection.style.display = 'none';
      this.renderedFileCount = 0;
    }

    if (!hasFolders && !hasFiles) {
      this.updateEmptyState();
      if (fileContainer) fileContainer.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (fileContainer) fileContainer.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    // Render Folders
    if (hasFolders) {
      foldersSection.style.display = 'block';
      foldersGrid.innerHTML = this.folders.map(f => UI.renderFolderCard(f)).join('');
    }

    // Disconnect old scroll observer
    if (this._virtualScrollObserver) {
      this._virtualScrollObserver.disconnect();
    }

    // Render Files (Progressive Batch Windowing for 60fps scrolling on large folders)
    this.filteredFiles = filteredFiles;
    if (hasFiles) {
      filesSection.style.display = 'block';
      if (filteredFiles.length <= this._VIRTUAL_PAGE_SIZE) {
        this.renderedFileCount = filteredFiles.length;
        filesGrid.innerHTML = filteredFiles.map(f => UI.renderFileCard(f)).join('');
        UI.loadVideoThumbnails(filteredFiles);
      } else {
        this.renderedFileCount = this._VIRTUAL_PAGE_SIZE;
        const initialBatch = filteredFiles.slice(0, this._VIRTUAL_PAGE_SIZE);
        filesGrid.innerHTML = initialBatch.map(f => UI.renderFileCard(f)).join('') + `
          <div id="virtual-scroll-sentinel" style="grid-column: 1 / -1; height: 30px; width: 100%; display: flex; align-items: center; justify-content: center;"></div>
        `;
        UI.loadVideoThumbnails(initialBatch);
        this.initVirtualScrollObserver();
      }
    } else {
      this.renderedFileCount = 0;
      filesSection.style.display = 'none';
    }

    // Apply view mode
    if (this.viewMode === 'list') {
      fileContainer.classList.add('list-view');
      fileContainer.classList.remove('grid-view');
    } else {
      fileContainer.classList.add('grid-view');
      fileContainer.classList.remove('list-view');
    }

    const gridViewBtn = document.getElementById('view-grid-btn');
    const listViewBtn = document.getElementById('view-list-btn');
    if (gridViewBtn) {
      const active = this.viewMode === 'grid';
      gridViewBtn.classList.toggle('active', active);
      gridViewBtn.setAttribute('aria-pressed', String(active));
    }
    if (listViewBtn) {
      const active = this.viewMode === 'list';
      listViewBtn.classList.toggle('active', active);
      listViewBtn.setAttribute('aria-pressed', String(active));
    }
  },

  /**
   * Google Drive style Instant Incremental File Insertion
   * Inserts only the newly uploaded file into UI with 0 full-page reload/flicker
   */
  addUploadedFileLocally(file, localFileBlob = null) {
    if (!file || !file.id) return;
    if (localFileBlob) file.localBlob = localFileBlob;

    // Check if the uploaded file belongs to current active view
    const isDriveView = this.currentView === 'drive';
    const isRecentView = this.currentView === 'recent';
    
    // In drive view, match current folder (both null for root, or exact ID match)
    const targetFolderId = (file.folder_id && file.folder_id !== 'null') ? String(file.folder_id) : null;
    const currentFolderId = (this.currentFolderId && this.currentFolderId !== 'null') ? String(this.currentFolderId) : null;
    const matchesFolder = isDriveView && (targetFolderId === currentFolderId);

    if (!matchesFolder && !isRecentView) {
      // Not currently viewing the folder this file was uploaded to: do not touch DOM!
      this.loadStorageStats();
      return;
    }

    // Check active file filter
    if (this.activeFilter && this.activeFilter !== 'all') {
      const cat = UI.getFileTypeCategory(file.mime_type, file.name);
      if (cat !== this.activeFilter) {
        this.loadStorageStats();
        return;
      }
    }

    // 1. Update State Maps & Array
    this.filesMap.set(String(file.id), { ...file, type: 'file' });
    const existingIndex = this.files.findIndex(f => String(f.id) === String(file.id));
    if (existingIndex !== -1) {
      this.files[existingIndex] = file;
    } else {
      this.files.unshift(file);
    }

    // 2. Ensure container visibility
    const emptyState = document.getElementById('empty-state');
    const fileContainer = document.getElementById('file-container');
    const filesSection = document.getElementById('files-section');
    const filesGrid = document.getElementById('files-grid');

    if (emptyState) emptyState.style.display = 'none';
    if (fileContainer) fileContainer.style.display = 'block';
    if (filesSection) filesSection.style.display = 'block';

    // 3. In-place DOM Insertion / Update
    if (filesGrid) {
      const existingCard = filesGrid.querySelector(`[data-id="${file.id}"]`);
      const cardHtml = UI.renderFileCard(file);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = cardHtml;
      const newCard = tempDiv.firstElementChild;

      if (newCard) {
        // Instant preview for local image files
        const cat = UI.getFileTypeCategory(file.mime_type, file.name);
        if (cat === 'image' && (localFileBlob || file.localBlob)) {
          const imgEl = newCard.querySelector('.file-thumb-media');
          if (imgEl) {
            try {
              imgEl.src = URL.createObjectURL(localFileBlob || file.localBlob);
              imgEl.style.display = 'block';
            } catch (e) {}
          }
        } else if (cat === 'video' && (localFileBlob || file.localBlob)) {
          const imgEl = newCard.querySelector('.file-thumb-media');
          if (imgEl) {
            UI.generateVideoThumbnailFromBlob(localFileBlob || file.localBlob, file.id, imgEl);
          }
        }

        if (existingCard) {
          filesGrid.replaceChild(newCard, existingCard);
        } else {
          if (filesGrid.firstChild) {
            filesGrid.insertBefore(newCard, filesGrid.firstChild);
          } else {
            filesGrid.appendChild(newCard);
          }
        }
        newCard.classList.add('card-just-added');
        setTimeout(() => newCard.classList.remove('card-just-added'), 1500);
      }

      // Load/generate thumbnail for this specific file (video / image)
      UI.loadVideoThumbnails([file]);
    }

    // 4. Update storage stats in background (debounced)
    this.loadStorageStats();
  },

  addUploadedFolderLocally(folder) {
    if (!folder || !folder.id) return;

    const isDriveView = this.currentView === 'drive';
    const targetParentId = (folder.parent_id && folder.parent_id !== 'null') ? String(folder.parent_id) : null;
    const currentFolderId = (this.currentFolderId && this.currentFolderId !== 'null') ? String(this.currentFolderId) : null;
    const matchesFolder = isDriveView && (targetParentId === currentFolderId);

    if (!matchesFolder) return;

    this.foldersMap.set(String(folder.id), { ...folder, type: 'folder' });
    const existingIndex = this.folders.findIndex(f => String(f.id) === String(folder.id));
    if (existingIndex !== -1) {
      this.folders[existingIndex] = folder;
    } else {
      this.folders.unshift(folder);
    }

    const emptyState = document.getElementById('empty-state');
    const fileContainer = document.getElementById('file-container');
    const foldersSection = document.getElementById('folders-section');
    const foldersGrid = document.getElementById('folders-grid');

    if (emptyState) emptyState.style.display = 'none';
    if (fileContainer) fileContainer.style.display = 'block';
    if (foldersSection) foldersSection.style.display = 'block';

    if (foldersGrid) {
      const existingCard = foldersGrid.querySelector(`[data-id="${folder.id}"]`);
      const cardHtml = UI.renderFolderCard(folder);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = cardHtml;
      const newCard = tempDiv.firstElementChild;

      if (newCard) {
        if (existingCard) {
          foldersGrid.replaceChild(newCard, existingCard);
        } else {
          if (foldersGrid.firstChild) {
            foldersGrid.insertBefore(newCard, foldersGrid.firstChild);
          } else {
            foldersGrid.appendChild(newCard);
          }
        }
        newCard.classList.add('card-just-added');
        setTimeout(() => newCard.classList.remove('card-just-added'), 1500);
      }
    }
  },

  removeItemsLocally(items) {
    if (!items) return;
    const itemList = Array.isArray(items) ? items : [items];
    if (itemList.length === 0) return;

    const fileIdSet = new Set();
    const folderIdSet = new Set();
    const allIdSet = new Set();

    itemList.forEach(item => {
      let id, type;
      if (typeof item === 'object' && item !== null) {
        id = String(item.id);
        type = item.type || (this.foldersMap.has(id) ? 'folder' : 'file');
      } else {
        id = String(item);
        type = this.foldersMap.has(id) ? 'folder' : 'file';
      }

      allIdSet.add(id);
      if (type === 'folder') {
        folderIdSet.add(id);
      } else {
        fileIdSet.add(id);
      }

      // Deselect immediately
      UI.selectedItems.delete(id);
    });

    UI.updateActionBar();

    // Fast batch DOM query (single pass without reflow lag)
    const elementsToAnimate = [];
    document.querySelectorAll('.file-card, .folder-card').forEach(card => {
      const cardId = card.getAttribute('data-id');
      if (cardId && allIdSet.has(cardId)) {
        elementsToAnimate.push(card);
        card.classList.add('item-vanishing');
        card.style.pointerEvents = 'none';
      }
    });

    // Update local dataset immediately so searches/filters/counts stay consistent
    this.files = this.files.filter(f => !fileIdSet.has(String(f.id)));
    this.folders = this.folders.filter(f => !folderIdSet.has(String(f.id)));
    if (this.filteredFiles) {
      this.filteredFiles = this.filteredFiles.filter(f => !fileIdSet.has(String(f.id)));
    }
    fileIdSet.forEach(id => this.filesMap.delete(id));
    folderIdSet.forEach(id => this.foldersMap.delete(id));

    setTimeout(() => {
      elementsToAnimate.forEach(card => card.remove());

      const hasFolders = this.folders.length > 0;
      const hasFiles = (this.filteredFiles ? this.filteredFiles.length : this.files.length) > 0;

      const foldersSection = document.getElementById('folders-section');
      const filesSection = document.getElementById('files-section');
      const fileContainer = document.getElementById('file-container');
      const emptyState = document.getElementById('empty-state');

      if (!hasFolders && foldersSection) {
        foldersSection.style.display = 'none';
      }
      if (!hasFiles && filesSection) {
        filesSection.style.display = 'none';
      }
      if (!hasFolders && !hasFiles) {
        if (fileContainer) fileContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
      }
    }, 220);

    this.loadStorageStats();
  },

  emptyTrashLocally() {
    UI.clearSelection();
    const allCards = document.querySelectorAll('.file-card, .folder-card');
    allCards.forEach(card => {
      card.classList.add('item-vanishing');
      card.style.pointerEvents = 'none';
    });

    this.files = [];
    this.folders = [];
    this.filteredFiles = [];
    this.filesMap.clear();
    this.foldersMap.clear();

    setTimeout(() => {
      const foldersGrid = document.getElementById('folders-grid');
      const filesGrid = document.getElementById('files-grid');
      if (foldersGrid) foldersGrid.innerHTML = '';
      if (filesGrid) filesGrid.innerHTML = '';

      const fileContainer = document.getElementById('file-container');
      const emptyState = document.getElementById('empty-state');
      const foldersSection = document.getElementById('folders-section');
      const filesSection = document.getElementById('files-section');
      if (foldersSection) foldersSection.style.display = 'none';
      if (filesSection) filesSection.style.display = 'none';
      if (fileContainer) fileContainer.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
    }, 220);

    this.loadStorageStats();
  },

  removeFileLocally(fileId) {
    if (!fileId) return;
    this.removeItemsLocally([{ id: fileId, type: 'file' }]);
  },

  removeFolderLocally(folderId) {
    if (!folderId) return;
    this.removeItemsLocally([{ id: folderId, type: 'folder' }]);
  },

  updateFileLocally(file) {
    if (!file || !file.id) return;
    this.filesMap.set(String(file.id), { ...file, type: 'file' });
    const idx = this.files.findIndex(f => String(f.id) === String(file.id));
    if (idx !== -1) {
      this.files[idx] = file;
    }

    const filesGrid = document.getElementById('files-grid');
    if (filesGrid) {
      const existingCard = filesGrid.querySelector(`[data-id="${file.id}"]`);
      if (existingCard) {
        const cardHtml = UI.renderFileCard(file);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cardHtml;
        const newCard = tempDiv.firstElementChild;
        if (newCard) {
          filesGrid.replaceChild(newCard, existingCard);
        }
      }
    }
  },

  updateFolderLocally(folder) {
    if (!folder || !folder.id) return;
    this.foldersMap.set(String(folder.id), { ...folder, type: 'folder' });
    const idx = this.folders.findIndex(f => String(f.id) === String(folder.id));
    if (idx !== -1) {
      this.folders[idx] = folder;
    }

    const foldersGrid = document.getElementById('folders-grid');
    if (foldersGrid) {
      const existingCard = foldersGrid.querySelector(`[data-id="${folder.id}"]`);
      if (existingCard) {
        const cardHtml = UI.renderFolderCard(folder);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cardHtml;
        const newCard = tempDiv.firstElementChild;
        if (newCard) {
          foldersGrid.replaceChild(newCard, existingCard);
        }
      }
    }
  },

  // ─── Virtual Scrolling & Batch Windowing ───────────────────────────
  initVirtualScrollObserver() {
    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (!sentinel) return;

    if (this._virtualScrollObserver) {
      this._virtualScrollObserver.disconnect();
    }

    if (!window.IntersectionObserver) {
      this.renderAllRemainingFiles();
      return;
    }

    this._virtualScrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.renderNextBatch();
        }
      });
    }, { rootMargin: '350px' });

    this._virtualScrollObserver.observe(sentinel);
  },

  renderNextBatch() {
    if (!this.filteredFiles || this.renderedFileCount >= this.filteredFiles.length) {
      const sentinel = document.getElementById('virtual-scroll-sentinel');
      if (sentinel) sentinel.remove();
      if (this._virtualScrollObserver) this._virtualScrollObserver.disconnect();
      return;
    }

    const nextBatch = this.filteredFiles.slice(this.renderedFileCount, this.renderedFileCount + this._VIRTUAL_PAGE_SIZE);
    this.renderedFileCount += nextBatch.length;

    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (sentinel) {
      const html = nextBatch.map(f => UI.renderFileCard(f)).join('');
      sentinel.insertAdjacentHTML('beforebegin', html);
      UI.loadVideoThumbnails(nextBatch);

      if (this.renderedFileCount >= this.filteredFiles.length) {
        sentinel.remove();
        if (this._virtualScrollObserver) this._virtualScrollObserver.disconnect();
      }
    }
  },

  renderAllRemainingFiles() {
    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (!sentinel || !this.filteredFiles) return;
    const remaining = this.filteredFiles.slice(this.renderedFileCount);
    if (remaining.length > 0) {
      const html = remaining.map(f => UI.renderFileCard(f)).join('');
      sentinel.insertAdjacentHTML('beforebegin', html);
      UI.loadVideoThumbnails(remaining);
    }
    sentinel.remove();
    this.renderedFileCount = this.filteredFiles.length;
  },

  sortArray(arr) {
    arr.sort((a, b) => {
      let valA = a[this.sortBy];
      let valB = b[this.sortBy];

      if (this.sortBy === 'name') {
        valA = (valA || '').toLowerCase();
        valB = (valB || '').toLowerCase();
        return this.sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      if (this.sortBy === 'size') {
        return this.sortOrder === 'asc' ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
      }
      if (this.sortBy === 'date') {
        return this.sortOrder === 'asc' ? new Date(a.created_at) - new Date(b.created_at) : new Date(b.created_at) - new Date(a.created_at);
      }
      return 0;
    });
  },

  getVisibleFiles() {
    let list = Array.isArray(this.files) ? [...this.files] : [];
    if (this.activeFilter && this.activeFilter !== 'all') {
      list = list.filter(f => UI.getFileTypeCategory(f.mime_type, f.name) === this.activeFilter);
    }
    this.sortArray(list);
    return list;
  },

  // ─── Event Delegation on File Container (Rock Solid) ───────────────
  initFileContainerEvents() {
    const fileContainer = document.getElementById('file-container');
    if (!fileContainer) return;

    // Click handler (delegated)
    fileContainer.addEventListener('click', (e) => {
      // 1. Check if selection checkbox button was clicked
      const selectBtn = e.target.closest('.card-select-btn');
      if (selectBtn) {
        e.stopPropagation();
        const id = String(selectBtn.getAttribute('data-id'));
        const type = selectBtn.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        UI.toggleSelection(id, type, item);
        this.lastSelectedId = id;
        return;
      }

      // 2. Check if 3-dot menu button was clicked
      const moreBtn = e.target.closest('.item-more-btn');
      if (moreBtn) {
        e.stopPropagation();
        const id = String(moreBtn.getAttribute('data-id'));
        const type = moreBtn.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        if (item) {
          UI.showContextMenu(e, item);
        }
        return;
      }

      // 3. Check for Ctrl/Cmd multi-selection click on any card
      if (e.ctrlKey || e.metaKey) {
        const card = e.target.closest('.file-card, .folder-card');
        if (card) {
          e.stopPropagation();
          const id = String(card.getAttribute('data-id'));
          const type = card.getAttribute('data-type');
          const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
          UI.toggleSelection(id, type, item);
          this.lastSelectedId = id;
          return;
        }
      }

      // 4. Check for Shift range-selection click on any card
      if (e.shiftKey && this.lastSelectedId) {
        const card = e.target.closest('.file-card, .folder-card');
        if (card) {
          e.stopPropagation();
          const allCards = Array.from(fileContainer.querySelectorAll('.file-card, .folder-card'));
          const lastIdx = allCards.findIndex(c => String(c.getAttribute('data-id')) === String(this.lastSelectedId));
          const currIdx = allCards.findIndex(c => c === card);
          if (lastIdx !== -1 && currIdx !== -1) {
            const start = Math.min(lastIdx, currIdx);
            const end = Math.max(lastIdx, currIdx);
            for (let i = start; i <= end; i++) {
              const c = allCards[i];
              const cid = String(c.getAttribute('data-id'));
              const ctype = c.getAttribute('data-type');
              const citem = ctype === 'folder' ? this.foldersMap.get(cid) : this.filesMap.get(cid);
              UI.toggleSelection(cid, ctype, citem, true);
            }
            return;
          }
        }
      }

      // 5. If currently in selection mode:
      if (UI.selectedItems.size > 0) {
        // Clicking a folder card navigates directly into it (like Google Drive)
        const folderCard = e.target.closest('.folder-card');
        if (folderCard) {
          const id = String(folderCard.getAttribute('data-id'));
          UI.clearSelection();
          this.lastSelectedId = id;
          this.navigateToFolder(id);
          return;
        }

        // Clicking a file card toggles selection
        const card = e.target.closest('.file-card');
        if (card) {
          const id = String(card.getAttribute('data-id'));
          const type = card.getAttribute('data-type');
          const item = this.filesMap.get(id);
          UI.toggleSelection(id, type, item);
          this.lastSelectedId = id;
          return;
        }
      }

      // 6. Normal click: Folder navigates, File opens preview
      const folderCard = e.target.closest('.folder-card');
      if (folderCard) {
        const id = String(folderCard.getAttribute('data-id'));
        const isLocked = folderCard.getAttribute('data-locked') === '1';
        this.lastSelectedId = id;
        if (isLocked && !this.unlockedFolders.has(id)) {
          const folder = this.foldersMap.get(id) || { id, name: folderCard.querySelector('.folder-name')?.textContent || 'Folder', is_locked: 1 };
          this.openUnlockFolderModal(folder, false);
          return;
        }
        this.navigateToFolder(id);
        return;
      }

      const fileCard = e.target.closest('.file-card');
      if (fileCard) {
        const id = String(fileCard.getAttribute('data-id'));
        this.lastSelectedId = id;
        const file = this.filesMap.get(id);
        if (file) {
          Preview.open(file);
        }
        return;
      }
    });

    // Double-click handler as instant guarantee
    fileContainer.addEventListener('dblclick', (e) => {
      const folderCard = e.target.closest('.folder-card');
      if (folderCard) {
        const id = String(folderCard.getAttribute('data-id'));
        const isLocked = folderCard.getAttribute('data-locked') === '1';
        UI.clearSelection();
        if (isLocked && !this.unlockedFolders.has(id)) {
          const folder = this.foldersMap.get(id) || { id, name: folderCard.querySelector('.folder-name')?.textContent || 'Folder', is_locked: 1 };
          this.openUnlockFolderModal(folder, false);
          return;
        }
        this.navigateToFolder(id);
        return;
      }
      const fileCard = e.target.closest('.file-card');
      if (fileCard) {
        const id = String(fileCard.getAttribute('data-id'));
        const file = this.filesMap.get(id);
        if (file) {
          Preview.open(file);
        }
      }
    });

    // Context menu / right-click handler (delegated)
    fileContainer.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.file-card, .folder-card');
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        const id = String(card.getAttribute('data-id'));
        const type = card.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        if (item) {
          UI.showContextMenu(e, item);
        }
      }
    });
  },

  // ─── Drag & Drop Moving (Smooth, Animated, Google Drive Style) ────
  initDragAndDropMove() {
    const fileContainer = document.getElementById('file-container');
    const breadcrumb = document.getElementById('breadcrumb');
    const driveNavItem = document.querySelector('.sidebar-nav .nav-item[data-view="drive"]');

    if (!fileContainer || this._dragAndDropInitialized) return;
    this._dragAndDropInitialized = true;

    // Keep drag state resilient when the browser fires dragend before drop
    // (this can happen when dragging over nested card children).
    const readDraggedItems = (event) => {
      if (this.draggedItem) return this.draggedItem;
      try {
        const raw = event?.dataTransfer?.getData('application/x-clouddrive-item') || event?.dataTransfer?.getData('application/x-discorddrive-item') || event?.dataTransfer?.getData('text/plain');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.items)) return parsed.items;
          return parsed && parsed.id ? [parsed] : [];
        }
      } catch (_) { /* Ignore browser dataTransfer restrictions. */ }
      return [];
    };

    // 1. Drag Start on File / Folder Cards
    fileContainer.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.file-card, .folder-card');
      if (!card) return;

      // Do not initiate drag if user clicked on the 3-dot more button
      if (e.target.closest('.item-more-btn')) {
        e.preventDefault();
        return;
      }

      const id = card.getAttribute('data-id');
      const type = card.getAttribute('data-type');
      const item = (type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id)) || {
        id,
        type,
        name: card.querySelector(type === 'folder' ? '.folder-name' : '.file-name')?.textContent?.trim() || 'Item'
      };
      if (!item) return;

      // Dragging one of a selected group must move the entire selected group,
      // matching desktop file managers. A non-selected card remains a single
      // item drag and does not disturb the user's current selection.
      const selectedItems = UI.selectedItems.has(String(id)) && UI.selectedItems.size > 1
        ? Array.from(UI.selectedItems.values()).map(selected => ({
          id: selected.id,
          type: selected.type,
          name: selected.item?.name || selected.id,
          folder_id: selected.item?.folder_id,
          parent_id: selected.item?.parent_id
        }))
        : [{ id: item.id, type: item.type, name: item.name, folder_id: item.folder_id, parent_id: item.parent_id }];

      this.draggedItem = selectedItems;
      this.draggedCardElement = card;

      const transferItem = JSON.stringify({ items: selectedItems });
      e.dataTransfer.setData('application/x-clouddrive-item', transferItem);
      // text/plain keeps the move payload available in browsers that restrict
      // custom drag MIME types between nested elements.
      e.dataTransfer.setData('text/plain', transferItem);
      e.dataTransfer.effectAllowed = 'move';

      setTimeout(() => {
        if (card) card.classList.add('is-dragging');
      }, 0);
    });

    // 2. Drag End
    fileContainer.addEventListener('dragend', (e) => {
      const card = e.target.closest('.file-card, .folder-card') || this.draggedCardElement;
      if (card) card.classList.remove('is-dragging');
      this.draggedItem = null;
      this.draggedCardElement = null;

      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    // 3. Drag Over / Enter on Folder Cards
    const allowFolderDrop = (e) => {
      const draggedItems = readDraggedItems(e);
      if (draggedItems.length === 0) return;
      const folderCard = e.target.closest('.folder-card');
      if (!folderCard) return;

      const targetFolderId = folderCard.getAttribute('data-id');
      // Cannot move folder into itself
      if (draggedItems.some(item => item.type === 'folder' && String(item.id) === String(targetFolderId))) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folderCard.classList.add('drag-over');
    };
    fileContainer.addEventListener('dragenter', allowFolderDrop);
    fileContainer.addEventListener('dragover', allowFolderDrop);

    fileContainer.addEventListener('dragleave', (e) => {
      const folderCard = e.target.closest('.folder-card');
      if (!folderCard) return;
      if (!folderCard.contains(e.relatedTarget)) {
        folderCard.classList.remove('drag-over');
      }
    });

    // 4. Drop on Folder Card
    fileContainer.addEventListener('drop', async (e) => {
      const folderCard = e.target.closest('.folder-card');
      const draggedItems = readDraggedItems(e);
      if (!folderCard || draggedItems.length === 0) return;

      e.preventDefault();
      e.stopPropagation();
      folderCard.classList.remove('drag-over');

      const targetFolderId = folderCard.getAttribute('data-id');
      const targetFolder = this.foldersMap.get(targetFolderId);
      const targetName = targetFolder ? targetFolder.name : 'Folder';

      await this.executeMove(draggedItems, targetFolderId, targetName);
    });

    // 5. Drop on Breadcrumb Ancestor Folders
    if (breadcrumb) {
      breadcrumb.addEventListener('dragover', (e) => {
        if (readDraggedItems(e).length === 0) return;
        const bItem = e.target.closest('a.breadcrumb-item');
        if (!bItem) return;

        const rawId = bItem.getAttribute('data-folder-id');
        const targetFolderId = (rawId && rawId !== 'null' && rawId !== '') ? rawId : null;
        if (targetFolderId === this.currentFolderId) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        bItem.classList.add('drag-over');
      });

      breadcrumb.addEventListener('dragleave', (e) => {
        const bItem = e.target.closest('a.breadcrumb-item');
        if (bItem && !bItem.contains(e.relatedTarget)) {
          bItem.classList.remove('drag-over');
        }
      });

      breadcrumb.addEventListener('drop', async (e) => {
        const bItem = e.target.closest('a.breadcrumb-item');
        const draggedItems = readDraggedItems(e);
        if (!bItem || draggedItems.length === 0) return;

        e.preventDefault();
        e.stopPropagation();
        bItem.classList.remove('drag-over');

        const rawId = bItem.getAttribute('data-folder-id');
        const targetFolderId = (rawId && rawId !== 'null' && rawId !== '') ? rawId : null;
        const targetName = bItem.textContent.trim() || 'My Drive';

        await this.executeMove(draggedItems, targetFolderId, targetName);
      });
    }

    // 6. Drop on Sidebar "My Drive" (Root)
    if (driveNavItem) {
      driveNavItem.addEventListener('dragover', (e) => {
        if (readDraggedItems(e).length === 0 || this.currentFolderId === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        driveNavItem.classList.add('drag-over');
      });

      driveNavItem.addEventListener('dragleave', (e) => {
        if (!driveNavItem.contains(e.relatedTarget)) {
          driveNavItem.classList.remove('drag-over');
        }
      });

      driveNavItem.addEventListener('drop', async (e) => {
        const draggedItems = readDraggedItems(e);
        if (draggedItems.length === 0 || this.currentFolderId === null) return;
        e.preventDefault();
        e.stopPropagation();
        driveNavItem.classList.remove('drag-over');
        await this.executeMove(draggedItems, null, 'My Drive');
      });
    }
  },

  async executeMove(items, targetFolderId, targetFolderName) {
    const moveItems = Array.isArray(items) ? items : (items ? [items] : []);
    if (moveItems.length === 0) return;
    const destinationId = targetFolderId === undefined || targetFolderId === null || targetFolderId === 'null' || targetFolderId === 'root' || targetFolderId === '' ? null : String(targetFolderId);

    if (moveItems.some(item => item.type === 'folder' && String(item.id) === destinationId)) {
      UI.showToast('Cannot move a folder into itself', 'warning');
      return;
    }

    try {
      if (this.draggedCardElement) {
        this.draggedCardElement.classList.add('move-out');
      }

      if (moveItems.length > 1) {
        const fileIds = moveItems.filter(item => item.type === 'file').map(item => item.id);
        const folderIds = moveItems.filter(item => item.type === 'folder').map(item => item.id);
        await API.batchMove(fileIds, folderIds, destinationId);
        UI.showToast(`Moved ${moveItems.length} items to "${targetFolderName}"`, 'success');
      } else {
        const item = moveItems[0];
        if (item.type === 'folder') {
          await API.moveFolder(item.id, destinationId);
        } else {
          await API.moveFile(item.id, destinationId);
        }
        UI.showToast(`Moved "${item.name}" to "${targetFolderName}"`, 'success');
      }
      UI.clearSelection();

      setTimeout(() => {
        this.refreshCurrentView();
      }, 250);
    } catch (err) {
      UI.showToast(`Move failed: ${err.message}`, 'error');
      this.refreshCurrentView();
    }
  },

  // ─── Actions ───────────────────────────────────────────────────────
  async handleItemAction(action, itemData) {
    if (!itemData) return;

    if (action === 'preview') {
      if (itemData.type === 'folder') {
        this.navigateToFolder(itemData.id);
      } else {
        Preview.open(itemData);
      }
    } else if (action === 'download') {
      if (itemData.type !== 'folder') {
        const dcConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.discord?.connected !== false) : true;
        const tgConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.telegram?.connected !== false) : true;
        if (!dcConnected && !tgConnected) {
          UI.showToast('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings to download.', 'error', 5000);
          return;
        }
        UI.triggerDownload(API.getDownloadUrl(itemData.id), itemData.name);
      }
    } else if (action === 'share') {
      if (itemData.type !== 'folder') {
        this.openShareModal(itemData);
      }
    } else if (action === 'info') {
      if (itemData.type === 'folder') {
        this.openFolderInfoModal(itemData);
      } else {
        this.openFileInfoModal(itemData);
      }
    } else if (action === 'star') {
      if (itemData.type === 'file') {
        const newStar = itemData.is_starred ? 0 : 1;
        await API.starFile(itemData.id, newStar);
        UI.showToast(newStar ? 'Added to Starred' : 'Removed from Starred', 'info');
        this.refreshCurrentView();
      }
    } else if (action === 'rename') {
      this.openRenameModal(itemData);
    } else if (action === 'lock-folder') {
      if (itemData.type === 'folder') {
        if (itemData.is_locked) {
          this.openUnlockFolderModal(itemData, true);
        } else {
          this.openLockFolderModal(itemData);
        }
      }
    } else if (action === 'relock-folder') {
      if (itemData.type === 'folder') {
        this.relockFolder(itemData.id);
      }
    } else if (action === 'move') {
      this.openMoveModal(itemData);
    } else if (action === 'trash') {
      if (itemData.type === 'file') {
        this.removeItemsLocally([itemData]);
        try {
          await API.trashFile(itemData.id);
          UI.showToast('Moved to Trash', 'info');
        } catch (e) {
          UI.showToast('Failed to trash file: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      } else {
        const confirmed = await UI.confirm({
          title: 'Move Folder to Trash?',
          message: `Are you sure you want to move folder "${itemData.name}" and all its contents to Trash?`,
          description: 'All files inside will be unlinked and moved to Trash. They can still be restored.',
          icon: 'trash',
          confirmText: 'Move to Trash',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });
        if (!confirmed) return;
        this.removeItemsLocally([itemData]);
        UI.showToast('Moving folder to Trash...', 'info');
        try {
          await API.deleteFolder(itemData.id);
          UI.showToast('Folder moved to Trash', 'info');
        } catch (e) {
          UI.showToast('Failed to move folder to trash: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      }
    } else if (action === 'restore') {
      if (itemData.type === 'file') {
        this.removeItemsLocally([itemData]);
        try {
          await API.restoreFile(itemData.id);
          UI.showToast('File restored', 'success');
        } catch (e) {
          UI.showToast('Failed to restore file: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      } else {
        this.removeItemsLocally([itemData]);
        try {
          await API.restoreFolder(itemData.id);
          UI.showToast('Folder restored', 'success');
        } catch (e) {
          UI.showToast('Failed to restore folder: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      }
    } else if (action === 'permanent-delete') {
      this.openDeleteModal(itemData);
    } else if (action === 'backup-status' || action === 'replicas') {
      if (itemData.type !== 'folder') {
        this.openReplicaModal(itemData);
      }
    } else if (action === 'replicate-telegram') {
      if (itemData.type !== 'folder') {
        try {
          await API.replicateFile(itemData.id, 'telegram');
          UI.showToast('Replication to Telegram queued!', 'success');
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast(e.message || 'Failed to replicate to Telegram', 'error');
        }
      }
    } else if (action === 'replicate-discord') {
      if (itemData.type !== 'folder') {
        try {
          await API.replicateFile(itemData.id, 'discord');
          UI.showToast('Replication to Discord queued!', 'success');
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast(e.message || 'Failed to replicate to Discord', 'error');
        }
      }
    } else if (action === 'repair') {
      if (itemData.type !== 'folder') {
        try {
          await API.repairFile(itemData.id);
          UI.showToast('Verification and repair jobs enqueued!', 'success');
        } catch (e) {
          UI.showToast(e.message || 'Failed to repair file', 'error');
        }
      }
    }
  },

  
  async openReplicaModal(file) {
    if (!file || file.type === 'folder') return;
    this.selectedItem = file;
    UI.showModal('backup-status-modal');

    const titleEl = document.getElementById('replica-modal-title');
    const overviewBox = document.getElementById('replica-overview-box');
    const tbody = document.getElementById('replica-chunks-tbody');
    const extraActions = document.getElementById('replica-actions-extra');

    if (titleEl) titleEl.textContent = `Replicas: ${file.name}`;
    if (overviewBox) {
      overviewBox.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div>
            <strong style="font-size: 14px;">${UI.escapeHtml(file.name)}</strong>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              Size: ${UI.formatBytes(file.size)} · Mode: <strong>${file.storage_mode || 'dual'}</strong>
            </div>
          </div>
          <div>
            ${UI.getProviderBadgeHtml(file)}
          </div>
        </div>
      `;
    }

    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--text-secondary);">Loading chunk replicas...</td></tr>';
    }
    if (extraActions) extraActions.innerHTML = '';

    try {
      const data = await API.getFileReplicas(file.id);
      const chunks = data.chunks || [];
      const fileInfo = data.file || file;

      if (overviewBox && data.file) {
        overviewBox.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div>
              <strong style="font-size: 14px;">${UI.escapeHtml(fileInfo.name)}</strong>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                Size: ${UI.formatBytes(fileInfo.size)} · Mode: <strong>${fileInfo.storage_mode || 'dual'}</strong>
              </div>
            </div>
            <div>
              ${UI.getProviderBadgeHtml(fileInfo)}
            </div>
          </div>
        `;
      }

      if (tbody) {
        if (chunks.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 20px; color: var(--text-secondary);">No chunk records found for this file.</td></tr>';
        } else {
          tbody.innerHTML = chunks.map(chunk => {
            const dcReplica = chunk.replicas ? chunk.replicas.find(r => r.provider === 'discord') : null;
            const tgReplica = chunk.replicas ? chunk.replicas.find(r => r.provider === 'telegram') : null;

            const dcStatus = dcReplica ?
              `<span class="flat-icon-label" style="color: #10b981; font-weight: 600;">${UI.icon('check', 14)} Synced (Discord)</span>` :
              '<span style="color: var(--text-secondary);">Missing</span>';
            const tgStatus = tgReplica ?
              `<span class="flat-icon-label" style="color: #3b82f6; font-weight: 600;">${UI.icon('check', 14)} Synced (Telegram)</span>` :
              '<span style="color: var(--text-secondary);">Missing</span>';

            return `
              <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 8px 12px; font-weight: 500;">Part ${chunk.chunk_index + 1}</td>
                <td style="padding: 8px 12px; color: var(--text-secondary);">${UI.formatBytes(chunk.chunk_size || 0)}</td>
                <td style="padding: 8px 12px;">${dcStatus}</td>
                <td style="padding: 8px 12px;">${tgStatus}</td>
              </tr>
            `;
          }).join('');
        }
      }

      if (extraActions) {
        extraActions.innerHTML = `
          <button type="button" class="btn-secondary btn-sm" id="btn-modal-replicate-tg" style="display: inline-flex; align-items: center; gap: 6px;">
            <span>Replicate to Telegram</span>
          </button>
          <button type="button" class="btn-secondary btn-sm" id="btn-modal-replicate-dc" style="display: inline-flex; align-items: center; gap: 6px;">
            <span>Replicate to Discord</span>
          </button>
          <button type="button" class="btn-secondary btn-sm" id="btn-modal-repair" style="display: inline-flex; align-items: center; gap: 6px;">
            <span>Verify & Repair</span>
          </button>
        `;

        const btnModalTg = document.getElementById('btn-modal-replicate-tg');
        const btnModalDc = document.getElementById('btn-modal-replicate-dc');
        const btnModalRepair = document.getElementById('btn-modal-repair');

        if (btnModalTg) {
          btnModalTg.onclick = async () => {
            btnModalTg.disabled = true;
            try {
              await API.replicateFile(file.id, 'telegram');
              UI.showToast('Replication to Telegram queued!', 'success');
              this.openReplicaModal(file);
            } catch (e) {
              UI.showToast(e.message || 'Failed to replicate', 'error');
            } finally {
              btnModalTg.disabled = false;
            }
          };
        }

        if (btnModalDc) {
          btnModalDc.onclick = async () => {
            btnModalDc.disabled = true;
            try {
              await API.replicateFile(file.id, 'discord');
              UI.showToast('Replication to Discord queued!', 'success');
              this.openReplicaModal(file);
            } catch (e) {
              UI.showToast(e.message || 'Failed to replicate', 'error');
            } finally {
              btnModalDc.disabled = false;
            }
          };
        }

        if (btnModalRepair) {
          btnModalRepair.onclick = async () => {
            btnModalRepair.disabled = true;
            try {
              await API.repairFile(file.id);
              UI.showToast('Verification and repair started!', 'success');
              this.openReplicaModal(file);
            } catch (e) {
              UI.showToast(e.message || 'Failed to repair', 'error');
            } finally {
              btnModalRepair.disabled = false;
            }
          };
        }
      }
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px; color: #ef4444;">Failed to load replicas: ${UI.escapeHtml(err.message)}</td></tr>`;
      }
    }
  },

  openFileInfoModal(item) {
    if (!item) return;
    this.selectedItem = item;

    const iconEl = document.getElementById('info-file-icon');
    const nameEl = document.getElementById('info-file-name');
    const subEl = document.getElementById('info-file-sub');
    const typeEl = document.getElementById('info-file-type');
    const sizeEl = document.getElementById('info-file-size');
    const locEl = document.getElementById('info-file-location');
    const createdEl = document.getElementById('info-file-created');
    const updatedEl = document.getElementById('info-file-updated');
    const tgEl = document.getElementById('info-file-tg');
    const idEl = document.getElementById('info-file-id');
    const copyLinkBtn = document.getElementById('info-copy-link');

    if (iconEl) {
      iconEl.innerHTML = item.type === 'folder' ?
        `<svg viewBox="0 0 24 24" width="36" height="36" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>` :
        UI.getFileIconSvg(item.mime_type);
    }

    if (nameEl) nameEl.textContent = item.name;
    if (subEl) subEl.textContent = item.type === 'folder' ? 'Cloud Folder' : (item.mime_type || 'Binary file');
    if (typeEl) typeEl.textContent = item.type === 'folder' ? 'Directory / Folder' : `${UI.getFileTypeCategory(item.mime_type).toUpperCase()} (${item.mime_type || 'Unknown'})`;
    
    if (sizeEl) {
      if (item.type === 'folder') {
        sizeEl.textContent = '-';
      } else {
        sizeEl.textContent = UI.formatFileSize(item.size || 0);
      }
    }

    if (locEl) {
      if (this.breadcrumbs && this.breadcrumbs.length > 0) {
        locEl.textContent = this.breadcrumbs.map(b => b.name).join(' / ');
      } else {
        locEl.textContent = 'My Drive';
      }
    }

    // Exact upload & modified date with seconds
    if (createdEl) createdEl.textContent = UI.formatFullDateTime(item.created_at);
    if (updatedEl) updatedEl.textContent = UI.formatFullDateTime(item.updated_at || item.created_at);

    if (tgEl) {
      tgEl.textContent = item.discord_message_id ? `Message ID #${item.discord_message_id}` : 'N/A';
    }

    if (idEl) idEl.textContent = item.id;

    if (copyLinkBtn) {
      copyLinkBtn.style.display = item.type === 'file' ? 'inline-block' : 'none';
      copyLinkBtn.onclick = async () => {
        const url = window.location.origin + API.getStreamUrl(item.id);
        const success = await UI.copyToClipboard(url);
        if (success) {
          UI.showToast('Stream link copied to clipboard!', 'success');
        } else {
          UI.showToast('Failed to copy stream link', 'error');
        }
      };
    }

    UI.showModal('file-info-modal');
  },

  async openFolderInfoModal(folder) {
    if (!folder) return;
    this.selectedItem = folder;

    const nameEl = document.getElementById('info-folder-name');
    const typeEl = document.getElementById('info-folder-type');
    const filesCountEl = document.getElementById('info-folder-files-count');
    const sizeEl = document.getElementById('info-folder-size');
    const subfoldersCountEl = document.getElementById('info-folder-subfolders-count');
    const directItemsEl = document.getElementById('info-folder-direct-items');
    const locEl = document.getElementById('info-folder-location');
    const secEl = document.getElementById('info-folder-security');
    const createdEl = document.getElementById('info-folder-created');
    const idEl = document.getElementById('info-folder-id');

    if (nameEl) nameEl.textContent = folder.name;
    if (typeEl) typeEl.textContent = 'Folder / Directory';
    if (idEl) idEl.textContent = folder.id;
    if (createdEl) createdEl.textContent = folder.created_at ? UI.formatFullDateTime(folder.created_at) : '-';

    if (secEl) {
      if (folder.is_locked) {
        secEl.innerHTML = `<span class="badge-secure flat-icon-label" style="color: #ea4335; background: rgba(234, 67, 53, 0.1);">${UI.icon('lock', 14)} Password Protected</span>`;
      } else {
        secEl.innerHTML = `<span class="flat-icon-label" style="color: var(--text-secondary);">${UI.icon('unlock', 14)} Unlocked (No Password)</span>`;
      }
    }

    // Default loading state
    if (filesCountEl) filesCountEl.textContent = 'Calculating...';
    if (sizeEl) sizeEl.textContent = 'Calculating...';
    if (subfoldersCountEl) subfoldersCountEl.textContent = 'Calculating...';
    if (directItemsEl) directItemsEl.textContent = 'Calculating...';
    if (locEl) locEl.textContent = 'Loading path...';

    UI.showModal('folder-info-modal');

    try {
      const res = await API.getFolderStats(folder.id);
      if (res && res.stats) {
        const stats = res.stats;
        if (filesCountEl) {
          filesCountEl.textContent = `${stats.totalFiles} ${stats.totalFiles === 1 ? 'file' : 'files'}`;
        }
        if (sizeEl) {
          sizeEl.textContent = UI.formatFileSize(stats.totalSize || 0);
        }
        if (subfoldersCountEl) {
          subfoldersCountEl.textContent = `${stats.totalFolders} ${stats.totalFolders === 1 ? 'subfolder' : 'subfolders'}`;
        }
        if (directItemsEl) {
          directItemsEl.textContent = `${stats.directFiles} files, ${stats.directFolders} subfolders`;
        }
        if (locEl) {
          if (res.breadcrumbs && res.breadcrumbs.length > 0) {
            locEl.textContent = res.breadcrumbs.map(b => b.name).join(' / ');
          } else {
            locEl.textContent = 'My Drive';
          }
        }
      }
    } catch (err) {
      if (err && err.status === 403 && folder.is_locked) {
        [filesCountEl, sizeEl, subfoldersCountEl, directItemsEl].forEach(el => {
          if (el) el.innerHTML = `<span class="flat-icon-label">${UI.icon('lock', 14)} Unlock required</span>`;
        });
        if (locEl) locEl.textContent = folder.name;
        UI.showToast('Folder is password-protected. Unlock folder to view details.', 'info');
      } else {
        if (filesCountEl) filesCountEl.textContent = '0 files';
        if (sizeEl) sizeEl.textContent = '0 B';
        if (subfoldersCountEl) subfoldersCountEl.textContent = '0 subfolders';
        if (directItemsEl) directItemsEl.textContent = '0 items';
      }
    }
  },

  currentShareFile: null,

  async openShareModal(file) {
    if (!file) return;
    if (typeof file === 'string' || typeof file === 'number') {
      file = this.filesMap.get(String(file)) || { id: String(file), type: 'file', name: 'File' };
    } else if (file.item) {
      file = file.item;
    }
    if (file.type === 'folder') {
      UI.showToast('Only individual files can be shared publicly', 'info');
      return;
    }
    this.currentShareFile = file;

    const modalIcon = document.getElementById('share-modal-file-icon');
    const modalTitle = document.getElementById('share-modal-title');
    const modalSubtitle = document.getElementById('share-modal-subtitle');
    const accessSelect = document.getElementById('share-access-select');
    const publicSettings = document.getElementById('share-public-settings');
    const linkInput = document.getElementById('share-link-input');
    const copyBtnText = document.getElementById('copy-share-btn-text');
    const pwInput = document.getElementById('share-password-input');
    const pwStatus = document.getElementById('share-pw-status');
    const expSelect = document.getElementById('share-expiration-select');
    const expStatus = document.getElementById('share-expiry-status');
    const viewsEl = document.getElementById('share-stats-views');
    const dlsEl = document.getElementById('share-stats-downloads');
    const revokeBtn = document.getElementById('btn-revoke-share');
    const accessIcon = document.getElementById('share-access-icon-wrap');
    const accessHint = document.getElementById('share-access-hint');
    const btnRemovePw = document.getElementById('btn-remove-share-pw');

    const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
    const ICON_GLOBE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

    if (modalIcon) modalIcon.innerHTML = UI.getFileIconSvg(file.mime_type);
    if (modalTitle) modalTitle.textContent = `Share "${file.name || 'File'}"`;
    if (modalSubtitle) modalSubtitle.textContent = `${UI.formatFileSize(file.size || 0)} • ${file.mime_type || 'File'}`;

    // Reset default UI state & IMMEDIATELY make public options visible
    this.clearPasswordRequested = false;
    this.currentShareStatus = null;
    if (accessSelect) accessSelect.value = 'public';
    if (accessIcon) accessIcon.innerHTML = ICON_GLOBE;
    if (accessHint) accessHint.textContent = 'Anyone on the internet with this link can view and download';
    if (publicSettings) publicSettings.style.display = 'flex';
    if (linkInput) linkInput.value = 'Click "Save Changes" to generate public link';
    if (copyBtnText) copyBtnText.textContent = 'Copy link';
    if (pwInput) {
      pwInput.value = '';
      pwInput.type = 'password';
      pwInput.placeholder = 'Set a password or leave blank';
    }
    const customDaysWrap = document.getElementById('share-custom-days-wrap');
    const customDaysInput = document.getElementById('share-custom-days-input');
    if (customDaysWrap) customDaysWrap.style.display = 'none';
    if (customDaysInput) customDaysInput.value = '';
    if (expSelect) expSelect.value = 'never';
    if (expStatus) expStatus.textContent = '';
    if (viewsEl) viewsEl.textContent = '0';
    if (dlsEl) dlsEl.textContent = '0';
    if (revokeBtn) revokeBtn.style.display = 'none';

    // Show modal immediately
    UI.showModal('share-modal');
    this.initShareModal();

    try {
      const data = await API.getShareStatus(file.id);
      this.currentShareStatus = data;
      const isShared = Boolean(data.is_shared || data.isShared);

      if (isShared && (data.share_token || data.share_url)) {
        const shareToken = data.share_token || data.shareToken;
        const finalUrl = shareToken ? `${window.location.origin}/share/${shareToken}` : (data.share_url || '');
        if (linkInput) linkInput.value = finalUrl;
        if (accessSelect) accessSelect.value = 'public';
        if (accessIcon) accessIcon.innerHTML = ICON_GLOBE;
        if (publicSettings) publicSettings.style.display = 'flex';
        if (revokeBtn) revokeBtn.style.display = 'inline-flex';
      } else {
        if (linkInput) linkInput.value = 'Click "Save Changes" to generate public link';
        if (revokeBtn) revokeBtn.style.display = 'none';
      }

      if (pwStatus && pwInput) {
        if (data.has_password || data.hasPassword) {
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:#34a853;">${UI.icon('lock', 14)} Password protection is ACTIVE</span>`;
          pwInput.placeholder = 'Type new password to change (or leave blank)';
          if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
        } else {
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:var(--text-muted);">${UI.icon('unlock', 14)} No password protection</span>`;
          pwInput.placeholder = 'Set a password or leave blank';
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        }
      }

      if (expStatus && expSelect) {
        const expAt = data.share_expires_at || data.expiresAt;
        if (expAt) {
          const expDate = new Date(expAt);
          const now = new Date();
          const isExpired = expDate < now;
          const diffMs = expDate.getTime() - now.getTime();
          const diffDays = Math.max(1, Math.round(diffMs / (24 * 60 * 60 * 1000)));

          if ([1, 7, 30].includes(diffDays)) {
            expSelect.value = String(diffDays);
            if (customDaysWrap) customDaysWrap.style.display = 'none';
          } else {
            expSelect.value = 'custom';
            if (customDaysWrap) customDaysWrap.style.display = 'flex';
            if (customDaysInput) customDaysInput.value = diffDays;
          }

          expStatus.innerHTML = isExpired
            ? `<span class="flat-icon-label" style="color:#ea4335;">${UI.icon('warning', 14)} Expired on ${UI.formatFullDateTime(expAt)}</span>`
            : `<span style="color:#34a853;">● Active:</span> Expires on ${UI.formatFullDateTime(expAt)}`;
        } else {
          expSelect.value = 'never';
          if (customDaysWrap) customDaysWrap.style.display = 'none';
          expStatus.innerHTML = '<span style="color:var(--text-muted);">● Link never expires</span>';
        }
      }

      const viewsCount = (data.share_views !== undefined && data.share_views !== null) ? data.share_views : (data.views !== undefined ? data.views : 0);
      const dlsCount = (data.share_downloads !== undefined && data.share_downloads !== null) ? data.share_downloads : (data.downloads !== undefined ? data.downloads : 0);
      if (viewsEl) viewsEl.textContent = viewsCount;
      if (dlsEl) dlsEl.textContent = dlsCount;
    } catch (err) {
      console.warn('Share status load warning:', err);
    }
  },

  async refreshCurrentView(options = {}) {
    if (this.currentView === 'drive') {
      await this.loadFolderContents(this.currentFolderId, options);
    } else if (this.currentView === 'starred') {
      await this.loadStarredFiles(options);
    } else if (this.currentView === 'recent') {
      await this.loadRecentFiles(options);
    } else if (this.currentView === 'trash') {
      await this.loadTrashedFiles(this.currentFolderId, options);
    }
    this.loadStorageStats();
  },

  // ─── Event Listeners ───────────────────────────────────────────────
  initEventListeners() {
    // Login form submit
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById('login-email');
        const pwdInput = document.getElementById('login-password');
        const email = emailInput ? emailInput.value.trim() : '';
        const pwd = pwdInput ? pwdInput.value : '';
        const spinner = document.getElementById('login-spinner');
        const btn = document.getElementById('login-btn');

        if (!pwd || !pwd.trim()) {
          UI.showToast('Please enter your password', 'info');
          if (pwdInput) pwdInput.focus();
          return;
        }

        if (spinner) spinner.style.display = 'inline-block';
        if (btn) btn.disabled = true;

        try {
          const authData = await API.login(email, pwd);
          this.user = authData?.user || null;
          const adminLink = document.getElementById('sidebar-admin-center-link');
          if (adminLink) adminLink.style.display = this.user?.role === 'admin' ? 'flex' : 'none';
          if (authData?.preferences) {
            this.applyPreferences(authData.preferences);
          }
          UI.showToast('Login successful!', 'success');
          if (pwdInput) pwdInput.value = '';
          this.showScreen('app');
          // Load synced user preferences across devices
          await this.loadUserPreferences();
          const { view: targetView, folderId: targetFolder } = this.parseCurrentUrl();
          if (targetFolder && targetFolder !== 'null') {
            await this.navigateToFolder(targetFolder, true);
          } else if (targetView && targetView !== 'drive') {
            await this.navigateToView(targetView, true);
          } else {
            await this.navigateToFolder(null, true);
          }
          this.loadStorageStats();
        } catch (err) {
          UI.showToast(err.message || 'Invalid email or password', 'error');
          if (pwdInput) {
            pwdInput.focus();
            pwdInput.select();
          }
        } finally {
          if (spinner) spinner.style.display = 'none';
          if (btn) btn.disabled = false;
        }
      };
    }

    // Browser history popstate (Back/Forward buttons)
    window.addEventListener('popstate', async () => {
      if (this.user) {
        const { view, folderId } = this.parseCurrentUrl();
        if (folderId) {
          await this.navigateToFolder(folderId, false);
        } else if (view && view !== 'drive') {
          await this.navigateToView(view, false);
        } else {
          await this.navigateToFolder(null, false);
        }
      }
    });

    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        this.unlockedFolders.clear();
        sessionStorage.clear();
        try {
          window.history.replaceState({}, '', '/');
        } catch (e) {}
        await API.logout();
        UI.showToast('Logged out', 'info');
        this.showScreen('login');
      };
    }

    // Grid / List controls beside Sort by
    const setViewMode = (mode) => {
      if (mode !== 'grid' && mode !== 'list') return;
      this.viewMode = mode;
      this.saveUserPreference('view_mode', mode);
      this.renderContents();
    };
    const gridViewBtn = document.getElementById('view-grid-btn');
    const listViewBtn = document.getElementById('view-list-btn');
    if (gridViewBtn) gridViewBtn.onclick = () => setViewMode('grid');
    if (listViewBtn) listViewBtn.onclick = () => setViewMode('list');

    // Theme toggle buttons (Toolbar & Login Screen)
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.onclick = () => {
        this.toggleTheme();
      };
    }
    const loginThemeToggle = document.getElementById('login-theme-toggle');
    if (loginThemeToggle) {
      loginThemeToggle.onclick = () => this.toggleTheme();
    }

    // New Folder button
    const newFolderBtn = document.getElementById('new-folder-btn');
    if (newFolderBtn) {
      newFolderBtn.onclick = () => this.openCreateFolderModal();
    }

    // Empty Trash button
    const emptyTrashBtn = document.getElementById('btn-empty-trash');
    if (emptyTrashBtn) {
      emptyTrashBtn.onclick = async () => {
        const totalItems = (this.files?.length || 0) + (this.folders?.length || 0);
        if (totalItems === 0) {
          UI.showToast('Trash is already empty', 'info');
          return;
        }

        const count = totalItems;
        const confirmed = await UI.confirm({
          title: 'Empty Trash?',
          message: `Are you sure you want to permanently delete all ${count} item(s) in Trash?`,
          description: 'All items will be permanently erased from your cloud storage. This action cannot be undone.',
          icon: 'trash',
          confirmText: `Empty Trash (${count})`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          UI.showToast('Permanently deleting items from cloud...', 'info');
          this.emptyTrashLocally();
          const res = await API.emptyTrash();
          if (res && res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            UI.showToast(`Permanently deleted ${res?.count || count} item(s)`, 'success');
          }
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to empty trash: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    // Filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.onclick = () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeFilter = chip.getAttribute('data-type');
        this.renderContents();
      };
    });

    // Sort buttons
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.onclick = () => {
        const sort = btn.getAttribute('data-sort');
        if (this.sortBy === sort) {
          this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortBy = sort;
          this.sortOrder = (sort === 'date') ? 'desc' : 'asc';
        }
        this.saveUserPreferences({ sort_by: this.sortBy, sort_order: this.sortOrder });
        this.updateSortButtonsUI();
        this.renderContents();
      };
    });

    // Action Bar actions
    const actionDownload = document.getElementById('action-download');
    const actionShare = document.getElementById('action-share');
    const actionStar = document.getElementById('action-star');
    const actionMove = document.getElementById('action-move');
    const actionDelete = document.getElementById('action-delete');
    const actionRestore = document.getElementById('action-restore');
    const actionPermanentDelete = document.getElementById('action-permanent-delete');
    const actionSelectAll = document.getElementById('action-select-all');
    const actionBarClose = document.getElementById('action-bar-close');

    if (actionBarClose) actionBarClose.onclick = () => UI.clearSelection();

    if (actionSelectAll) {
      actionSelectAll.onclick = () => {
        const allItems = [...this.folders, ...this.files];
        UI.selectAll(allItems);
      };
    }

    if (actionShare) {
      actionShare.onclick = () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 1) {
          this.openShareModal(selectedFiles[0]);
        } else if (selectedFiles.length > 1) {
          UI.showToast('Select a single file to share', 'info');
        }
      };
    }

    if (actionDownload) {
      actionDownload.onclick = () => {
        const dcConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.discord?.connected !== false) : true;
        const tgConnected = typeof App !== 'undefined' && App.providersStatus ? (App.providersStatus.telegram?.connected !== false) : true;
        if (!dcConnected && !tgConnected) {
          UI.showToast('All storage providers (Discord and Telegram) are currently in Standby / Disabled mode. Please enable at least one provider in Settings to download.', 'error', 5000);
          return;
        }

        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 0) {
          UI.showToast('No files selected to download', 'info');
          return;
        }
        if (selectedFiles.length === 1) {
          UI.triggerDownload(API.getDownloadUrl(selectedFiles[0].id), selectedFiles[0].name);
        } else {
          UI.showToast(`Downloading ${selectedFiles.length} file(s)...`, 'info');
          selectedFiles.forEach((fileItem, idx) => {
            setTimeout(() => {
              const a = document.createElement('a');
              a.href = API.getDownloadUrl(fileItem.id);
              a.download = '';
              document.body.appendChild(a);
              a.click();
              a.remove();
            }, idx * 400);
          });
        }
      };
    }

    if (actionStar) {
      actionStar.onclick = async () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 0) {
          UI.showToast('Select files to star/unstar', 'info');
          return;
        }
        const allStarred = selectedFiles.every(f => {
          const file = this.filesMap.get(f.id);
          return file && file.is_starred === 1;
        });
        const newStarState = !allStarred;
        const fileIds = selectedFiles.map(f => f.id);
        try {
          await API.batchStar(fileIds, newStarState);
          UI.showToast(`${newStarState ? 'Starred' : 'Unstarred'} ${fileIds.length} file(s)`, 'success');
          UI.clearSelection();
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to update star state: ' + e.message, 'error');
        }
      };
    }

    if (actionMove) {
      actionMove.onclick = () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        if (selectedItems.length === 0) return;
        this.openMoveModal(selectedItems[0].item);
      };
    }

    if (actionDelete) {
      actionDelete.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        if (selectedItems.length === 0) return;
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selectedItems.filter(i => i.type === 'folder').map(i => i.id);
        const count = selectedItems.length;

        const confirmed = await UI.confirm({
          title: 'Move to Trash?',
          message: `Move ${count} selected item(s) to Trash?`,
          description: 'Items in Trash are safely kept and can be restored anytime within 30 days.',
          icon: 'trash',
          confirmText: `Move ${count} Item${count > 1 ? 's' : ''} to Trash`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          this.removeItemsLocally(selectedItems);
          await API.batchTrash(fileIds, folderIds);
          UI.showToast(`Moved ${count} item(s) to Trash`, 'success');
        } catch (e) {
          UI.showToast('Failed to trash items: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    if (actionRestore) {
      actionRestore.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selectedItems.filter(i => i.type === 'folder').map(i => i.id);
        if (fileIds.length === 0 && folderIds.length === 0) return;
        try {
          this.removeItemsLocally(selectedItems);
          await API.batchRestore(fileIds, folderIds);
          UI.showToast(`Restored ${selectedItems.length} item(s)`, 'success');
        } catch (e) {
          UI.showToast('Failed to restore items: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    if (actionPermanentDelete) {
      actionPermanentDelete.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selectedItems.filter(i => i.type === 'folder').map(i => i.id);
        const count = selectedItems.length;

        const confirmed = await UI.confirm({
          title: 'Permanently Delete Items?',
          message: `Permanently delete ${count} item(s) from cloud storage?`,
          description: 'This action cannot be undone. All file data and chunk parts will be completely removed from Telegram, Discord, and database.',
          icon: 'danger',
          confirmText: `Delete Permanently (${count})`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          this.removeItemsLocally(selectedItems);
          const res = await API.batchDelete(fileIds, folderIds);
          if (res && res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            const deletedTotal = (res?.deletedFilesCount || 0) + (res?.deletedFoldersCount || 0);
            UI.showToast(`Permanently deleted ${deletedTotal || count} item(s) from cloud`, 'success');
          }
          this.loadStorageStats();
        } catch (e) {
          UI.showToast('Failed to permanently delete items: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }
  },

  initSidebar() {
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (sidebarToggle && sidebar && overlay) {
      sidebarToggle.onclick = () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
      };
      overlay.onclick = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      };
    }

    const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
    if (sidebarCloseBtn && sidebar && overlay) {
      sidebarCloseBtn.onclick = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      };
    }

    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
      item.onclick = (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) {
          this.navigateToView(view);
          if (sidebar) sidebar.classList.remove('open');
          if (overlay) overlay.classList.remove('open');
        }
      };
    });

    const storageCard = document.getElementById('sidebar-storage-card');
    if (storageCard) {
      storageCard.onclick = () => {
        this.openStorageAnalyticsModal();
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
      };
    }
  },

  initBottomNav() {
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
      item.onclick = (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) this.navigateToView(view);
      };
    });
  },

  initSearch() {
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear');
    let timeout = null;

    if (searchInput) {
      const performSearch = async () => {
        const query = searchInput.value.trim();
        if (clearBtn) clearBtn.style.display = query ? 'flex' : 'none';

        if (!query) {
          if (this.currentView === 'trash') {
            this.loadTrashedFiles(this.currentFolderId);
          } else if (this.currentView === 'starred') {
            this.loadStarredFiles();
          } else if (this.currentView === 'recent') {
            this.loadRecentFiles();
          } else {
            this.navigateToFolder(this.currentFolderId);
          }
          return;
        }

        const reqId = ++this._navReqCounter;
        UI.showSkeletons();
        try {
          const isTrashView = (this.currentView === 'trash');
          const isStarredView = (this.currentView === 'starred');
          const isRecentView = (this.currentView === 'recent');

          const [folderData, fileData] = await Promise.all([
            isTrashView
              ? API.getFolders({ trashed: true, search: query }).catch(() => ({ folders: [] }))
              : (isStarredView || isRecentView)
                ? Promise.resolve({ folders: [] })
                : API.getFolderContents(null, query).catch(() => ({ folders: [] })),
            API.getFiles({
              search: query,
              trashed: isTrashView ? true : undefined,
              starred: isStarredView ? true : undefined,
              recent: isRecentView ? true : undefined
            }).catch(() => [])
          ]);

          if (reqId !== this._navReqCounter) return;
          const matchedFolders = Array.isArray(folderData) ? folderData : ((folderData && folderData.folders) ? folderData.folders : []);
          const filesFromFolder = (folderData && Array.isArray(folderData.files)) ? folderData.files : [];
          const filesFromApi = Array.isArray(fileData) ? fileData : [];
          const fileMap = new Map();
          filesFromFolder.forEach(f => { if (f && f.id) fileMap.set(String(f.id), f); });
          filesFromApi.forEach(f => { if (f && f.id) fileMap.set(String(f.id), f); });

          this.folders = matchedFolders;
          this.files = Array.from(fileMap.values());
          this.breadcrumbs = [{ id: null, name: isTrashView ? `Trash Search: "${query}"` : `Search: "${query}"` }];
          this.renderContents();
          UI.renderBreadcrumbs(this.breadcrumbs);
        } catch (e) {
          console.warn('[Search] Error executing search:', e);
        } finally {
          if (reqId === this._navReqCounter) {
            UI.hideSkeletons();
          }
        }
      };

      searchInput.oninput = () => {
        const query = searchInput.value.trim();
        if (clearBtn) clearBtn.style.display = query ? 'flex' : 'none';
        clearTimeout(timeout);
        timeout = setTimeout(performSearch, 250);
      };

      searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(timeout);
          performSearch();
        } else if (e.key === 'Escape') {
          searchInput.value = '';
          if (clearBtn) clearBtn.style.display = 'none';
          clearTimeout(timeout);
          performSearch();
        }
      };
    }

    if (clearBtn) {
      clearBtn.onclick = () => {
        if (searchInput) searchInput.value = '';
        clearBtn.style.display = 'none';
        if (this.currentView === 'trash') {
          this.loadTrashedFiles(this.currentFolderId);
        } else if (this.currentView === 'starred') {
          this.loadStarredFiles();
        } else if (this.currentView === 'recent') {
          this.loadRecentFiles();
        } else {
          this.navigateToFolder(this.currentFolderId);
        }
      };
    }
  },

  initContextMenu() {
    const menu = document.getElementById('context-menu');
    document.addEventListener('click', () => {
      if (menu) menu.style.display = 'none';
    });

    if (menu) {
      menu.querySelectorAll('.context-item').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const action = btn.getAttribute('data-action');
          menu.style.display = 'none';
          if (action && this.selectedItem) {
            this.handleItemAction(action, this.selectedItem);
          }
        };
      });
    }
  },

  initModals() {
    document.querySelectorAll('[data-modal-cancel]').forEach(btn => {
      btn.onclick = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        const parentModal = btn.closest('.modal');
        if (parentModal && parentModal.id) {
          UI.hideModal(parentModal.id);
        } else {
          UI.hideAllModals();
        }
      };
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      overlay.onclick = () => {
        const subModalIds = ['edit-user-modal', 'create-user-modal', 'reset-user-password-modal', 'custom-confirm-modal', 'remote-upload-modal'];
        const openSubModal = subModalIds.find(id => {
          const el = document.getElementById(id);
          return el && el.classList.contains('visible') && el.style.display !== 'none';
        });
        if (openSubModal) {
          UI.hideModal(openSubModal);
        } else {
          UI.hideAllModals();
        }
      };
    }

    // Create Folder confirm
    const createFolderConfirm = document.getElementById('create-folder-confirm');
    const folderNameInput = document.getElementById('folder-name-input');
    if (createFolderConfirm && folderNameInput) {
      const handleCreateFolder = async () => {
        const name = folderNameInput.value.trim();
        if (!name) return;
        try {
          const res = await API.createFolder(name, this.currentFolderId);
          UI.showToast(`Folder "${name}" created`, 'success');
          UI.hideAllModals();
          const createdFolder = (res && res.folder) ? res.folder : res;
          if (createdFolder && createdFolder.id) {
            this.addUploadedFolderLocally(createdFolder);
          }
        } catch (e) {
          UI.showToast('Could not create folder: ' + e.message, 'error');
        }
      };

      createFolderConfirm.onclick = handleCreateFolder;
      folderNameInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleCreateFolder();
        }
      };
    }

    // Rename confirm
    const renameConfirm = document.getElementById('rename-confirm');
    const renameInput = document.getElementById('rename-input');
    if (renameConfirm && renameInput) {
      renameConfirm.onclick = async () => {
        const newName = renameInput.value.trim();
        if (!newName || !this.selectedItem) return;
        try {
          if (this.selectedItem.type === 'folder') {
            await API.renameFolder(this.selectedItem.id, newName);
          } else {
            await API.renameFile(this.selectedItem.id, newName);
          }
          UI.showToast('Renamed successfully', 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Rename failed: ' + e.message, 'error');
        }
      };
    }

    // Move confirm
    const moveConfirm = document.getElementById('move-confirm');
    if (moveConfirm) {
      moveConfirm.onclick = async () => {
        if (this.targetMoveFolderId === undefined) return;
        const selectedList = Array.from(UI.selectedItems.values());

        if (selectedList.length > 0) {
          const fileIds = selectedList.filter(i => i.type === 'file').map(i => i.id);
          const folderIds = selectedList.filter(i => i.type === 'folder').map(i => i.id);
          try {
            await API.batchMove(fileIds, folderIds, this.targetMoveFolderId);
            UI.showToast(`Moved ${selectedList.length} item(s)`, 'success');
            UI.clearSelection();
            UI.hideAllModals();
            this.refreshCurrentView();
          } catch (e) {
            UI.showToast('Batch move failed: ' + e.message, 'error');
          }
          return;
        }

        if (!this.selectedItem) return;
        try {
          if (this.selectedItem.type === 'folder') {
            await API.moveFolder(this.selectedItem.id, this.targetMoveFolderId);
          } else {
            await API.moveFile(this.selectedItem.id, this.targetMoveFolderId);
          }
          UI.showToast('Item moved', 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Move failed: ' + e.message, 'error');
        }
      };
    }

    // Lock folder confirm
    const formLock = document.getElementById('form-lock-folder');
    const btnConfirmLock = document.getElementById('btn-confirm-lock-folder');
    const handleLockSubmit = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pass = document.getElementById('lock-folder-pass')?.value;
      const confirmPass = document.getElementById('lock-folder-confirm-pass')?.value;
      if (!pass || pass.length < 3) {
        return UI.showToast('Folder password must be at least 3 characters', 'warning');
      }
      if (pass !== confirmPass) {
        return UI.showToast('Passwords do not match', 'error');
      }
      if (!this.selectedItem || this.selectedItem.type !== 'folder') return;
      try {
        if (btnConfirmLock) btnConfirmLock.disabled = true;
        await API.lockFolder(this.selectedItem.id, pass);
        const fid = String(this.selectedItem.id);
        this.unlockedFolders.delete(fid);
        try {
          sessionStorage.removeItem('discorddrive_unlocked_' + fid);
        } catch (err) {}
        UI.showToast(`Folder "${this.selectedItem.name}" locked successfully`, 'success');
        UI.hideAllModals();
        this.refreshCurrentView();
      } catch (err) {
        UI.showToast('Failed to lock folder: ' + err.message, 'error');
      } finally {
        if (btnConfirmLock) btnConfirmLock.disabled = false;
      }
    };
    if (formLock) formLock.onsubmit = handleLockSubmit;
    if (btnConfirmLock) btnConfirmLock.onclick = handleLockSubmit;

    // Unlock folder confirm
    const formUnlock = document.getElementById('form-unlock-folder');
    const btnConfirmUnlock = document.getElementById('btn-confirm-unlock-folder');
    const handleUnlockSubmit = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pass = document.getElementById('unlock-folder-pass')?.value;
      if (!pass) {
        return UI.showToast('Please enter the folder password', 'warning');
      }
      const targetFolder = this.pendingUnlockFolder || this.selectedItem;
      if (!targetFolder) return;

      try {
        if (btnConfirmUnlock) btnConfirmUnlock.disabled = true;
        await API.verifyFolderLock(targetFolder.id, pass);
        const fid = String(targetFolder.id);
        this.unlockedFolders.add(fid);
        try {
          sessionStorage.setItem('discorddrive_unlocked_' + fid, '1');
        } catch (err) {}
        UI.showToast('Folder unlocked!', 'success');
        UI.hideAllModals();

        if (this.isManagingLock) {
          this.selectedItem = targetFolder;
          this.openLockFolderModal(targetFolder);
        } else {
          this.navigateToFolder(targetFolder.id);
        }
      } catch (err) {
        UI.showToast(err.message || 'Incorrect folder password', 'error');
      } finally {
        if (btnConfirmUnlock) btnConfirmUnlock.disabled = false;
      }
    };
    if (formUnlock) formUnlock.onsubmit = handleUnlockSubmit;
    if (btnConfirmUnlock) btnConfirmUnlock.onclick = handleUnlockSubmit;

    // Remove lock permanently
    const btnRemoveLock = document.getElementById('btn-remove-lock');
    if (btnRemoveLock) {
      btnRemoveLock.onclick = async (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        const pass = document.getElementById('unlock-folder-pass')?.value;
        if (!pass) {
          return UI.showToast('Enter current password to remove lock', 'warning');
        }
        const targetFolder = this.pendingUnlockFolder || this.selectedItem;
        if (!targetFolder) return;

        try {
          btnRemoveLock.disabled = true;
          await API.unlockFolderPermanently(targetFolder.id, pass);
          const fid = String(targetFolder.id);
          this.unlockedFolders.delete(fid);
          try {
            sessionStorage.removeItem('discorddrive_unlocked_' + fid);
          } catch (err) {}
          UI.showToast(`Lock removed from "${targetFolder.name}"`, 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (err) {
          UI.showToast('Failed to remove lock: ' + err.message, 'error');
        } finally {
          btnRemoveLock.disabled = false;
        }
      };
    }

    // Permanent Delete confirm
    const deleteConfirm = document.getElementById('delete-confirm');
    if (deleteConfirm) {
      deleteConfirm.onclick = async () => {
        if (!this.selectedItem) return;
        const targetItem = this.selectedItem;
        UI.hideAllModals();
        try {
          UI.showToast('Deleting permanently from Telegram...', 'info');
          if (targetItem.type === 'folder') {
            await API.deleteFolder(targetItem.id, true);
          } else {
            const res = await API.permanentDeleteFile(targetItem.id);
            if (res && res.error) {
              throw new Error(res.error);
            }
          }
          UI.showToast('Permanently deleted from Discord', 'success');
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Delete failed: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }
  },

  initShareModal() {
    const accessSelect = document.getElementById('share-access-select');
    const accessIcon = document.getElementById('share-access-icon-wrap');
    const accessHint = document.getElementById('share-access-hint');
    const publicSettings = document.getElementById('share-public-settings');
    const linkInput = document.getElementById('share-link-input');
    const copyBtn = document.getElementById('btn-copy-share-link');
    const copyBtnText = document.getElementById('copy-share-btn-text');
    const pwToggleBtn = document.getElementById('share-toggle-pw');
    const pwInput = document.getElementById('share-password-input');
    const expSelect = document.getElementById('share-expiration-select');
    const expStatus = document.getElementById('share-expiry-status');
    const saveBtn = document.getElementById('btn-save-share');
    const revokeBtn = document.getElementById('btn-revoke-share');

    if (accessSelect) {
      accessSelect.onchange = () => {
        const isPublic = accessSelect.value === 'public';
        const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
        const ICON_GLOBE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
        if (accessIcon) accessIcon.innerHTML = isPublic ? ICON_GLOBE : ICON_LOCK;
        if (accessHint) {
          accessHint.textContent = isPublic
            ? 'Anyone on the internet with this link can view and download'
            : 'Only people logged into CloudDrive can access this file';
        }
        if (publicSettings) {
          publicSettings.style.display = isPublic ? 'block' : 'none';
        }
        if (isPublic && (!linkInput.value || linkInput.value.includes('Loading'))) {
          linkInput.value = 'Click "Save Changes" to generate public link';
        }
      };
    }

    if (copyBtn && linkInput) {
      copyBtn.onclick = async () => {
        const url = linkInput.value.trim();
        if (!url || url.startsWith('Click') || url.startsWith('Loading')) {
          UI.showToast('Please save changes first to get active link', 'info');
          return;
        }
        const success = await UI.copyToClipboard(url, linkInput);
        if (success) {
          if (copyBtnText) copyBtnText.textContent = 'Copied!';
          UI.showToast('Share link copied to clipboard!', 'success');
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy link';
          }, 2000);
        } else {
          UI.showToast('Failed to copy share link', 'error');
        }
      };
    }

    const btnRemovePw = document.getElementById('btn-remove-share-pw');
    const pwStatus = document.getElementById('share-pw-status');

    if (btnRemovePw && pwInput && pwStatus) {
      btnRemovePw.onclick = () => {
        this.clearPasswordRequested = true;
        pwInput.value = '';
        pwInput.placeholder = 'Password will be removed upon saving';
        pwStatus.innerHTML = `<span class="flat-icon-label" style="color:#ea4335;">${UI.icon('trash', 14)} Password will be REMOVED when you click "Save Changes"</span>`;
        btnRemovePw.style.display = 'none';
      };
    }

    if (pwInput && pwStatus) {
      pwInput.oninput = () => {
        if (pwInput.value.trim() !== '') {
          this.clearPasswordRequested = false;
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:var(--primary-color);">${UI.icon('key', 14)} New password:</span> Will be saved upon clicking "Save Changes"`;
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        } else if (this.clearPasswordRequested) {
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:#ea4335;">${UI.icon('trash', 14)} Password will be REMOVED when you click "Save Changes"</span>`;
        } else if (this.currentShareStatus && this.currentShareStatus.has_password) {
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:#34a853;">${UI.icon('lock', 14)} Password protection is ACTIVE</span>`;
          if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
        } else {
          pwStatus.innerHTML = `<span class="flat-icon-label" style="color:var(--text-muted);">${UI.icon('unlock', 14)} No password protection</span>`;
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        }
      };
    }

    const customDaysWrap = document.getElementById('share-custom-days-wrap');
    const customDaysInput = document.getElementById('share-custom-days-input');

    if (expSelect && expStatus) {
      const updateExpirationPreview = () => {
        const val = expSelect.value;
        if (val === 'never') {
          if (customDaysWrap) customDaysWrap.style.display = 'none';
          expStatus.innerHTML = '<span style="color:var(--text-muted);">● Link will not expire</span>';
        } else if (val === 'custom') {
          if (customDaysWrap) customDaysWrap.style.display = 'flex';
          const days = customDaysInput ? parseInt(customDaysInput.value, 10) : NaN;
          if (!isNaN(days) && days > 0) {
            const d = new Date(Date.now() + days * 86400000);
            expStatus.innerHTML = `<span style="color:var(--primary-color);">● Will expire on:</span> ${UI.formatFullDateTime(d.toISOString())}`;
          } else {
            expStatus.innerHTML = '<span style="color:var(--text-secondary);">● Enter number of days (1-365)</span>';
          }
        } else {
          if (customDaysWrap) customDaysWrap.style.display = 'none';
          const d = new Date(Date.now() + Number(val) * 86400000);
          expStatus.innerHTML = `<span style="color:var(--primary-color);">● Will expire on:</span> ${UI.formatFullDateTime(d.toISOString())}`;
        }
      };

      expSelect.onchange = () => {
        updateExpirationPreview();
        if (expSelect.value === 'custom' && customDaysInput) {
          customDaysInput.focus();
        }
      };

      if (customDaysInput) {
        customDaysInput.oninput = () => {
          if (expSelect.value === 'custom') {
            updateExpirationPreview();
          }
        };
      }
    }

    if (pwToggleBtn && pwInput) {
      const ICON_EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

      pwToggleBtn.onclick = () => {
        if (pwInput.type === 'password') {
          pwInput.type = 'text';
          pwToggleBtn.innerHTML = ICON_EYE_OFF;
        } else {
          pwInput.type = 'password';
          pwToggleBtn.innerHTML = ICON_EYE;
        }
      };
    }

    if (saveBtn) {
      saveBtn.onclick = async () => {
        if (!this.currentShareFile || !this.currentShareFile.id) {
          UI.showToast('No active file selected to share. Please re-open the share dialog.', 'warning');
          return;
        }
        const isShared = accessSelect ? accessSelect.value === 'public' : true;
        const password = pwInput ? pwInput.value.trim() : '';
        const expVal = expSelect ? expSelect.value : 'never';
        let expiresInDays = null;
        if (expVal === 'never') {
          expiresInDays = null;
        } else if (expVal === 'custom') {
          const customDays = customDaysInput ? parseInt(customDaysInput.value, 10) : NaN;
          if (isNaN(customDays) || customDays <= 0 || customDays > 365) {
            UI.showToast('Please enter a valid number of days between 1 and 365', 'warning');
            if (customDaysInput) customDaysInput.focus();
            return;
          }
          expiresInDays = customDays;
        } else {
          expiresInDays = parseInt(expVal, 10);
        }

        const payload = {
          is_shared: isShared,
          expires_in_days: expiresInDays
        };

        if (this.clearPasswordRequested) {
          payload.clear_password = true;
          payload.password = null;
        } else if (password) {
          payload.password = password;
        } else if (!this.currentShareStatus || !this.currentShareStatus.has_password) {
          payload.clear_password = true;
          payload.password = null;
        }

        try {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          const data = await API.updateShareStatus(this.currentShareFile.id, payload);
          this.currentShareStatus = data;
          this.clearPasswordRequested = false;

          // Update UI directly with accurate window.location.origin URL
          const shareToken = data.share_token || data.shareToken;
          const finalUrl = shareToken
            ? `${window.location.origin}/share/${shareToken}`
            : (data.share_url || data.shareUrl || '');

          if (linkInput) {
            linkInput.value = isShared ? finalUrl : '';
          }

          if (this.currentShareFile) {
            this.currentShareFile.is_shared = isShared ? 1 : 0;
            this.currentShareFile.share_token = shareToken;
            const mapped = this.filesMap.get(String(this.currentShareFile.id));
            if (mapped) {
              mapped.is_shared = isShared ? 1 : 0;
              mapped.share_token = shareToken;
            }
            this.renderContents();
          }

          const btnRemovePw = document.getElementById('btn-remove-share-pw');
          if (pwStatus && pwInput) {
            if (data.has_password) {
              pwStatus.innerHTML = `<span class="flat-icon-label" style="color:#34a853;">${UI.icon('lock', 14)} Password protection is ACTIVE</span>`;
              pwInput.value = '';
              pwInput.placeholder = 'Type new password to change (or leave blank)';
              if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
            } else {
              pwStatus.innerHTML = `<span class="flat-icon-label" style="color:var(--text-muted);">${UI.icon('unlock', 14)} No password protection</span>`;
              pwInput.value = '';
              pwInput.placeholder = 'Set a password or leave blank';
              if (btnRemovePw) btnRemovePw.style.display = 'none';
            }
          }

          if (revokeBtn) {
            revokeBtn.style.display = isShared ? 'inline-flex' : 'none';
          }

          if (publicSettings) {
            publicSettings.style.display = isShared ? 'flex' : 'none';
          }

          const viewsEl = document.getElementById('share-stats-views');
          const dlsEl = document.getElementById('share-stats-downloads');
          const finalViews = (data.share_views !== undefined && data.share_views !== null) ? data.share_views : (data.views !== undefined ? data.views : 0);
          const finalDls = (data.share_downloads !== undefined && data.share_downloads !== null) ? data.share_downloads : (data.downloads !== undefined ? data.downloads : 0);
          if (viewsEl) viewsEl.textContent = finalViews;
          if (dlsEl) dlsEl.textContent = finalDls;

          UI.showToast(isShared ? 'Public share link generated & saved!' : 'File is now restricted', 'success');
        } catch (err) {
          console.error('[Share] Save share error:', err);
          UI.showToast('Failed to save share settings: ' + (err.message || 'Error'), 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      };
    }

    if (revokeBtn) {
      revokeBtn.onclick = async () => {
        if (!this.currentShareFile) return;
        const confirmed = await UI.confirm({
          title: 'Turn Off Sharing?',
          message: `Are you sure you want to stop sharing "${this.currentShareFile.name}"?`,
          description: 'Any existing links will stop working immediately. Nobody outside CloudDrive will be able to access this file.',
          icon: 'lock',
          confirmText: 'Turn Off Sharing',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });
        if (!confirmed) return;

        try {
          revokeBtn.disabled = true;
          await API.revokeShare(this.currentShareFile.id);
          
          const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
          if (accessSelect) accessSelect.value = 'restricted';
          if (accessIcon) accessIcon.innerHTML = ICON_LOCK;
          if (accessHint) accessHint.textContent = 'Only people logged into CloudDrive can access this file';
          if (publicSettings) publicSettings.style.display = 'none';
          if (revokeBtn) revokeBtn.style.display = 'none';
          if (linkInput) linkInput.value = '';
          if (this.currentShareFile) {
            this.currentShareFile.is_shared = 0;
            const mapped = this.filesMap.get(String(this.currentShareFile.id));
            if (mapped) mapped.is_shared = 0;
            this.renderContents();
          }
          this.currentShareStatus = { is_shared: false };

          UI.showToast('Public link revoked successfully', 'info');
        } catch (err) {
          UI.showToast('Failed to revoke link: ' + err.message, 'error');
        } finally {
          revokeBtn.disabled = false;
        }
      };
    }
  },

  initUpload() {
    if (typeof Upload !== 'undefined' && Upload.init) {
      Upload.init();
    }

    const uploadBtn = document.getElementById('upload-btn');
    const dropdownMenu = document.getElementById('upload-dropdown-menu');
    const btnUploadFile = document.getElementById('btn-upload-file');
    const btnUploadFolder = document.getElementById('btn-upload-folder');
    const fabUpload = document.getElementById('fab-upload');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    // Toggle dropdown menu on "New Upload" button click
    if (uploadBtn) {
      uploadBtn.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) {
          const isHidden = dropdownMenu.style.display === 'none' || !dropdownMenu.style.display;
          dropdownMenu.style.display = isHidden ? 'flex' : 'none';
        } else if (fileInput) {
          fileInput.click();
        }
      };
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (dropdownMenu && dropdownMenu.style.display !== 'none') {
        if (!dropdownMenu.contains(e.target) && !uploadBtn.contains(e.target)) {
          dropdownMenu.style.display = 'none';
        }
      }
    });

    // Option 1: Upload Files
    if (btnUploadFile) {
      btnUploadFile.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (fileInput) fileInput.click();
      };
    }

    // Option 2: Upload Folder
    if (btnUploadFolder) {
      btnUploadFolder.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (folderInput) folderInput.click();
      };
    }

    // Option 3: Remote URL Upload
    const btnRemoteUpload = document.getElementById('btn-remote-upload');
    if (btnRemoteUpload) {
      btnRemoteUpload.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        UI.showModal('remote-upload-modal');
        const urlInput = document.getElementById('remote-url-input');
        if (urlInput) {
          urlInput.value = '';
          setTimeout(() => urlInput.focus(), 100);
        }
        const fnInput = document.getElementById('remote-filename-input');
        if (fnInput) fnInput.value = '';
      };
    }

    // Remote URL Form Submit
    const formRemoteUpload = document.getElementById('form-remote-upload');
    if (formRemoteUpload) {
      formRemoteUpload.onsubmit = async (e) => {
        e.preventDefault();
        const url = document.getElementById('remote-url-input')?.value?.trim();
        const fileName = document.getElementById('remote-filename-input')?.value?.trim();
        if (!url) return;

        const btn = document.getElementById('btn-submit-remote-upload');
        if (btn) btn.disabled = true;

        try {
          const res = await Upload.startRemoteDownload(url, fileName, App.currentFolderId);
          UI.hideModal('remote-upload-modal');
          if (res && res.isFolder) {
            UI.showToast(res.message || `Discovered folder "${res.folderName}" with ${res.totalFiles} files. Downloads queued!`, 'success');
            if (typeof App.loadFolder === 'function') {
              App.loadFolder(App.currentFolderId);
            }
          } else {
            UI.showToast('Remote download started on VPS', 'info');
          }
        } catch (err) {
          UI.showToast(err.message || 'Failed to start remote download', 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      };
    }

    // Mobile Bottom Sheet Elements
    const mobileSheet = document.getElementById('mobile-upload-sheet');
    const mobileOverlay = document.getElementById('mobile-upload-overlay');
    const mobileBtnUploadFile = document.getElementById('mobile-btn-upload-file');
    const mobileBtnCreateFolder = document.getElementById('mobile-btn-create-folder');
    const mobileBtnRemoteUpload = document.getElementById('mobile-btn-remote-upload');
    const mobileBtnUploadFolder = document.getElementById('mobile-btn-upload-folder');

    const openMobileSheet = () => {
      if (mobileSheet && mobileOverlay) {
        mobileSheet.style.display = 'flex';
        mobileOverlay.style.display = 'block';
        requestAnimationFrame(() => {
          mobileSheet.classList.add('open');
          mobileOverlay.classList.add('open');
        });
      } else if (fileInput) {
        fileInput.click();
      }
    };

    const closeMobileSheet = () => {
      if (mobileSheet && mobileOverlay) {
        mobileSheet.classList.remove('open');
        mobileOverlay.classList.remove('open');
        setTimeout(() => {
          if (!mobileSheet.classList.contains('open')) {
            mobileSheet.style.display = 'none';
            mobileOverlay.style.display = 'none';
          }
        }, 280);
      }
    };

    if (mobileOverlay) {
      mobileOverlay.onclick = closeMobileSheet;
    }

    // Mobile FAB button
    if (fabUpload) {
      fabUpload.onclick = (e) => {
        e.stopPropagation();
        openMobileSheet();
      };
    }

    if (mobileBtnUploadFile) {
      mobileBtnUploadFile.onclick = (e) => {
        e.stopPropagation();
        closeMobileSheet();
        if (fileInput) fileInput.click();
      };
    }

    if (mobileBtnCreateFolder) {
      mobileBtnCreateFolder.onclick = (e) => {
        e.stopPropagation();
        closeMobileSheet();
        UI.showModal('create-folder-modal');
        const folderInputEl = document.getElementById('folder-name-input');
        if (folderInputEl) {
          folderInputEl.value = '';
          setTimeout(() => folderInputEl.focus(), 150);
        }
      };
    }

    if (mobileBtnRemoteUpload) {
      mobileBtnRemoteUpload.onclick = (e) => {
        e.stopPropagation();
        closeMobileSheet();
        UI.showModal('remote-upload-modal');
        const urlInput = document.getElementById('remote-url-input');
        if (urlInput) {
          urlInput.value = '';
          setTimeout(() => urlInput.focus(), 150);
        }
      };
    }

    if (mobileBtnUploadFolder) {
      mobileBtnUploadFolder.onclick = (e) => {
        e.stopPropagation();
        closeMobileSheet();
        if (folderInput) folderInput.click();
      };
    }

    // Multi-file selection change
    if (fileInput) {
      fileInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const files = Array.from(e.target.files);
          fileInput.value = '';
          await Upload.addFiles(files, this.currentFolderId);
        }
      };
    }

    // Folder selection change
    if (folderInput) {
      folderInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          const files = Array.from(e.target.files);
          folderInput.value = '';
          await Upload.addFiles(files, this.currentFolderId);
        }
      };
    }

    // Drag and Drop
    Upload.initDragDrop();
  },

  openCreateFolderModal() {
    const input = document.getElementById('folder-name-input');
    if (input) input.value = '';
    UI.showModal('create-folder-modal');
    setTimeout(() => input && input.focus(), 100);
  },

  openRenameModal(item) {
    this.selectedItem = item;
    const input = document.getElementById('rename-input');
    if (input) input.value = item.name;
    UI.showModal('rename-modal');
    setTimeout(() => input && input.focus(), 100);
  },

  async openMoveModal(item) {
    this.selectedItem = item;
    this.targetMoveFolderId = null;
    const treeContainer = document.getElementById('folder-tree');
    if (treeContainer) {
      treeContainer.innerHTML = '<div class="loading-spinner"></div>';
      UI.showModal('move-modal');
      try {
        const tree = await API.getFolderTree();
        UI.renderFolderTreeCompact(treeContainer, tree, (selectedFolderId) => {
          this.targetMoveFolderId = selectedFolderId;
        });
      } catch (e) {
        treeContainer.innerHTML = '<p class="error-text">Failed to load folders</p>';
      }
    }
  },

  openLockFolderModal(folder) {
    if (!folder) return;
    this.selectedItem = folder;
    const titleEl = document.getElementById('lock-modal-title');
    if (titleEl) titleEl.textContent = `Lock "${folder.name}"`;
    const passInput = document.getElementById('lock-folder-pass');
    const confirmInput = document.getElementById('lock-folder-confirm-pass');
    if (passInput) passInput.value = '';
    if (confirmInput) confirmInput.value = '';
    UI.showModal('lock-folder-modal');
    setTimeout(() => { if (passInput) passInput.focus(); }, 100);
  },

  openUnlockFolderModal(folder, isManagingLock = false) {
    if (!folder) return;
    this.pendingUnlockFolder = folder;
    this.isManagingLock = isManagingLock;
    const titleEl = document.getElementById('unlock-modal-title');
    const subEl = document.getElementById('unlock-modal-sub');
    const removeLockBtn = document.getElementById('btn-remove-lock');
    const unlockPassInput = document.getElementById('unlock-folder-pass');

    if (titleEl) titleEl.textContent = `Protected: "${folder.name}"`;
    if (subEl) subEl.textContent = isManagingLock ? 'Enter password to change or remove lock' : 'Enter folder password to unlock and access contents';
    if (removeLockBtn) removeLockBtn.style.display = isManagingLock ? 'inline-flex' : 'none';
    if (unlockPassInput) unlockPassInput.value = '';

    UI.showModal('unlock-folder-modal');
    setTimeout(() => { if (unlockPassInput) unlockPassInput.focus(); }, 100);
  },

  relockFolder(folderId) {
    if (!folderId) return;
    const fid = String(folderId);
    this.unlockedFolders.delete(fid);
    delete API.folderTokens[fid];
    try {
      sessionStorage.removeItem('discorddrive_unlocked_' + fid);
      sessionStorage.removeItem('discorddrive_ftok_' + fid);
    } catch (e) {}

    UI.showToast('Folder locked', 'info');

    if (this.currentFolderId === fid) {
      let parentId = null;
      if (this.breadcrumbs && this.breadcrumbs.length >= 2) {
        parentId = this.breadcrumbs[this.breadcrumbs.length - 2].id;
      }
      this.navigateToFolder(parentId);
    } else {
      this.refreshCurrentView();
    }
  },

  async openDeleteModal(item) {
    if (!item) return;
    this.selectedItem = item;
    const isFolder = item.type === 'folder';

    const confirmed = await UI.confirm({
      title: isFolder ? 'Permanently Delete Folder?' : 'Permanently Delete File?',
      message: `Permanently delete "${item.name}" from cloud storage?`,
      description: 'This action cannot be undone. All file data and chunk parts will be completely removed from Telegram, Discord, and database.',
      icon: 'danger',
      confirmText: 'Delete Permanently',
      confirmType: 'danger',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      this.removeItemsLocally([item]);
      if (isFolder) {
        await API.deleteFolder(item.id, true);
      } else {
        const res = await API.permanentDeleteFile(item.id);
        if (res && res.error) {
          throw new Error(res.error);
        }
      }
      UI.showToast('Permanently deleted from cloud', 'success');
      this.loadStorageStats();
    } catch (e) {
      UI.showToast('Delete failed: ' + e.message, 'error');
      await this.refreshCurrentView();
    }
  },

  initSettings() {
    // Open Settings button in sidebar
    const sidebarSettingsLink = document.getElementById('sidebar-settings-link');
    if (sidebarSettingsLink) {
      sidebarSettingsLink.onclick = (e) => {
        e.preventDefault();
        this.openSettings();
      };
    }

    // Encryption Key Toggle Eye Button
    const btnToggleEncKey = document.getElementById('btn-toggle-enc-key');
    if (btnToggleEncKey) {
      btnToggleEncKey.onclick = () => {
        const keyInp = document.getElementById('settings-user-enc-key');
        if (!keyInp) return;
        if (keyInp.type === 'password') {
          keyInp.type = 'text';
          btnToggleEncKey.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
          btnToggleEncKey.title = 'Hide Key';
        } else {
          keyInp.type = 'password';
          btnToggleEncKey.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
          btnToggleEncKey.title = 'Show Key';
        }
      };
    }

    // Copy Encryption Key Button
    const btnCopyEncKey = document.getElementById('btn-copy-enc-key');
    if (btnCopyEncKey) {
      btnCopyEncKey.onclick = () => {
        const keyInp = document.getElementById('settings-user-enc-key');
        const keyVal = keyInp?.value?.trim();
        if (!keyVal) {
          UI.showToast('Encryption key not loaded yet', 'warning');
          return;
        }
        navigator.clipboard.writeText(keyVal).then(() => {
          UI.showToast('Encryption key copied to clipboard!', 'success');
        }).catch(() => {
          if (keyInp) {
            keyInp.type = 'text';
            keyInp.select();
            document.execCommand('copy');
            keyInp.type = 'password';
            UI.showToast('Encryption key copied to clipboard!', 'success');
          }
        });
      };
    }

    // Settings Logout Button
    const settingsLogoutBtn = document.getElementById('settings-logout-btn');
    if (settingsLogoutBtn) {
      settingsLogoutBtn.onclick = async () => {
        this.unlockedFolders.clear();
        sessionStorage.clear();
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('folder');
          url.searchParams.delete('view');
          window.history.replaceState({}, '', url.pathname);
        } catch (e) {}
        UI.hideAllModals();
        await API.logout();
        UI.showToast('Logged out', 'info');
        this.showScreen('login');
      };
    }

    // Settings Tab Switching
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.onclick = () => {
        const tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.settings-tab-pane').forEach(pane => {
          pane.style.display = 'none';
          pane.classList.remove('active');
        });

        const targetPane = document.getElementById(`pane-${tab}`);
        if (targetPane) {
          targetPane.style.display = 'flex';
          targetPane.classList.add('active');
        }

        if (tab === 'webdav') {
          this.loadWebDavSettings();
        } else if (tab === 'backup') {
          this.loadBackupStatus();
        } else if (tab === 'users') {
          this.loadAdminUsers();
        } else if (tab === 'storage') {
          this.loadStorageStats();
          this.updateChunkingHints();
        } else if (tab === 'discord' || tab === 'telegram') {
          this.loadSettings();
        } else if (tab === 'appearance') {
          this.updateChunkingHints();
        }
      };
    });

    // Save Profile Action
    const btnSaveProfile = document.getElementById('btn-save-profile');
    if (btnSaveProfile) {
      btnSaveProfile.onclick = async () => {
        const firstName = document.getElementById('profile-first-name-input')?.value.trim() || '';
        const lastName = document.getElementById('profile-last-name-input')?.value.trim() || '';
        const email = document.getElementById('profile-email-input')?.value.trim() || '';
        const filePrefix = document.getElementById('profile-prefix-input')?.value.trim() || '';

        if (!email) {
          UI.showToast('Email address is required', 'warning');
          return;
        }

        btnSaveProfile.disabled = true;
        btnSaveProfile.innerHTML = '<span>Saving...</span>';

        try {
          const res = await API.updateProfile({ firstName, lastName, email, filePrefix });
          if (res?.user) {
            this.user = res.user;
            const emailDisp = document.getElementById('profile-email-display');
            if (emailDisp) emailDisp.textContent = this.user.email;
          }
          UI.showToast('Profile updated successfully!', 'success');
        } catch (err) {
          UI.showToast(err.message || 'Failed to update profile', 'error');
        } finally {
          btnSaveProfile.disabled = false;
          btnSaveProfile.innerHTML = '<span>Save Profile</span>';
        }
      };
    }

    // Open Add User Modal
    const btnOpenCreateUser = document.getElementById('btn-open-create-user');
    if (btnOpenCreateUser) {
      btnOpenCreateUser.onclick = () => {
        const emailInp = document.getElementById('create-user-email');
        const firstNameInp = document.getElementById('create-user-first-name');
        const lastNameInp = document.getElementById('create-user-last-name');
        const pwInp = document.getElementById('create-user-password');
        const roleSel = document.getElementById('create-user-role');
        const quotaInp = document.getElementById('create-user-quota');
        const prefixInp = document.getElementById('create-user-prefix');

        if (emailInp) emailInp.value = '';
        if (firstNameInp) firstNameInp.value = '';
        if (lastNameInp) lastNameInp.value = '';
        if (pwInp) pwInp.value = '';
        if (roleSel) roleSel.value = 'user';
        if (quotaInp) quotaInp.value = '0';
        if (prefixInp) prefixInp.value = '';

        UI.showModal('create-user-modal');
        setTimeout(() => emailInp && emailInp.focus(), 100);
      };
    }

    // Submit Create User
    const btnSubmitCreateUser = document.getElementById('btn-submit-create-user');
    if (btnSubmitCreateUser) {
      btnSubmitCreateUser.onclick = async () => {
        const email = document.getElementById('create-user-email')?.value.trim() || '';
        const firstName = document.getElementById('create-user-first-name')?.value.trim() || '';
        const lastName = document.getElementById('create-user-last-name')?.value.trim() || '';
        const password = document.getElementById('create-user-password')?.value || '';
        const role = document.getElementById('create-user-role')?.value || 'user';
        const quotaGB = parseFloat(document.getElementById('create-user-quota')?.value) || 0;
        const filePrefix = document.getElementById('create-user-prefix')?.value.trim() || '';
        const storageLimit = Math.round(quotaGB * 1024 * 1024 * 1024);

        if (!email || !firstName || !password) {
          UI.showToast('Email, first name, and initial password are required', 'warning');
          return;
        }
        if (password.length < 6) {
          UI.showToast('Password must be at least 6 characters', 'warning');
          return;
        }

        btnSubmitCreateUser.disabled = true;
        btnSubmitCreateUser.innerHTML = '<span>Creating...</span>';

        try {
          await API.createAdminUser({ email, firstName, lastName, password, role, storageLimit, filePrefix });
          UI.showToast(`User ${email} created successfully!`, 'success');
          UI.hideModal('create-user-modal');
          await this.loadAdminUsers();
        } catch (err) {
          UI.showToast(err.message || 'Failed to create user', 'error');
        } finally {
          btnSubmitCreateUser.disabled = false;
          btnSubmitCreateUser.innerHTML = '<span>Create User Account</span>';
        }
      };
    }

    // Submit Edit User
    const btnSubmitEditUser = document.getElementById('btn-submit-edit-user');
    if (btnSubmitEditUser) {
      btnSubmitEditUser.onclick = async () => {
        const id = document.getElementById('edit-user-id')?.value;
        const firstName = document.getElementById('edit-user-first-name')?.value.trim() || '';
        const lastName = document.getElementById('edit-user-last-name')?.value.trim() || '';
        const role = document.getElementById('edit-user-role')?.value || 'user';
        const status = document.getElementById('edit-user-status')?.value || 'active';
        const quotaGB = parseFloat(document.getElementById('edit-user-quota')?.value) || 0;
        const filePrefix = document.getElementById('edit-user-prefix')?.value.trim() || '';
        const storageLimit = Math.round(quotaGB * 1024 * 1024 * 1024);

        if (!id) return;

        btnSubmitEditUser.disabled = true;
        btnSubmitEditUser.innerHTML = '<span>Saving...</span>';

        try {
          await API.updateAdminUser(id, { firstName, lastName, role, status, storageLimit, filePrefix });
          UI.showToast('User updated successfully!', 'success');
          UI.hideModal('edit-user-modal');
          await this.loadAdminUsers();
        } catch (err) {
          UI.showToast(err.message || 'Failed to update user', 'error');
        } finally {
          btnSubmitEditUser.disabled = false;
          btnSubmitEditUser.innerHTML = '<span>Save Changes</span>';
        }
      };
    }

    // Submit Reset User Password
    const btnSubmitResetUserPw = document.getElementById('btn-submit-reset-user-pw');
    if (btnSubmitResetUserPw) {
      btnSubmitResetUserPw.onclick = async () => {
        const id = document.getElementById('reset-pw-user-id')?.value;
        const password = document.getElementById('reset-user-new-pw')?.value || '';

        if (!id || !password) {
          UI.showToast('Please enter a new password', 'warning');
          return;
        }
        if (password.length < 6) {
          UI.showToast('Password must be at least 6 characters', 'warning');
          return;
        }

        btnSubmitResetUserPw.disabled = true;
        btnSubmitResetUserPw.innerHTML = '<span>Setting...</span>';

        try {
          await API.resetAdminUserPassword(id, password);
          UI.showToast('Password reset successfully!', 'success');
          UI.hideModal('reset-user-password-modal');
        } catch (err) {
          UI.showToast(err.message || 'Failed to reset password', 'error');
        } finally {
          btnSubmitResetUserPw.disabled = false;
          btnSubmitResetUserPw.innerHTML = '<span>Set Password</span>';
        }
      };
    }

    // Password Eye Toggles
    document.querySelectorAll('.btn-toggle-pass').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input) {
          if (input.type === 'password') {
            input.type = 'text';
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
            btn.title = 'Hide Password';
          } else {
            input.type = 'password';
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
            btn.title = 'Show Password';
          }
        }
      };
    });

    // Change Account Password Action
    const btnSavePass = document.getElementById('btn-save-password');
    if (btnSavePass) {
      btnSavePass.onclick = async () => {
        const curr = document.getElementById('settings-current-pass')?.value || '';
        const next = document.getElementById('settings-new-pass')?.value || '';
        const conf = document.getElementById('settings-confirm-pass')?.value || '';

        if (!curr || !next || !conf) {
          UI.showToast('Please fill in all password fields', 'warning');
          return;
        }
        if (next !== conf) {
          UI.showToast('New passwords do not match!', 'error');
          return;
        }
        if (next.length < 6) {
          UI.showToast('New password must be at least 6 characters long', 'warning');
          return;
        }

        btnSavePass.disabled = true;
        btnSavePass.innerHTML = '<span>Saving...</span>';

        try {
          await API.changePassword(curr, next);
          UI.showToast('Password changed successfully!', 'success');
          document.getElementById('settings-current-pass').value = '';
          document.getElementById('settings-new-pass').value = '';
          document.getElementById('settings-confirm-pass').value = '';
        } catch (err) {
          UI.showToast(err.message || 'Failed to change password. Current password may be incorrect.', 'error');
        } finally {
          btnSavePass.disabled = false;
          btnSavePass.innerHTML = '<span>Save New Password</span>';
        }
      };
    }

    // Test Discord Connection
    const btnTestDiscord = document.getElementById('btn-test-discord') || document.getElementById('btn-test-tg');
    if (btnTestDiscord) {
      btnTestDiscord.onclick = async () => {
        const botToken = document.getElementById('settings-discord-bot-token')?.value.trim();
        const guildId = document.getElementById('settings-discord-guild-id')?.value.trim();
        const channelId = document.getElementById('settings-discord-channel-id')?.value.trim();

        btnTestDiscord.disabled = true;
        btnTestDiscord.innerHTML = '<span>Testing...</span>';
        const bannerDot = document.getElementById('discord-status-dot') || document.getElementById('tg-status-dot');
        const bannerTitle = document.getElementById('discord-status-title') || document.getElementById('tg-status-title');
        const bannerSub = document.getElementById('discord-status-sub') || document.getElementById('tg-status-sub');

        try {
          const res = await API.testDiscordSettings({ botToken, guildId, channelId });
          if (!res.success && res.error) throw new Error(res.error);
          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = `Connected (@${res.bot?.username || 'Bot'})`;
          if (bannerSub) bannerSub.textContent = 'Discord Gateway handshake & channel write access verified!';
          UI.showToast('Discord connection test passed successfully!', 'success');
        } catch (err) {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = 'Connection Test Failed';
          if (bannerSub) bannerSub.textContent = err.message || 'Could not verify credentials';
          UI.showToast('Discord test failed: ' + err.message, 'error');
        } finally {
          btnTestDiscord.disabled = false;
          btnTestDiscord.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>Test Connection</span>';
        }
      };
    }

    // Save & Reconnect Discord Settings
    const btnSaveDiscord = document.getElementById('btn-save-discord') || document.getElementById('btn-save-tg');
    if (btnSaveDiscord) {
      btnSaveDiscord.onclick = async () => {
        const botToken = document.getElementById('settings-discord-bot-token')?.value.trim();
        const guildId = document.getElementById('settings-discord-guild-id')?.value.trim();
        const channelId = document.getElementById('settings-discord-channel-id')?.value.trim();

        if (!botToken || !guildId || !channelId) {
          UI.showToast('All Discord fields (Bot Token, Guild ID, Channel ID) are required', 'warning');
          return;
        }

        btnSaveDiscord.disabled = true;
        btnSaveDiscord.innerHTML = '<span>Saving & Reconnecting...</span>';

        try {
          const res = await API.updateDiscordSettings({ botToken, guildId, channelId });
          const bannerDot = document.getElementById('discord-status-dot') || document.getElementById('tg-status-dot');
          const bannerTitle = document.getElementById('discord-status-title') || document.getElementById('tg-status-title');
          const bannerSub = document.getElementById('discord-status-sub') || document.getElementById('tg-status-sub');
          const toggleDiscord = document.getElementById('settings-discord-toggle');
          const toggleText = document.getElementById('discord-toggle-state-text');

          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = `Connected as @${res.bot?.username || 'Bot'}`;
          if (bannerSub) bannerSub.textContent = 'Settings saved to .env and Discord client connected!';
          if (toggleDiscord) toggleDiscord.checked = true;
          if (toggleText) toggleText.textContent = 'Active';

          UI.showToast('Discord settings updated & connected!', 'success');
        } catch (err) {
          UI.showToast('Save failed: ' + err.message, 'error');
        } finally {
          btnSaveDiscord.disabled = false;
          btnSaveDiscord.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>Save & Connect</span>';
        }
      };
    }

    // Toggle Discord Switch
    const toggleDiscord = document.getElementById('settings-discord-toggle');
    if (toggleDiscord) {
      toggleDiscord.onchange = async () => {
        const isEnabled = toggleDiscord.checked;
        const bannerDot = document.getElementById('discord-status-dot');
        const bannerTitle = document.getElementById('discord-status-title');
        const bannerSub = document.getElementById('discord-status-sub');
        const toggleText = document.getElementById('discord-toggle-state-text');

        if (!isEnabled) {
          try {
            await API.disconnectDiscord();
            if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
            if (bannerTitle) bannerTitle.textContent = 'Discord Disconnected (Standby)';
            if (bannerSub) bannerSub.textContent = 'Storage disabled / standby. Credentials preserved.';
            if (toggleText) toggleText.textContent = 'Standby';
            UI.showToast('Discord storage disabled (Standby). Credentials preserved.', 'info');
          } catch (err) {
            toggleDiscord.checked = true;
            UI.showToast('Failed to disconnect Discord: ' + err.message, 'error');
          }
        } else {
          const botToken = document.getElementById('settings-discord-bot-token')?.value.trim();
          const guildId = document.getElementById('settings-discord-guild-id')?.value.trim();
          const channelId = document.getElementById('settings-discord-channel-id')?.value.trim();

          if (!botToken || !channelId) {
            toggleDiscord.checked = false;
            UI.showToast('Please provide Discord Bot Token & Channel ID first', 'warning');
            return;
          }

          if (bannerTitle) bannerTitle.textContent = 'Connecting to Discord...';
          try {
            const res = await API.updateDiscordSettings({ botToken, guildId, channelId });
            if (bannerDot) bannerDot.className = 'tg-status-dot connected';
            const uName = res.bot?.username ? `@${res.bot.username}` : 'Bot';
            if (bannerTitle) bannerTitle.textContent = `Connected as ${uName}`;
            if (bannerSub) bannerSub.textContent = `Channel ID: ${channelId}`;
            if (toggleText) toggleText.textContent = 'Active';
            UI.showToast('Discord storage connected & activated!', 'success');
          } catch (err) {
            toggleDiscord.checked = false;
            if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
            if (bannerTitle) bannerTitle.textContent = 'Connection Failed';
            if (bannerSub) bannerSub.textContent = err.message || 'Could not connect to Discord';
            if (toggleText) toggleText.textContent = 'Standby';
            UI.showToast('Failed to connect Discord: ' + err.message, 'error');
          }
        }
      };
    }

    // Appearance Theme Switchers inside settings
    const themeBtnLight = document.getElementById('theme-btn-light');
    const themeBtnDark = document.getElementById('theme-btn-dark');

    if (themeBtnLight) {
      themeBtnLight.onclick = () => {
        this.setTheme('light');
        themeBtnLight.classList.add('active');
        if (themeBtnDark) themeBtnDark.classList.remove('active');
      };
    }
    if (themeBtnDark) {
      themeBtnDark.onclick = () => {
        this.setTheme('dark');
        themeBtnDark.classList.add('active');
        if (themeBtnLight) themeBtnLight.classList.remove('active');
      };
    }

    // View Preference Switchers
    const viewPrefGrid = document.getElementById('view-pref-grid');
    const viewPrefList = document.getElementById('view-pref-list');

    if (viewPrefGrid) {
      viewPrefGrid.onclick = () => {
        this.viewMode = 'grid';
        this.saveUserPreference('view_mode', 'grid');
        viewPrefGrid.classList.add('active');
        if (viewPrefList) viewPrefList.classList.remove('active');
        this.renderContents();
      };
    }
    if (viewPrefList) {
      viewPrefList.onclick = () => {
        this.viewMode = 'list';
        this.saveUserPreference('view_mode', 'list');
        viewPrefList.classList.add('active');
        if (viewPrefGrid) viewPrefGrid.classList.remove('active');
        this.renderContents();
      };
    }

    // Upload & Chunk Size Preferences
    const prefConcurrent = document.getElementById('pref-concurrent-chunks');

    // Discord Chunk Size Preference
      const prefDiscChunk = document.getElementById('pref-discord-chunk-size') || document.getElementById('pref-chunk-size');
      const customDiscWrap = document.getElementById('pref-discord-custom-chunk-wrap') || document.getElementById('pref-custom-chunk-wrap');
      const customDiscInput = document.getElementById('pref-discord-custom-chunk-input') || document.getElementById('pref-custom-chunk-input');
      const savedDiscChunk = localStorage.getItem('clouddrive_discord_chunk_size') || localStorage.getItem('discorddrive_chunk_size') || '9961472';

      if (prefDiscChunk) {
        const presetValues = ['9961472', '20971520', '47185920', '99614720', '471859200'];
        if (presetValues.includes(savedDiscChunk)) {
          prefDiscChunk.value = savedDiscChunk;
          if (customDiscWrap) customDiscWrap.style.display = 'none';
        } else {
          prefDiscChunk.value = 'custom';
          if (customDiscWrap) customDiscWrap.style.display = 'flex';
          if (customDiscInput) customDiscInput.value = (parseFloat(savedDiscChunk) / (1024 * 1024)).toFixed(1) || '9.5';
        }

        prefDiscChunk.onchange = () => {
          if (prefDiscChunk.value === 'custom') {
            if (customDiscWrap) customDiscWrap.style.display = 'flex';
            if (customDiscInput) {
              customDiscInput.focus();
              const mb = Math.min(500, Math.max(1, parseFloat(customDiscInput.value) || 9.5));
              customDiscInput.value = mb;
              const bytesVal = String(Math.round(mb * 1024 * 1024));
              localStorage.setItem('clouddrive_discord_chunk_size', bytesVal);
              this.saveUserPreference('discord_chunk_size', bytesVal);
              this.saveUserPreference('chunk_size', bytesVal);
            }
            UI.showToast('Custom Discord chunk size enabled', 'info');
          } else {
            if (customDiscWrap) customDiscWrap.style.display = 'none';
            localStorage.setItem('clouddrive_discord_chunk_size', prefDiscChunk.value);
            this.saveUserPreference('discord_chunk_size', prefDiscChunk.value);
            this.saveUserPreference('chunk_size', prefDiscChunk.value);
            UI.showToast('Discord chunk size preference saved!', 'success');
          }
          this.updateChunkingHints();
        };

        if (customDiscInput) {
          customDiscInput.oninput = () => {
            let mb = parseFloat(customDiscInput.value);
            if (!isNaN(mb) && mb >= 1 && mb <= 500) {
              const bytesVal = String(Math.round(mb * 1024 * 1024));
              localStorage.setItem('clouddrive_discord_chunk_size', bytesVal);
              this.saveUserPreference('discord_chunk_size', bytesVal);
              this.saveUserPreference('chunk_size', bytesVal);
            }
          };
          customDiscInput.onchange = () => {
            let mb = parseFloat(customDiscInput.value);
            if (isNaN(mb) || mb < 1) mb = 1;
            if (mb > 500) mb = 500;
            customDiscInput.value = mb;
            const bytesVal = String(Math.round(mb * 1024 * 1024));
            localStorage.setItem('clouddrive_discord_chunk_size', bytesVal);
            this.saveUserPreference('discord_chunk_size', bytesVal);
            this.saveUserPreference('chunk_size', bytesVal);
            this.updateChunkingHints();
            UI.showToast(`Custom Discord chunk size set to ${mb} MB!`, 'success');
          };
        }
      }

      // Telegram Chunk Size Preference
      const prefTgChunk = document.getElementById('pref-telegram-chunk-size');
      const customTgWrap = document.getElementById('pref-telegram-custom-chunk-wrap');
      const customTgInput = document.getElementById('pref-telegram-custom-chunk-input');
      const savedTgChunk = localStorage.getItem('clouddrive_telegram_chunk_size') || '20971520';

      if (prefTgChunk) {
        const presetValues = ['20971520', '47185920', '99614720', '209715200', '471859200'];
        if (presetValues.includes(savedTgChunk)) {
          prefTgChunk.value = savedTgChunk;
          if (customTgWrap) customTgWrap.style.display = 'none';
        } else {
          prefTgChunk.value = 'custom';
          if (customTgWrap) customTgWrap.style.display = 'flex';
          if (customTgInput) customTgInput.value = (parseFloat(savedTgChunk) / (1024 * 1024)).toFixed(1) || '20';
        }

        prefTgChunk.onchange = () => {
          if (prefTgChunk.value === 'custom') {
            if (customTgWrap) customTgWrap.style.display = 'flex';
            if (customTgInput) {
              customTgInput.focus();
              const mb = Math.min(2000, Math.max(1, parseFloat(customTgInput.value) || 20));
              customTgInput.value = mb;
              const bytesVal = String(Math.round(mb * 1024 * 1024));
              localStorage.setItem('clouddrive_telegram_chunk_size', bytesVal);
              this.saveUserPreference('telegram_chunk_size', bytesVal);
            }
            UI.showToast('Custom Telegram chunk size enabled', 'info');
          } else {
            if (customTgWrap) customTgWrap.style.display = 'none';
            localStorage.setItem('clouddrive_telegram_chunk_size', prefTgChunk.value);
            this.saveUserPreference('telegram_chunk_size', prefTgChunk.value);
            UI.showToast('Telegram chunk size preference saved!', 'success');
          }
          this.updateChunkingHints();
        };

        if (customTgInput) {
          customTgInput.oninput = () => {
            let mb = parseFloat(customTgInput.value);
            if (!isNaN(mb) && mb >= 1 && mb <= 2000) {
              const bytesVal = String(Math.round(mb * 1024 * 1024));
              localStorage.setItem('clouddrive_telegram_chunk_size', bytesVal);
              this.saveUserPreference('telegram_chunk_size', bytesVal);
            }
          };
          customTgInput.onchange = () => {
            let mb = parseFloat(customTgInput.value);
            if (isNaN(mb) || mb < 1) mb = 1;
            if (mb > 2000) mb = 2000;
            customTgInput.value = mb;
            const bytesVal = String(Math.round(mb * 1024 * 1024));
            localStorage.setItem('clouddrive_telegram_chunk_size', bytesVal);
            this.saveUserPreference('telegram_chunk_size', bytesVal);
            this.updateChunkingHints();
            UI.showToast(`Custom Telegram chunk size set to ${mb} MB!`, 'success');
          };
        }
      }

    if (prefConcurrent) {
      prefConcurrent.value = localStorage.getItem('discorddrive_concurrent_chunks') || '2';
      prefConcurrent.onchange = () => {
        this.saveUserPreference('concurrent_chunks', prefConcurrent.value);
        UI.showToast('Parallel upload streams preference saved!', 'success');
      };
    }

    // Keep Screen Awake Preference
    const prefWakeLock = document.getElementById('pref-wake-lock');
    if (prefWakeLock) {
      prefWakeLock.checked = localStorage.getItem('discorddrive_wake_lock') !== 'false';
      prefWakeLock.onchange = () => {
        const enabled = prefWakeLock.checked;
        this.saveUserPreference('wake_lock', enabled ? 'true' : 'false');
        if (!enabled && typeof Upload !== 'undefined' && Upload.releaseWakeLock) {
          Upload.releaseWakeLock();
        } else if (enabled && typeof Upload !== 'undefined' && Upload.isUploading) {
          Upload.acquireWakeLock();
        }
        UI.showToast(enabled ? 'Keep Screen Awake enabled for uploads!' : 'Keep Screen Awake disabled', 'info');
      };
    }

    // Clear Cache Action
    const btnClearCache = document.getElementById('btn-clear-cache');
    if (btnClearCache) {
      btnClearCache.onclick = async () => {
        btnClearCache.disabled = true;
        btnClearCache.innerHTML = '<span>Clearing...</span>';
        try {
          const res = await API.clearCache();
          UI.showToast(res.message || 'Decryption cache cleared!', 'success');
          const cacheSizeEl = document.getElementById('settings-cache-size');
          if (cacheSizeEl) cacheSizeEl.textContent = '0 B';
          await this.loadSettings();
        } catch (err) {
          UI.showToast('Failed to clear cache: ' + err.message, 'error');
        } finally {
          btnClearCache.disabled = false;
          btnClearCache.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>Clear Local Cache</span>';
        }
      };
    }

    const refreshAccountSessions = document.getElementById('btn-refresh-account-sessions');
    if (refreshAccountSessions) refreshAccountSessions.onclick = () => this.loadAccountSessions();

    const btnPurgeBrowserCache = document.getElementById('btn-purge-browser-cache');
    if (btnPurgeBrowserCache) {
      btnPurgeBrowserCache.onclick = async () => {
        if (btnPurgeBrowserCache.disabled) return;
        btnPurgeBrowserCache.disabled = true;
        btnPurgeBrowserCache.textContent = 'Purging…';
        try {
          await API.clearCache();
          if ('caches' in window) {
            const cacheKeys = await caches.keys();
            await Promise.all(cacheKeys.map(key => caches.delete(key)));
          }
          if (navigator.serviceWorker?.getRegistrations) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(registration => registration.unregister()));
          }
          if (indexedDB.databases) {
            const databases = await indexedDB.databases();
            await Promise.all(databases.filter(database => /cloud|drive/i.test(database.name || '')).map(database => new Promise(resolve => {
              const request = indexedDB.deleteDatabase(database.name);
              request.onsuccess = request.onerror = request.onblocked = () => resolve();
            })));
          }
          localStorage.clear();
          sessionStorage.clear();
          UI.showToast('Browser and server cache cleared. Reloading…', 'success');
          window.setTimeout(() => window.location.replace(`${window.location.pathname}?fresh=${Date.now()}`), 400);
        } catch (error) {
          UI.showToast(error.message || 'Unable to purge browser cache', 'error');
          btnPurgeBrowserCache.disabled = false;
          btnPurgeBrowserCache.textContent = 'Purge Browser + Server';
        }
      };
    }

    // Refresh Storage Stats Button
    const btnRefreshStorageStats = document.getElementById('btn-refresh-storage-stats');
    if (btnRefreshStorageStats) {
      btnRefreshStorageStats.onclick = async () => {
        const svgIcon = btnRefreshStorageStats.querySelector('svg');
        if (svgIcon) svgIcon.classList.add('spin-refresh');
        btnRefreshStorageStats.disabled = true;
        try {
          await Promise.all([
            this._doLoadStorageStats(),
            this.loadSettings().catch(() => null)
          ]);
          UI.showToast('Storage statistics refreshed!', 'success');
        } catch (err) {
          UI.showToast('Failed to refresh stats: ' + err.message, 'error');
        } finally {
          if (svgIcon) svgIcon.classList.remove('spin-refresh');
          btnRefreshStorageStats.disabled = false;
        }
      };
    }

    // Test Telegram Connection
    const btnTestTelegram = document.getElementById('btn-test-telegram');
    if (btnTestTelegram) {
      btnTestTelegram.onclick = async () => {
        const apiId = document.getElementById('settings-telegram-api-id')?.value.trim();
        const apiHash = document.getElementById('settings-telegram-api-hash')?.value.trim();
        const botToken = document.getElementById('settings-telegram-bot-token')?.value.trim();
        const channelId = document.getElementById('settings-telegram-channel-id')?.value.trim();

        btnTestTelegram.disabled = true;
        btnTestTelegram.innerHTML = '<span>Testing...</span>';
        const bannerDot = document.getElementById('telegram-status-dot');
        const bannerTitle = document.getElementById('telegram-status-title');
        const bannerSub = document.getElementById('telegram-status-sub');

        try {
          const res = await API.testTelegram({ apiId, apiHash, botToken, channelId });
          if (!res.success && res.error) throw new Error(res.error);
          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = `Connected (${res.connected ? 'OK' : 'Verified'})`;
          if (bannerSub) bannerSub.textContent = 'Telegram MTProto & bot permissions verified!';
          UI.showToast('Telegram connection test passed successfully!', 'success');
        } catch (err) {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = 'Connection Test Failed';
          if (bannerSub) bannerSub.textContent = err.message || 'Could not verify credentials';
          UI.showToast('Telegram test failed: ' + err.message, 'error');
        } finally {
          btnTestTelegram.disabled = false;
          btnTestTelegram.innerHTML = '<span>Test Connection</span>';
        }
      };
    }

    // Save Telegram Settings
    const btnSaveTelegram = document.getElementById('btn-save-telegram');
    if (btnSaveTelegram) {
      btnSaveTelegram.onclick = async () => {
        const apiId = document.getElementById('settings-telegram-api-id')?.value.trim();
        const apiHash = document.getElementById('settings-telegram-api-hash')?.value.trim();
        const botToken = document.getElementById('settings-telegram-bot-token')?.value.trim();
        const channelId = document.getElementById('settings-telegram-channel-id')?.value.trim();

        if (!apiId || !apiHash || !botToken || !channelId) {
          UI.showToast('All Telegram fields are required', 'warning');
          return;
        }

        btnSaveTelegram.disabled = true;
        btnSaveTelegram.innerHTML = '<span>Saving & Connecting...</span>';

        try {
          const res = await API.saveTelegramSettings({ apiId, apiHash, botToken, channelId });
          const bannerDot = document.getElementById('telegram-status-dot');
          const bannerTitle = document.getElementById('telegram-status-title');
          const bannerSub = document.getElementById('telegram-status-sub');
          const toggleTelegram = document.getElementById('settings-telegram-toggle');
          const toggleText = document.getElementById('telegram-toggle-state-text');

          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = 'Connected (Telegram Cloud)';
          if (bannerSub) bannerSub.textContent = 'Settings saved and Telegram client initialized!';
          if (toggleTelegram) toggleTelegram.checked = true;
          if (toggleText) toggleText.textContent = 'Active';

          UI.showToast('Telegram settings saved & connected!', 'success');
        } catch (err) {
          UI.showToast('Save failed: ' + err.message, 'error');
        } finally {
          btnSaveTelegram.disabled = false;
          btnSaveTelegram.innerHTML = '<span>Save & Connect</span>';
        }
      };
    }

    // Toggle Telegram Switch
    const toggleTelegram = document.getElementById('settings-telegram-toggle');
    if (toggleTelegram) {
      toggleTelegram.onchange = async () => {
        const isEnabled = toggleTelegram.checked;
        const bannerDot = document.getElementById('telegram-status-dot');
        const bannerTitle = document.getElementById('telegram-status-title');
        const bannerSub = document.getElementById('telegram-status-sub');
        const toggleText = document.getElementById('telegram-toggle-state-text');

        if (!isEnabled) {
          try {
            await API.disconnectTelegram();
            if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
            if (bannerTitle) bannerTitle.textContent = 'Telegram Disconnected (Standby)';
            if (bannerSub) bannerSub.textContent = 'Storage disabled / standby. Credentials preserved.';
            if (toggleText) toggleText.textContent = 'Standby';
            UI.showToast('Telegram storage disabled (Standby). Credentials preserved.', 'info');
          } catch (err) {
            toggleTelegram.checked = true;
            UI.showToast('Failed to disconnect Telegram: ' + err.message, 'error');
          }
        } else {
          const apiId = document.getElementById('settings-telegram-api-id')?.value.trim();
          const apiHash = document.getElementById('settings-telegram-api-hash')?.value.trim();
          const botToken = document.getElementById('settings-telegram-bot-token')?.value.trim();
          const channelId = document.getElementById('settings-telegram-channel-id')?.value.trim();

          if (!apiId || !botToken || !channelId) {
            toggleTelegram.checked = false;
            UI.showToast('Please provide Telegram API ID, Bot Token & Channel ID first', 'warning');
            return;
          }

          if (bannerTitle) bannerTitle.textContent = 'Connecting to Telegram...';
          try {
            await API.saveTelegramSettings({ apiId, apiHash, botToken, channelId });
            if (bannerDot) bannerDot.className = 'tg-status-dot connected';
            if (bannerTitle) bannerTitle.textContent = 'Connected (Telegram Cloud)';
            if (bannerSub) bannerSub.textContent = `Channel ID: ${channelId}`;
            if (toggleText) toggleText.textContent = 'Active';
            UI.showToast('Telegram storage connected & activated!', 'success');
          } catch (err) {
            toggleTelegram.checked = false;
            if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
            if (bannerTitle) bannerTitle.textContent = 'Connection Failed';
            if (bannerSub) bannerSub.textContent = err.message || 'Could not connect to Telegram';
            if (toggleText) toggleText.textContent = 'Standby';
            UI.showToast('Failed to connect Telegram: ' + err.message, 'error');
          }
        }
      };
    }

    // Save Storage Policy
    const btnSavePolicy = document.getElementById('btn-save-policy');
    const selStoragePolicy = document.getElementById('settings-storage-policy');
    const selUploadStrategy = document.getElementById('settings-upload-strategy');

    if (selStoragePolicy) {
      selStoragePolicy.onchange = () => {
        this.updateUploadStrategyDropdown();
        this.updateChunkingHints();
      };
    }

    if (selUploadStrategy) {
      selUploadStrategy.onchange = () => {
        const val = selUploadStrategy.value;
        if (val === 'primary_first' || val === 'parallel_both') {
          localStorage.setItem('clouddrive_upload_strategy', val);
        }
        this.updateUploadStrategyDropdown();
      };
    }

    const encToggle = document.getElementById('settings-encryption-toggle');
    if (encToggle) {
      encToggle.onchange = async () => {
        const isEnc = encToggle.checked;
        localStorage.setItem('clouddrive_encryption_enabled', isEnc ? 'true' : 'false');
        try {
          await API.updatePolicy({ encryptionEnabled: isEnc });
          UI.showToast(isEnc ? 'Zero-Knowledge AES-256 Encryption enabled' : 'Zero-Knowledge Encryption disabled (Raw upload mode)', 'info');
        } catch (e) {
          console.warn('Auto-save encryption toggle warning:', e);
        }
      };
    }

    if (btnSavePolicy) {
      btnSavePolicy.onclick = async () => {
        const defaultStorageMode = document.getElementById('settings-storage-policy')?.value || 'dual';
        const primaryProvider = document.getElementById('settings-primary-provider')?.value || 'telegram';
        let uploadStrategy = document.getElementById('settings-upload-strategy')?.value || 'primary_first';
        const encryptionEnabled = document.getElementById('settings-encryption-toggle') ? document.getElementById('settings-encryption-toggle').checked : true;

        if (defaultStorageMode !== 'dual') {
          uploadStrategy = 'primary_first';
        }

        btnSavePolicy.disabled = true;
        btnSavePolicy.innerHTML = '<span>Saving...</span>';

        try {
          await API.updatePolicy({ defaultStorageMode, uploadStrategy, primaryProvider, encryptionEnabled });
          if (this.user) {
            this.user.default_storage_mode = defaultStorageMode;
          }
          localStorage.setItem('clouddrive_default_storage_mode', defaultStorageMode);
          localStorage.setItem('clouddrive_upload_strategy', uploadStrategy);
          localStorage.setItem('clouddrive_primary_provider', primaryProvider);
          localStorage.setItem('clouddrive_encryption_enabled', encryptionEnabled ? 'true' : 'false');
          this.updateUploadStrategyDropdown(defaultStorageMode, uploadStrategy);
          this.updateChunkingHints();
          UI.showToast('Storage policy & security updated successfully!', 'success');
        } catch (err) {
          UI.showToast('Failed to update storage policy: ' + err.message, 'error');
        } finally {
          btnSavePolicy.disabled = false;
          btnSavePolicy.innerHTML = '<span>Save Storage Policy</span>';
        }
      };
    }

    // Auto-Heal & Cross-Cloud Reconcile button
    const btnReconcile = document.getElementById('btn-reconcile-storage');
    if (btnReconcile) {
      btnReconcile.onclick = async () => {
        btnReconcile.disabled = true;
        btnReconcile.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" class="spin" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>Scanning & Syncing...</span>';
        try {
          UI.showToast('Scanning all chunks and syncing missing replicas...', 'info');
          const res = await API.reconcileStorage();
          const scanCount = (res.result && res.result.scannedFiles !== undefined) ? res.result.scannedFiles : (res.scannedFiles || 0);
          UI.showToast(res.message || `Auto-healing sync complete! (Scanned ${scanCount} files)`, 'success');
          if (typeof this.loadStorageStats === 'function') {
            await this.loadStorageStats();
          }
          if (typeof this.loadFiles === 'function') {
            await this.loadFiles();
          }
        } catch (err) {
          UI.showToast('Sync reconciliation failed: ' + err.message, 'error');
        } finally {
          btnReconcile.disabled = false;
          btnReconcile.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>Scan & Auto-Heal Sync</span>';
        }
      };
    }

    // Run Speed Test button
    const btnRunSpeedtest = document.getElementById('btn-run-speedtest');
    if (btnRunSpeedtest) {
      btnRunSpeedtest.onclick = async () => {
        btnRunSpeedtest.disabled = true;
        btnRunSpeedtest.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" class="spin" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>Benchmarking...</span>';

        const container = document.getElementById('speedtest-results-container');
        const recBox = document.getElementById('speedtest-recommendation-box');
        const tgUp = document.getElementById('speedtest-tg-up');
        const tgDl = document.getElementById('speedtest-tg-dl');
        const tgStatus = document.getElementById('speedtest-tg-status');
        const dcUp = document.getElementById('speedtest-dc-up');
        const dcDl = document.getElementById('speedtest-dc-dl');
        const dcStatus = document.getElementById('speedtest-dc-status');

        if (container) container.style.display = 'block';
        if (recBox) recBox.textContent = 'Testing real-time latency & throughput to Telegram and Discord cloud...';
        if (tgStatus) { tgStatus.textContent = 'Testing...'; tgStatus.className = 'badge badge-warning'; }
        if (dcStatus) { dcStatus.textContent = 'Testing...'; dcStatus.className = 'badge badge-warning'; }
        if (tgUp) tgUp.textContent = '...';
        if (tgDl) tgDl.textContent = '...';
        if (dcUp) dcUp.textContent = '...';
        if (dcDl) dcDl.textContent = '...';

        try {
          UI.showToast('Running cloud speed test. Please wait a few seconds...', 'info');
          const res = await API.runSpeedTest();
          
          if (recBox) {
            recBox.innerHTML = `<strong>Recommendation:</strong> ${res.recommendation || 'Benchmark completed.'}`;
          }

          const tg = res.telegram || res.results?.telegram;
          if (tg) {
            if (tgStatus) {
              tgStatus.textContent = tg.error ? 'Error' : 'Tested';
              tgStatus.className = tg.error ? 'badge badge-count' : 'badge badge-secure';
            }
            if (tgUp) tgUp.textContent = tg.upload ? `${tg.upload.speedMBps} MB/s (${tg.upload.speedMbps} Mbps)` : (tg.error || 'N/A');
            if (tgDl) tgDl.textContent = tg.download ? `${tg.download.speedMBps} MB/s (${tg.download.speedMbps} Mbps)` : (tg.error || 'N/A');
          }

          const dc = res.discord || res.results?.discord;
          if (dc) {
            if (dcStatus) {
              dcStatus.textContent = dc.error ? 'Error' : 'Tested';
              dcStatus.className = dc.error ? 'badge badge-count' : 'badge badge-secure';
            }
            if (dcUp) dcUp.textContent = dc.upload ? `${dc.upload.speedMBps} MB/s (${dc.upload.speedMbps} Mbps)` : (dc.error || 'N/A');
            if (dcDl) dcDl.textContent = dc.download ? `${dc.download.speedMBps} MB/s (${dc.download.speedMbps} Mbps)` : (dc.error || 'N/A');
          }

          UI.showToast('Speed benchmark completed successfully!', 'success');
        } catch (err) {
          if (recBox) recBox.textContent = 'Speed test failed: ' + err.message;
          UI.showToast('Speed test error: ' + err.message, 'error');
        } finally {
          btnRunSpeedtest.disabled = false;
          btnRunSpeedtest.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>Run Speed Test</span>';
        }
      };
    }

    // Multi-Cloud Backup Now button
    const btnCloudBackup = document.getElementById('btn-cloud-backup-now');
    if (btnCloudBackup) {
      btnCloudBackup.onclick = async () => {
        btnCloudBackup.disabled = true;
        btnCloudBackup.innerHTML = '<span>Backing up...</span>';
        try {
          UI.showToast('Creating encrypted cloud snapshot & uploading to Discord & Telegram...', 'info');
          const res = await API.backupNow('all');
          UI.showToast(res.message || 'Encrypted cloud backup created successfully!', 'success');
          await this.loadBackupStatus();
        } catch (err) {
          UI.showToast('Cloud backup failed: ' + err.message, 'error');
        } finally {
          btnCloudBackup.disabled = false;
          btnCloudBackup.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>Backup Now</span>';
        }
      };
    }

    // Export Database button
    // Export Database / User Backup button
    const btnExportDb = document.getElementById('btn-export-db');
    if (btnExportDb) {
      btnExportDb.onclick = async () => {
        try {
          const isAdmin = this.user && this.user.role === 'admin';
          UI.showToast(isAdmin ? 'Generating system database backup...' : 'Exporting your personal files & metadata...', 'info');
          const res = await fetch('/api/settings/export-db', {
            headers: {
              'Authorization': `Bearer ${API.token || ''}`
            }
          });
          if (!res.ok) {
            let errorMsg = 'Failed to download backup';
            try {
              const err = await res.json();
              errorMsg = err.error || errorMsg;
            } catch (e) {}
            throw new Error(errorMsg);
          }

          // Extract filename from header if available
          let downloadName = `clouddrive-backup-${new Date().toISOString().slice(0, 10)}.${isAdmin ? 'db' : 'json'}`;
          const disposition = res.headers.get('Content-Disposition');
          if (disposition && disposition.includes('filename=')) {
            const matches = disposition.match(/filename="?([^"]+)"?/);
            if (matches && matches[1]) downloadName = matches[1];
          }

          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = downloadName;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          a.remove();
          UI.showToast('Backup file exported successfully!', 'success');
        } catch (e) {
          UI.showToast('Export failed: ' + e.message, 'error');
        }
      };
    }

    // Import Database / User Backup trigger & upload
    const btnImportTrigger = document.getElementById('btn-import-db-trigger');
    const inputImportDb = document.getElementById('import-db-file');
    if (btnImportTrigger && inputImportDb) {
      btnImportTrigger.onclick = () => inputImportDb.click();

      inputImportDb.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const isAdmin = this.user && this.user.role === 'admin';
        const isJson = file.name.endsWith('.json');
        const isDb = file.name.endsWith('.db') || file.name.endsWith('.sqlite');

        const confirmTitle = isJson ? 'Restore Personal Data Backup?' : 'Restore Database Backup?';
        const confirmMsg = `Are you sure you want to restore from "${file.name}"?`;
        const confirmDesc = (isAdmin && isDb)
          ? 'Warning: This will overwrite the current system database. CloudDrive will reload automatically once restored.'
          : 'This will restore all files, folders, and cloud chunk indexes from this backup into your account.';

        const confirmed = await UI.confirm({
          title: confirmTitle,
          message: confirmMsg,
          description: confirmDesc,
          icon: 'warning',
          confirmText: 'Restore Backup',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) {
          inputImportDb.value = '';
          return;
        }

        btnImportTrigger.disabled = true;
        btnImportTrigger.innerHTML = '<span>Restoring...</span>';
        UI.showToast('Restoring backup data and verifying records... Please wait.', 'info', 10000);

        try {
          const res = await API.importDatabase(file);
          UI.showToast(res.message || 'Backup restored successfully! Reloading...', 'success', 4000);
          setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
          UI.showToast('Restore failed: ' + (err.message || 'Invalid backup file'), 'error', 6000);
          btnImportTrigger.disabled = false;
          btnImportTrigger.innerHTML = '<span>Restore Backup File</span>';
          inputImportDb.value = '';
        }
      };
    }

    // WebDAV Settings Save Button
    const btnSaveWebdav = document.getElementById('btn-save-webdav');
    if (btnSaveWebdav) {
      btnSaveWebdav.onclick = async () => {
        const enabled = document.getElementById('webdav-enabled')?.checked;
        const permissionMode = document.getElementById('webdav-permission-mode')?.value || 'full';
        const password = document.getElementById('webdav-password')?.value || '';
        const username = document.getElementById('webdav-username')?.value.trim() || '';
        const userEnabled = document.getElementById('webdav-user-enabled')?.checked !== false;

        btnSaveWebdav.disabled = true;
        btnSaveWebdav.innerHTML = '<span>Saving...</span>';

        try {
          // Build payload — only include admin-only fields if user is admin
          const isAdmin = this.user && this.user.role === 'admin';
          const payload = {};
          payload.username = username;
          payload.userEnabled = userEnabled;
          if (isAdmin) {
            payload.enabled = enabled;
            payload.permissionMode = permissionMode;
          }
          if (password) payload.password = password;

          const res = await API.updateWebDavSettings(payload);
          UI.showToast(res.message || 'WebDAV settings updated successfully!', 'success');
          if (password) {
            const passInput = document.getElementById('webdav-password');
            if (passInput) passInput.value = '';
          }
          await this.loadWebDavSettings();
        } catch (err) {
          UI.showToast('Failed to update WebDAV settings: ' + err.message, 'error');
        } finally {
          btnSaveWebdav.disabled = false;
          btnSaveWebdav.innerHTML = '<span>Save WebDAV Settings</span>';
        }
      };
    }

    // WebDAV Test Credentials Button
    const btnTestWebdav = document.getElementById('btn-test-webdav');
    if (btnTestWebdav) {
      btnTestWebdav.onclick = async () => {
        const username = document.getElementById('webdav-username')?.value.trim() || 'admin';
        let password = document.getElementById('webdav-password')?.value || '';

        if (!password) {
          const promptedPass = prompt(`Enter password to test WebDAV connection for user "${username}":`);
          if (!promptedPass) return;
          password = promptedPass;
        }

        btnTestWebdav.disabled = true;
        btnTestWebdav.innerHTML = '<span>Testing...</span>';

        try {
          const res = await API.testWebDavAuth(username, password);
          if (res.success) {
            UI.showToast(res.message || 'WebDAV credentials verified successfully!', 'success');
          } else {
            UI.showToast(res.error || 'Authentication failed', 'error');
          }
        } catch (err) {
          UI.showToast(err.message || 'WebDAV Authentication failed. Please check password.', 'error');
        } finally {
          btnTestWebdav.disabled = false;
          btnTestWebdav.innerHTML = '<span>Test Credentials</span>';
        }
      };
    }

    // WebDAV Reset Password to Account Password Button
    const btnResetWebdavPw = document.getElementById('btn-reset-webdav-pw');
    if (btnResetWebdavPw) {
      btnResetWebdavPw.onclick = async () => {
        const confirmed = await UI.confirm({
          title: 'Reset WebDAV Password?',
          message: 'This will remove the custom WebDAV password and revert authentication back to your main CloudDrive account password.',
          icon: 'warning',
          confirmText: 'Reset Password',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          const res = await API.updateWebDavSettings({ resetPassword: true });
          UI.showToast(res.message || 'WebDAV password reset to Account Password!', 'success');
          const passInput = document.getElementById('webdav-password');
          if (passInput) passInput.value = '';
          await this.loadWebDavSettings();
        } catch (err) {
          UI.showToast('Failed to reset password: ' + err.message, 'error');
        }
      };
    }

    // WebDAV Copy URL Button
    const btnCopyWebdavUrl = document.getElementById('btn-copy-webdav-url');
    if (btnCopyWebdavUrl) {
      btnCopyWebdavUrl.onclick = async () => {
        const urlInput = document.getElementById('webdav-url');
        const copyTextSpan = document.getElementById('btn-copy-webdav-url-text');
        if (urlInput && urlInput.value) {
          const success = await UI.copyToClipboard(urlInput.value, urlInput);
          if (success) {
            if (copyTextSpan) copyTextSpan.textContent = 'Copied!';
            UI.showToast('WebDAV Server URL copied to clipboard!', 'success');
            setTimeout(() => {
              if (copyTextSpan) copyTextSpan.textContent = 'Copy';
            }, 2000);
          } else {
            UI.showToast('Failed to copy WebDAV URL', 'error');
          }
        }
      };
    }

    // WebDAV Instant Enable/Disable Toggle (Admin only)
    const toggleWebdavEnabled = document.getElementById('webdav-enabled');
    if (toggleWebdavEnabled) {
      toggleWebdavEnabled.onchange = async () => {
        if (this.user && this.user.role !== 'admin') {
          toggleWebdavEnabled.checked = !toggleWebdavEnabled.checked; // revert
          UI.showToast('Only administrators can enable or disable WebDAV', 'warning');
          return;
        }
        try {
          await API.updateWebDavSettings({ enabled: toggleWebdavEnabled.checked });
          UI.showToast(toggleWebdavEnabled.checked ? 'WebDAV Network Drive enabled!' : 'WebDAV Network Drive disabled', 'info');
        } catch (err) {
          UI.showToast('Error updating WebDAV state: ' + err.message, 'error');
          toggleWebdavEnabled.checked = !toggleWebdavEnabled.checked; // revert on error
        }
      };
    }

    // WebDAV Instant Permission Mode change (Admin only)
    const selectWebdavMode = document.getElementById('webdav-permission-mode');
    if (selectWebdavMode) {
      selectWebdavMode.onchange = async () => {
        if (this.user && this.user.role !== 'admin') {
          UI.showToast('Only administrators can change the permission mode', 'warning');
          return;
        }
        try {
          await API.updateWebDavSettings({ permissionMode: selectWebdavMode.value });
          UI.showToast('WebDAV Permission Mode updated!', 'info');
        } catch (err) {
          UI.showToast('Error updating permission mode: ' + err.message, 'error');
        }
      };
    }

    // WebDAV Sessions Refresh Button
    const btnRefreshWebdavSessions = document.getElementById('btn-refresh-webdav-sessions');
    if (btnRefreshWebdavSessions) {
      btnRefreshWebdavSessions.onclick = async () => {
        const iconSvg = btnRefreshWebdavSessions.querySelector('svg');
        if (iconSvg) iconSvg.classList.add('spin-refresh');
        btnRefreshWebdavSessions.disabled = true;
        try {
          await this.loadWebDavSessions(true);
        } catch (err) {
          UI.showToast('Failed to refresh devices: ' + err.message, 'error');
        } finally {
          if (iconSvg) iconSvg.classList.remove('spin-refresh');
          btnRefreshWebdavSessions.disabled = false;
        }
      };
    }
  },

  updateUploadStrategyDropdown(selectedMode = null, selectedStrategy = null) {
    const polEl = document.getElementById('settings-storage-policy');
    const stratEl = document.getElementById('settings-upload-strategy');
    if (!polEl || !stratEl) return;

    const mode = selectedMode || polEl.value || 'dual';
    let currentStrat = selectedStrategy || stratEl.value || localStorage.getItem('clouddrive_upload_strategy') || 'primary_first';

    let hintContainer = document.getElementById('upload-strategy-hint');
    if (!hintContainer) {
      hintContainer = document.createElement('small');
      hintContainer.id = 'upload-strategy-hint';
      hintContainer.className = 'hint';
      hintContainer.style.display = 'block';
      hintContainer.style.marginTop = '4px';
      stratEl.parentNode.appendChild(hintContainer);
    }

    if (mode === 'dual') {
      stratEl.disabled = false;
      stratEl.innerHTML = `
        <option value="primary_first">Primary First + Background Replication (Fastest)</option>
        <option value="parallel_both">Parallel Dual Upload (Direct to Both Clouds Simultaneously)</option>
      `;
      if (currentStrat === 'parallel_both' || currentStrat === 'simultaneous') {
        stratEl.value = 'parallel_both';
      } else {
        stratEl.value = 'primary_first';
      }
      hintContainer.innerHTML = stratEl.value === 'parallel_both'
        ? `${UI.icon('bolt', 14)} Parallel stream: Encrypted chunks are sent to Discord & Telegram simultaneously.`
        : `${UI.icon('rocket', 14)} Fast upload: Files upload to primary cloud first, then replicate to secondary in background.`;
    } else if (mode === 'telegram') {
      stratEl.innerHTML = `
        <option value="single_telegram" selected>Direct Telegram Storage (Single Cloud / No Replication)</option>
      `;
      stratEl.disabled = true;
      hintContainer.innerHTML = `${UI.icon('info', 14)} Telegram Only mode: Encrypted files are stored directly on Telegram without secondary backup.`;
    } else if (mode === 'discord') {
      stratEl.innerHTML = `
        <option value="single_discord" selected>Direct Discord Storage (Single Cloud / No Replication)</option>
      `;
      stratEl.disabled = true;
      hintContainer.innerHTML = `${UI.icon('info', 14)} Discord Only mode: Encrypted files are stored directly on Discord without secondary backup.`;
    }
  },

  updateChunkingHints() {
    const polEl = document.getElementById('settings-storage-policy');
    const mode = polEl ? polEl.value : (localStorage.getItem('clouddrive_default_storage_mode') || 'dual');
    const hintEl = document.getElementById('chunk-provider-hint');
    if (!hintEl) return;

    const discBytes = parseFloat(localStorage.getItem('clouddrive_discord_chunk_size') || localStorage.getItem('discorddrive_chunk_size') || '9961472');
    const tgBytes = parseFloat(localStorage.getItem('clouddrive_telegram_chunk_size') || '20971520');
    const discMb = (discBytes / (1024 * 1024)).toFixed(1);
    const tgMb = (tgBytes / (1024 * 1024)).toFixed(1);
    const dualMb = (Math.min(discBytes, tgBytes) / (1024 * 1024)).toFixed(1);

    if (mode === 'telegram') {
      hintEl.innerHTML = `${UI.icon('cloud', 14)} <strong>Telegram Only Active:</strong> Large files split into <strong>${tgMb} MB</strong> chunks (Ultra-fast direct Telegram upload).`;
      hintEl.style.color = '#38bdf8';
    } else if (mode === 'discord') {
      hintEl.innerHTML = `${UI.icon('cloud', 14)} <strong>Discord Only Active:</strong> Large files split into <strong>${discMb} MB</strong> chunks (Direct Discord channel storage).`;
      hintEl.style.color = '#818cf8';
    } else {
      hintEl.innerHTML = `${UI.icon('globe', 14)} <strong>Dual Cloud Active:</strong> Uses compatible <strong>${dualMb} MB</strong> chunks (Discord: ${discMb} MB, Telegram: ${tgMb} MB) for 100% reliable cross-replication between both clouds without hitting file limits.`;
      hintEl.style.color = 'var(--text-secondary)';
    }
  },

  async openSettings() {
    this.initSettings();
    UI.showModal('settings-modal');
    if (!this.user) {
      try { const profile = await API.getProfile(); this.user = profile?.user || profile; } catch (_) {}
    }

    // Default to account tab or keep selected
    const activeTabBtn = document.querySelector('.settings-tab-btn.active');
    let tabName = activeTabBtn ? activeTabBtn.getAttribute('data-tab') : 'account';
    document.querySelectorAll('.settings-tab-pane').forEach(p => {
      p.style.display = p.id === `pane-${tabName}` ? 'flex' : 'none';
    });

    // Populate user profile info
    if (this.user) {
      const emailDisp = document.getElementById('profile-email-display');
      const roleBadge = document.getElementById('profile-role-badge');
      const storageText = document.getElementById('profile-storage-text');
      const firstNameInput = document.getElementById('profile-first-name-input');
      const lastNameInput = document.getElementById('profile-last-name-input');
      const emailInput = document.getElementById('profile-email-input');
      const prefixInput = document.getElementById('profile-prefix-input');

      if (emailDisp) emailDisp.textContent = this.user.email || '';
      if (roleBadge) {
        roleBadge.textContent = this.user.role === 'admin' ? 'Admin' : 'User';
        roleBadge.className = this.user.role === 'admin' ? 'badge-secure' : 'badge-count';
      }
      if (storageText) {
        const used = UI.formatFileSize(this.user.storage_used || 0);
        const limit = this.user.storage_limit > 0 ? UI.formatFileSize(this.user.storage_limit) : 'Unlimited';
        storageText.textContent = `${used} / ${limit}`;
      }
      if (firstNameInput) firstNameInput.value = this.user.first_name || this.user.firstName || (this.user.name || '').split(/\s+/)[0] || '';
      if (lastNameInput) lastNameInput.value = this.user.last_name || this.user.lastName || (this.user.name || '').split(/\s+/).slice(1).join(' ');
      if (emailInput) emailInput.value = this.user.email || '';
      if (prefixInput) prefixInput.value = this.user.file_prefix || this.user.filePrefix || '';
      const userKeyInp = document.getElementById('settings-user-enc-key');
      if (userKeyInp) {
        userKeyInp.value = this.user.encryption_key || '';
      }
      if (!this.user?.encryption_key) {
        API.getProfile().then(profile => {
          if (profile?.user?.encryption_key || profile?.encryption_key) {
            const k = profile.user?.encryption_key || profile.encryption_key;
            if (this.user) this.user.encryption_key = k;
            if (userKeyInp) userKeyInp.value = k;
          }
        }).catch(() => {});
      }
    }

    // Admin-only controls are mounted in Admin Center instead of this modal.
    const isAdmin = this.user?.role === 'admin';
    const tabUsersNav = document.getElementById('tab-users-nav');
    const tabDiscordNav = document.getElementById('tab-discord-nav');
    const tabTelegramNav = document.getElementById('tab-telegram-nav');
    const adminCenterLink = document.getElementById('sidebar-admin-center-link');
    if (adminCenterLink) {
      adminCenterLink.style.display = isAdmin ? 'flex' : 'none';
    }
    const adminCenterMounted = isAdmin && document.getElementById('admin-settings-host')?.contains(document.getElementById('pane-users'));
    if (tabUsersNav) tabUsersNav.style.display = adminCenterMounted ? 'none' : (isAdmin ? 'inline-flex' : 'none');
    if (tabDiscordNav) tabDiscordNav.style.display = adminCenterMounted ? 'none' : (isAdmin ? 'inline-flex' : 'none');
    if (tabTelegramNav) tabTelegramNav.style.display = adminCenterMounted ? 'none' : (isAdmin ? 'inline-flex' : 'none');
    if (adminCenterMounted) {
      const movedTabs = ['security', 'backup', 'webdav'];
      movedTabs.forEach(name => {
        const button = document.querySelector(`.settings-tab-btn[data-tab="${name}"]`);
        if (button) button.style.display = 'none';
      });
      if (['users', 'discord', 'telegram', ...movedTabs].includes(tabName)) {
        tabName = 'account';
        document.querySelectorAll('.settings-tab-btn').forEach(button => button.classList.toggle('active', button.getAttribute('data-tab') === 'account'));
        document.querySelectorAll('.settings-tab-pane').forEach(pane => { pane.style.display = pane.id === 'pane-account' ? 'flex' : 'none'; });
      }
    }

    // If non-admin user somehow opens with an admin tab, fallback to account tab
    if (!isAdmin && (tabName === 'users' || tabName === 'discord' || tabName === 'telegram')) {
      document.querySelectorAll('.settings-tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tab') === 'account');
      });
      document.querySelectorAll('.settings-tab-pane').forEach(p => {
        p.style.display = p.id === 'pane-account' ? 'flex' : 'none';
      });
    }

    if (tabName === 'users' && isAdmin) {
      await this.loadAdminUsers();
    }

    // Sync theme buttons
    const curTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const lightBtn = document.getElementById('theme-btn-light');
    const darkBtn = document.getElementById('theme-btn-dark');
    if (lightBtn) lightBtn.classList.toggle('active', curTheme === 'light');
    if (darkBtn) darkBtn.classList.toggle('active', curTheme === 'dark');

    // Sync view buttons
    const gridBtn = document.getElementById('view-pref-grid');
    const listBtn = document.getElementById('view-pref-list');
    if (gridBtn) gridBtn.classList.toggle('active', this.viewMode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', this.viewMode === 'list');

    // Sync upload preferences (Discord)
    const prefDiscChunk = document.getElementById('pref-discord-chunk-size') || document.getElementById('pref-chunk-size');
    if (prefDiscChunk) {
      const customDiscWrap = document.getElementById('pref-discord-custom-chunk-wrap') || document.getElementById('pref-custom-chunk-wrap');
      const customDiscInput = document.getElementById('pref-discord-custom-chunk-input') || document.getElementById('pref-custom-chunk-input');
      const savedDiscChunk = localStorage.getItem('clouddrive_discord_chunk_size') || localStorage.getItem('discorddrive_chunk_size') || '9961472';
      const presetValues = ['9961472', '20971520', '47185920', '99614720', '471859200'];
      if (presetValues.includes(savedDiscChunk)) {
        prefDiscChunk.value = savedDiscChunk;
        if (customDiscWrap) customDiscWrap.style.display = 'none';
      } else {
        prefDiscChunk.value = 'custom';
        if (customDiscWrap) customDiscWrap.style.display = 'flex';
        if (customDiscInput) customDiscInput.value = (parseFloat(savedDiscChunk) / (1024 * 1024)).toFixed(1) || '9.5';
      }
    }

    // Sync upload preferences (Telegram)
    const prefTgChunk = document.getElementById('pref-telegram-chunk-size');
    if (prefTgChunk) {
      const customTgWrap = document.getElementById('pref-telegram-custom-chunk-wrap');
      const customTgInput = document.getElementById('pref-telegram-custom-chunk-input');
      const savedTgChunk = localStorage.getItem('clouddrive_telegram_chunk_size') || '20971520';
      const presetValues = ['20971520', '47185920', '99614720', '209715200', '471859200'];
      if (presetValues.includes(savedTgChunk)) {
        prefTgChunk.value = savedTgChunk;
        if (customTgWrap) customTgWrap.style.display = 'none';
      } else {
        prefTgChunk.value = 'custom';
        if (customTgWrap) customTgWrap.style.display = 'flex';
        if (customTgInput) customTgInput.value = (parseFloat(savedTgChunk) / (1024 * 1024)).toFixed(1) || '20';
      }
    }
    const prefConcurrent = document.getElementById('pref-concurrent-chunks');
    const prefWakeLock = document.getElementById('pref-wake-lock');
    if (prefConcurrent) {
      prefConcurrent.value = localStorage.getItem('discorddrive_concurrent_chunks') || '2';
    }
    if (prefWakeLock) {
      prefWakeLock.checked = localStorage.getItem('discorddrive_wake_lock') !== 'false';
    }

    // Fetch and populate live settings data
    await Promise.all([this.loadSettings(), this.loadAccountSessions()]);
  },

  async loadAccountSessions() {
    const list = document.getElementById('account-device-sessions');
    const summary = document.getElementById('account-session-summary');
    if (!list || !summary) return;
    try {
      const result = await API.getAccountSessions();
      const sessions = result.sessions || [];
      const activeCount = sessions.filter(session => !session.revoked).length;
      summary.textContent = `${activeCount} ${activeCount === 1 ? 'device' : 'devices'} connected to this account`;
      if (!sessions.length) {
        list.innerHTML = '<span class="hint">No active devices recorded yet. This browser will appear after its next authenticated request.</span>';
        return;
      }
      const icon = session => session.type === 'webdav' ? '◫' : (session.osType === 'apple' ? '●' : session.osType === 'android' ? '◉' : '◌');
      list.innerHTML = sessions.map(session => {
        const lastActive = session.lastActive ? new Date(session.lastActive).toLocaleString() : 'Unknown';
        const state = session.revoked ? '<span class="account-device-current account-device-revoked">Signed out</span>' : (session.isCurrent ? '<span class="account-device-current">This device</span>' : '');
        const action = session.revoked ? '' : `<button type="button" class="btn-secondary btn-sm account-session-revoke" data-session-id="${UI.escapeHtml(session.id)}" data-current="${session.isCurrent ? '1' : '0'}">${session.isCurrent ? 'Log out' : 'Log out device'}</button>`;
        return `<div class="account-device-row"><span class="account-device-icon" aria-hidden="true">${icon(session)}</span><div class="account-device-copy"><div class="account-device-title">${UI.escapeHtml(session.clientName || 'Device')}${state}</div><small>${UI.escapeHtml(session.type === 'webdav' ? 'WebDAV' : 'Browser')} · ${UI.escapeHtml(session.ip || '—')} · Last active ${UI.escapeHtml(lastActive)}</small></div>${action}</div>`;
      }).join('');
      list.querySelectorAll('.account-session-revoke').forEach(button => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            const response = await API.revokeAccountSession(button.dataset.sessionId);
            UI.showToast(response.message || 'Device signed out', 'success');
            if (response.isCurrent || button.dataset.current === '1') {
              this.unlockedFolders.clear();
              sessionStorage.clear();
              UI.hideAllModals();
              this.showScreen('login');
            } else {
              await this.loadAccountSessions();
            }
          } catch (error) {
            UI.showToast(error.message || 'Unable to sign out device', 'error');
            button.disabled = false;
          }
        };
      });
    } catch (error) {
      summary.textContent = 'Unable to load connected devices';
      list.innerHTML = `<span class="hint">${UI.escapeHtml(error.message || 'Unable to load device sessions.')}</span>`;
    }
  },

  async loadSettings() {
    try {
      const data = await API.getSettings();
      if (!data) return;

      // Populate Discord config
      const discordData = data.discord || data.providers?.discord;
      if (discordData) {
        const botTokenInput = document.getElementById('settings-discord-bot-token') || document.getElementById('settings-tg-bot-token');
        const guildIdInput = document.getElementById('settings-discord-guild-id') || document.getElementById('settings-tg-api-hash');
        const channelIdInput = document.getElementById('settings-discord-channel-id') || document.getElementById('settings-tg-channel-id');

        if (botTokenInput) botTokenInput.value = discordData.botToken || '';
        if (guildIdInput) guildIdInput.value = discordData.guildId || '';
        if (channelIdInput) channelIdInput.value = discordData.channelId || '';

        // Status Banner & Switch
        const bannerDot = document.getElementById('discord-status-dot');
        const bannerTitle = document.getElementById('discord-status-title');
        const bannerSub = document.getElementById('discord-status-sub');
        const toggleDiscord = document.getElementById('settings-discord-toggle');
        const toggleText = document.getElementById('discord-toggle-state-text');

        if (discordData.connected) {
          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          const uName = discordData.botTag || (discordData.botInfo?.username ? `@${discordData.botInfo.username}` : 'Bot');
          if (bannerTitle) bannerTitle.textContent = `Connected to Discord (${uName})`;
          if (bannerSub) bannerSub.textContent = `Channel ID: ${discordData.channelId || 'N/A'}`;
          if (toggleDiscord) toggleDiscord.checked = true;
          if (toggleText) toggleText.textContent = 'Active';
        } else {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = 'Discord Disconnected (Standby)';
          if (bannerSub) bannerSub.textContent = discordData.configured ? 'Credentials preserved. Toggle switch ON or click "Save & Connect" to activate.' : 'Configure Bot Token, Guild ID & Channel ID to connect.';
          if (toggleDiscord) toggleDiscord.checked = false;
          if (toggleText) toggleText.textContent = 'Standby';
        }
      }

      // Populate Telegram config
      const tgData = data.telegram || data.providers?.telegram;
      if (tgData) {
        const tgApiId = document.getElementById('settings-telegram-api-id');
        const tgApiHash = document.getElementById('settings-telegram-api-hash');
        const tgBotToken = document.getElementById('settings-telegram-bot-token');
        const tgChannelId = document.getElementById('settings-telegram-channel-id');

        if (tgApiId) tgApiId.value = tgData.apiId || '';
        if (tgApiHash) tgApiHash.value = tgData.apiHash || '';
        if (tgBotToken) tgBotToken.value = tgData.botToken || '';
        if (tgChannelId) tgChannelId.value = tgData.channelId || '';

        const tgBannerDot = document.getElementById('telegram-status-dot');
        const tgBannerTitle = document.getElementById('telegram-status-title');
        const tgBannerSub = document.getElementById('telegram-status-sub');
        const toggleTelegram = document.getElementById('settings-telegram-toggle');
        const tgToggleText = document.getElementById('telegram-toggle-state-text');

        if (tgData.connected) {
          if (tgBannerDot) tgBannerDot.className = 'tg-status-dot connected';
          if (tgBannerTitle) tgBannerTitle.textContent = 'Connected to Telegram Cloud';
          if (tgBannerSub) tgBannerSub.textContent = `Channel ID: ${tgData.channelId || 'N/A'}`;
          if (toggleTelegram) toggleTelegram.checked = true;
          if (tgToggleText) tgToggleText.textContent = 'Active';
        } else {
          if (tgBannerDot) tgBannerDot.className = 'tg-status-dot disconnected';
          if (tgBannerTitle) tgBannerTitle.textContent = 'Telegram Disconnected (Standby)';
          if (tgBannerSub) tgBannerSub.textContent = tgData.configured ? 'Credentials preserved. Toggle switch ON or click "Save & Connect" to activate.' : 'Configure API ID, Hash, Bot Token & Channel ID to connect.';
          if (toggleTelegram) toggleTelegram.checked = false;
          if (tgToggleText) tgToggleText.textContent = 'Standby';
        }
      }

      // Populate Storage Policy & Security
      if (data.policy) {
        const polEl = document.getElementById('settings-storage-policy');
        const primaryEl = document.getElementById('settings-primary-provider');
        const encToggle = document.getElementById('settings-encryption-toggle');
        const effectiveMode = data.policy.defaultStorageMode || localStorage.getItem('clouddrive_default_storage_mode') || 'dual';
        const effectiveStrategy = data.policy.uploadStrategy || localStorage.getItem('clouddrive_upload_strategy') || 'primary_first';
        const effectivePrimary = data.policy.primaryProvider || localStorage.getItem('clouddrive_primary_provider') || 'telegram';
        const effectiveEnc = data.policy.encryptionEnabled !== undefined ? data.policy.encryptionEnabled : (localStorage.getItem('clouddrive_encryption_enabled') !== 'false');

        if (polEl) polEl.value = effectiveMode;
        if (primaryEl) primaryEl.value = effectivePrimary;
        if (encToggle) encToggle.checked = effectiveEnc;

        this.updateUploadStrategyDropdown(effectiveMode, effectiveStrategy);
        this.updateChunkingHints();
      }

      // Populate Storage & Cache Stats
      if (data.stats || data.storage) {
        const stats = data.stats || data.storage;
        const filesEl = document.getElementById('settings-storage-files');
        const foldersEl = document.getElementById('settings-storage-folders');
        const bytesEl = document.getElementById('settings-storage-bytes');
        const chunksTotalEl = document.getElementById('settings-storage-chunks-total');
        const dualSyncEl = document.getElementById('settings-dual-sync-text');
        const syncHintEl = document.getElementById('settings-sync-status-hint');

        if (filesEl) filesEl.textContent = `${(stats.totalFiles || 0).toLocaleString()} Files`;
        if (foldersEl) foldersEl.textContent = `${(stats.totalFolders || 0).toLocaleString()} Folders`;
        if (bytesEl) bytesEl.textContent = UI.formatFileSize(stats.totalBytes || 0);
        if (chunksTotalEl) chunksTotalEl.textContent = `${(stats.totalChunks || 0).toLocaleString()} Total Chunks`;

        if (dualSyncEl) {
          const total = stats.totalFiles || 0;
          const dual = stats.dualFiles || 0;
          const pct = total > 0 ? ((dual / total) * 100).toFixed(1) : '100.0';
          dualSyncEl.textContent = `${dual} / ${total} (${pct}%)`;
          if (syncHintEl) {
            syncHintEl.textContent = (dual >= total && total > 0) ? '100% Dual Cloud Synchronized' : (total === 0 ? 'No files yet' : `${total - dual} files pending sync`);
          }
        }

        // Discord card
        const discFiles = document.getElementById('discord-stats-files');
        const discChunks = document.getElementById('discord-stats-chunks');
        const discBytes = document.getElementById('discord-stats-bytes');
        const discChannel = document.getElementById('discord-stats-channel');
        const discBadge = document.getElementById('discord-stats-status-badge');

        if (discFiles) discFiles.textContent = `${stats.discord?.files || 0} Files`;
        if (discChunks) discChunks.textContent = `${stats.discord?.chunks || 0} Chunks`;
        if (discBytes) discBytes.textContent = UI.formatFileSize(stats.discord?.bytes || 0);
        if (discChannel) discChannel.textContent = data.discord?.channelId || '-';
        if (discBadge) {
          discBadge.className = data.discord?.connected ? 'badge-secure' : 'badge-count';
          discBadge.textContent = data.discord?.connected ? 'Connected' : 'Offline';
        }

        // Telegram card
        const tgFiles = document.getElementById('telegram-stats-files');
        const tgChunks = document.getElementById('telegram-stats-chunks');
        const tgBytes = document.getElementById('telegram-stats-bytes');
        const tgChannel = document.getElementById('telegram-stats-channel');
        const tgBadge = document.getElementById('telegram-stats-status-badge');

        if (tgFiles) tgFiles.textContent = `${stats.telegram?.files || 0} Files`;
        if (tgChunks) tgChunks.textContent = `${stats.telegram?.chunks || 0} Chunks`;
        if (tgBytes) tgBytes.textContent = UI.formatFileSize(stats.telegram?.bytes || 0);
        if (tgChannel) tgChannel.textContent = data.telegram?.channelId || '-';
        if (tgBadge) {
          tgBadge.className = data.telegram?.connected ? 'badge-secure' : 'badge-count';
          tgBadge.textContent = data.telegram?.connected ? 'Connected' : 'Offline';
        }

        // Cache
        const cacheEl = document.getElementById('settings-cache-size');
        const cacheStatusEl = document.getElementById('settings-cache-status');
        const cacheBadgeEl = document.getElementById('settings-cache-badge');
        const cacheDescriptionEl = document.getElementById('settings-cache-description');
        if (cacheEl && data.cache) {
          const enabled = data.cache.enabled === true;
          cacheEl.textContent = enabled ? UI.formatFileSize(data.cache.totalBytes || 0) : 'Disabled';
          if (cacheStatusEl) cacheStatusEl.textContent = enabled ? `Encrypted streaming cache · ${UI.formatFileSize(data.cache.limitBytes || 0)} limit` : 'Disabled for privacy — no decrypted files are retained on server';
          if (cacheBadgeEl) {
            cacheBadgeEl.textContent = enabled ? 'Auto LRU active' : 'Secure mode — off';
            cacheBadgeEl.style.background = enabled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.15)';
            cacheBadgeEl.style.color = enabled ? '#10b981' : 'var(--text-secondary)';
          }
          if (cacheDescriptionEl) cacheDescriptionEl.innerHTML = enabled
            ? `Decrypted streaming data is temporarily cached for faster playback up to <strong>${UI.formatFileSize(data.cache.limitBytes || 0)}</strong>. Older items are removed automatically.`
            : 'Secure mode is active: decrypted file data is <strong>not stored</strong> on the server, so cache usage stays at 0 B. Enable <code>ALLOW_PLAINTEXT_CACHE=true</code> on the server only if faster repeat streaming is worth retaining temporary decrypted data.';
        }
      }

      await this.loadBackupStatus();
      await this.loadWebDavSettings();
    } catch (e) {
      console.warn('Could not fetch settings details:', e);
    }
  },

  async loadAdminUsers() {
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;
    const refreshSecurity = async () => {
      const auditEl = document.getElementById('security-audit-list');
      const blockedEl = document.getElementById('blocked-ip-list');
      if (!auditEl || !blockedEl) return;
      try {
        const search = document.getElementById('security-audit-search')?.value.trim() || '';
        const action = document.getElementById('security-audit-action')?.value || '';
        const params = new URLSearchParams({ limit: '200' }); if (search) params.set('search', search); if (action) params.set('action', action);
        const [audit, blocked] = await Promise.all([API.request('GET', `/api/admin/audit-logs?${params}`), API.request('GET', '/api/admin/blocked-ips')]);
        const rows = audit.logs || audit.auditLogs || [];
        auditEl.innerHTML = rows.length ? `<table class="data-table"><thead><tr><th>User</th><th>File / details</th><th>Action</th><th>IP</th><th>User-agent</th><th>Time</th><th></th></tr></thead><tbody>${rows.map(x => { let d={}; try { d=JSON.parse(x.details||'{}') || {}; } catch (_) {} return `<tr><td>${UI.escapeHtml(x.user_email || 'Anonymous')}</td><td>${UI.escapeHtml(d.fileName || d.fileId || d.path || '')}</td><td>${UI.escapeHtml(x.action || '')}</td><td>${UI.escapeHtml(x.ip_address || '')}</td><td title="${UI.escapeHtml(x.user_agent || '')}" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${UI.escapeHtml(x.user_agent || '')}</td><td>${UI.escapeHtml(x.created_at || '')}</td><td><button class="btn-block-ip btn-secondary" data-ip="${UI.escapeHtml(x.ip_address || '')}">Block</button></td></tr>`; }).join('')}</tbody></table>` : '<span class="hint">No activity yet.</span>';
        auditEl.querySelectorAll('.btn-block-ip').forEach(btn => btn.onclick = async () => { const reason = window.prompt(`Reason for blocking ${btn.dataset.ip}:`, 'Suspicious activity') ?? ''; if (!reason) return; await API.request('POST', '/api/admin/blocked-ips', { ip: btn.dataset.ip, reason }); refreshSecurity(); });
        blockedEl.innerHTML = `<strong>Blocked IPs</strong> ${(blocked.blockedIps || []).map(x => `<span class="badge" style="margin:4px;display:inline-flex;gap:4px;">${UI.escapeHtml(x.ip_address)} <button class="btn-unblock-ip" data-ip="${UI.escapeHtml(x.ip_address)}">Unblock</button></span>`).join('')}`;
        blockedEl.querySelectorAll('.btn-unblock-ip').forEach(btn => btn.onclick = async () => { await API.request('DELETE', `/api/admin/blocked-ips/${encodeURIComponent(btn.dataset.ip)}`); refreshSecurity(); });
      } catch (e) { auditEl.textContent = e.message || 'Failed to load security activity'; }
    };
    document.getElementById('btn-refresh-security-audit')?.addEventListener('click', refreshSecurity);
    document.getElementById('security-audit-search')?.addEventListener('input', refreshSecurity);
    document.getElementById('security-audit-action')?.addEventListener('change', refreshSecurity);
    refreshSecurity();

    listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">Loading users...</div>';

    try {
      const res = await API.getAdminUsers();
      const users = (res && res.users) || [];

      if (users.length === 0) {
        listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">No users found.</div>';
        return;
      }

      listEl.innerHTML = '';
      users.forEach(u => {
        const isSelf = this.user && this.user.id === u.id;
        const usedBytes = u.storage_used || 0;
        const limitBytes = u.storage_limit || 0;
        const isUnlimited = limitBytes === 0;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((usedBytes / limitBytes) * 100));

        const userCard = document.createElement('div');
        userCard.className = 'admin-user-card';
        userCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;';

        const rawLastLogin = u.last_login_at || u.last_login || u.lastLoginAt || u.lastLogin;
        const lastLoginText = rawLastLogin ? UI.formatDate(rawLastLogin) : 'Never';
        const roleLabel = u.role === 'admin' ? 'Admin' : 'User';
        const statusClass = u.status === 'active' ? 'background: rgba(16, 185, 129, 0.15); color: #10b981;' : 'background: rgba(239, 68, 68, 0.15); color: #ef4444;';
        const roleClass = u.role === 'admin' ? 'background: rgba(99, 102, 241, 0.15); color: #6366f1;' : 'background: rgba(100, 116, 139, 0.15); color: var(--text-secondary);';

        userCard.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--accent-color); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; text-transform: uppercase; flex-shrink: 0;">
                ${UI.escapeHtml((u.name || u.email || 'U')[0])}
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <strong style="font-size: 14px; color: var(--text-primary);">${UI.escapeHtml(u.name || u.email)}</strong>
                  ${isSelf ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(59, 130, 246, 0.15); color: #3b82f6; font-weight: 600;">You</span>' : ''}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">${UI.escapeHtml(u.email)}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              ${u.file_prefix ? `<span class="flat-icon-label" style="font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; background: rgba(59, 130, 246, 0.12); color: var(--accent-color); border: 1px solid var(--border-color);" title="Upload Prefix: ${UI.escapeAttr(u.file_prefix)}">${UI.icon('tag', 12)} ${UI.escapeHtml(u.file_prefix)}</span>` : ''}
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; ${roleClass}">${roleLabel}</span>
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: capitalize; ${statusClass}">${u.status}</span>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; gap: 6px;">
            <div>
              <span>Storage: <strong>${UI.formatFileSize(usedBytes)}</strong> / ${isUnlimited ? 'Unlimited' : UI.formatFileSize(limitBytes)}</span>
              ${!isUnlimited ? ` <span style="font-size: 11px;">(${pct}%)</span>` : ''}
            </div>
            <div>Last login: <span>${lastLoginText}</span></div>
          </div>

          ${!isUnlimited ? `
          <div style="width: 100%; height: 4px; background: var(--border-color); border-radius: 2px; overflow: hidden;">
            <div style="height: 100%; width: ${pct}%; background: ${pct > 90 ? '#ef4444' : 'var(--accent-color)'}; border-radius: 2px;"></div>
          </div>` : ''}

          <div style="display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 6px; border-top: 1px solid var(--border-color); padding-top: 10px; flex-wrap: wrap;">
            <button type="button" class="btn-secondary btn-sm btn-edit-user" title="Edit User">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
              <span>Edit</span>
            </button>
            <button type="button" class="btn-secondary btn-sm btn-reset-pw" title="Reset Password">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
              <span>Reset PW</span>
            </button>
            ${!isSelf ? `
            <button type="button" class="${u.status === 'active' ? 'btn-warning' : 'btn-success'} btn-sm btn-toggle-status" title="${u.status === 'active' ? 'Suspend User' : 'Activate User'}">
              <span>${u.status === 'active' ? 'Suspend' : 'Activate'}</span>
            </button>
            <button type="button" class="btn-danger btn-sm btn-delete-user" title="Delete User">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              <span>Delete</span>
            </button>` : ''}
          </div>
        `;

        userCard.querySelector('.btn-edit-user')?.addEventListener('click', () => this.openEditUserModal(u));
        userCard.querySelector('.btn-reset-pw')?.addEventListener('click', () => this.openResetUserPwModal(u));
        userCard.querySelector('.btn-toggle-status')?.addEventListener('click', () => this.toggleUserStatus(u));
        userCard.querySelector('.btn-delete-user')?.addEventListener('click', () => this.deleteUser(u));

        listEl.appendChild(userCard);
      });
    } catch (err) {
      listEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #ef4444; font-size: 13px;">Failed to load users: ${UI.escapeHtml(err.message)}</div>`;
    }
  },

  openEditUserModal(user) {
    const idInp = document.getElementById('edit-user-id');
    const firstNameInp = document.getElementById('edit-user-first-name');
    const lastNameInp = document.getElementById('edit-user-last-name');
    const roleSel = document.getElementById('edit-user-role');
    const statusSel = document.getElementById('edit-user-status');
    const quotaInp = document.getElementById('edit-user-quota');
    const prefixInp = document.getElementById('edit-user-prefix');
    const titleEl = document.getElementById('edit-user-modal-title');
    const subEl = document.getElementById('edit-user-modal-sub');

    if (idInp) idInp.value = user.id;
    if (firstNameInp) firstNameInp.value = user.first_name || user.firstName || (user.name || '').split(/\s+/)[0] || '';
    if (lastNameInp) lastNameInp.value = user.last_name || user.lastName || (user.name || '').split(/\s+/).slice(1).join(' ');
    if (roleSel) roleSel.value = user.role || 'user';
    if (statusSel) statusSel.value = user.status || 'active';
    if (quotaInp) quotaInp.value = user.storage_limit > 0 ? (user.storage_limit / (1024 * 1024 * 1024)).toFixed(1) : 0;
    if (prefixInp) prefixInp.value = user.file_prefix || '';
    if (titleEl) titleEl.textContent = 'Edit User Account';
    if (subEl) subEl.innerHTML = `Adjust settings for <strong style="color:var(--accent-color); font-weight:600;">${UI.escapeHtml(user.email)}</strong>`;

    UI.showModal('edit-user-modal');
  },

  openResetUserPwModal(user) {
    const idInp = document.getElementById('reset-pw-user-id');
    const pwInp = document.getElementById('reset-user-new-pw');
    const titleEl = document.getElementById('reset-pw-user-title');
    const subEl = document.getElementById('reset-pw-user-sub');

    if (idInp) idInp.value = user.id;
    if (pwInp) pwInp.value = '';
    if (titleEl) titleEl.textContent = 'Reset User Password';
    if (subEl) subEl.innerHTML = `Set a new password for <strong style="color:var(--accent-color); font-weight:600;">${UI.escapeHtml(user.email)}</strong>`;

    UI.showModal('reset-user-password-modal');
    setTimeout(() => pwInp && pwInp.focus(), 100);
  },

  async toggleUserStatus(user) {
    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    const actionText = newStatus === 'suspended' ? 'Suspend' : 'Activate';

    const confirmed = await UI.confirm({
      title: `${actionText} User Account`,
      message: `Are you sure you want to ${actionText.toLowerCase()} user "${user.email}"?${newStatus === 'suspended' ? ' They will be immediately blocked from signing in.' : ''}`,
      confirmText: actionText,
      confirmType: newStatus === 'suspended' ? 'danger' : 'primary',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      await API.updateAdminUser(user.id, { status: newStatus });
      UI.showToast(`User ${user.email} is now ${newStatus}`, 'success');
      await this.loadAdminUsers();
    } catch (err) {
      UI.showToast(err.message || `Failed to ${actionText.toLowerCase()} user`, 'error');
    }
  },

  async deleteUser(user) {
    const confirmed = await UI.confirm({
      title: 'Delete User Account',
      message: `Are you sure you want to permanently delete user "${user.email}"?\n\nAll their metadata will be removed. This action cannot be undone.`,
      confirmText: 'Delete User',
      confirmType: 'danger',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      await API.deleteAdminUser(user.id);
      UI.showToast(`User ${user.email} deleted successfully`, 'success');
      await this.loadAdminUsers();
    } catch (err) {
      UI.showToast(err.message || 'Failed to delete user', 'error');
    }
  },

  async loadUserPreferences() {
    try {
      const res = await API.getPreferences();
      if (res && res.preferences) {
        const p = res.preferences;
        if (p.encryption_enabled !== undefined) {
          localStorage.setItem('clouddrive_encryption_enabled', (p.encryption_enabled === 'true' || p.encryption_enabled === true) ? 'true' : 'false');
        }
        if (p.default_storage_mode) {
          localStorage.setItem('clouddrive_default_storage_mode', p.default_storage_mode);
        }
        if (p.primary_provider) {
          localStorage.setItem('clouddrive_primary_provider', p.primary_provider);
        }
        if (p.upload_strategy) {
          localStorage.setItem('clouddrive_upload_strategy', p.upload_strategy);
        }
      }
    } catch (e) {
      console.warn('Could not load user preferences:', e);
    }
  },

  async loadWebDavSettings() {
    try {
      const urlInput = document.getElementById('webdav-url');
      if (urlInput) {
        urlInput.value = `${window.location.origin}/webdav`;
      }
      const data = await API.getWebDavSettings();
      if (!data) return;

      const isAdmin = data.isAdmin === true;

      const enabledToggle = document.getElementById('webdav-enabled');
      const modeSelect = document.getElementById('webdav-permission-mode');
      const usernameInput = document.getElementById('webdav-username');
      const userEnabledToggle = document.getElementById('webdav-user-enabled');
      const passwordInput = document.getElementById('webdav-password');
      const passwordHint = document.getElementById('webdav-pw-hint');
      const pwStatusText = document.getElementById('webdav-pw-status-text');
      const pwStatusBadge = document.getElementById('webdav-pw-status-badge');
      const btnResetPw = document.getElementById('btn-reset-webdav-pw');

      // Set values
      if (enabledToggle) enabledToggle.checked = !!data.enabled;
      if (modeSelect && data.permissionMode) modeSelect.value = data.permissionMode;
      if (usernameInput) usernameInput.value = data.username || data.userEmail || '';
      if (userEnabledToggle) userEnabledToggle.checked = data.userEnabled !== false;
      if (urlInput && data.webdavUrl) urlInput.value = data.webdavUrl;

      // Lock admin-only controls for non-admin users
      const adminOnlyNote = document.getElementById('webdav-admin-only-note');
      if (enabledToggle) {
        enabledToggle.disabled = !isAdmin;
        const toggleLabel = enabledToggle.closest('.pref-row');
        if (toggleLabel) {
          const adminTag = toggleLabel.querySelector('.webdav-admin-tag');
          if (!adminTag) {
            const tag = document.createElement('span');
            tag.className = 'webdav-admin-tag';
            tag.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:8px; background:rgba(99,102,241,0.15); color:#6366f1; font-weight:600; margin-left:6px; vertical-align:middle;';
            tag.innerHTML = `${UI.icon(isAdmin ? 'key' : 'lock', 11)} ${isAdmin ? 'Admin' : 'Admin Only'}`;
            const strong = toggleLabel.querySelector('strong');
            if (strong) strong.appendChild(tag);
          } else {
            adminTag.innerHTML = `${UI.icon(isAdmin ? 'key' : 'lock', 11)} ${isAdmin ? 'Admin' : 'Admin Only'}`;
          }
        }
      }
      if (modeSelect) {
        modeSelect.disabled = !isAdmin;
        const modeRow = modeSelect.closest('.pref-row');
        if (modeRow) {
          const adminTag = modeRow.querySelector('.webdav-admin-tag');
          if (!adminTag) {
            const tag = document.createElement('span');
            tag.className = 'webdav-admin-tag';
            tag.style.cssText = 'font-size:10px; padding:2px 7px; border-radius:8px; background:rgba(99,102,241,0.15); color:#6366f1; font-weight:600; margin-left:6px; vertical-align:middle;';
            tag.innerHTML = `${UI.icon(isAdmin ? 'key' : 'lock', 11)} ${isAdmin ? 'Admin' : 'Admin Only'}`;
            const strong = modeRow.querySelector('strong');
            if (strong) strong.appendChild(tag);
          } else {
            adminTag.innerHTML = `${UI.icon(isAdmin ? 'key' : 'lock', 11)} ${isAdmin ? 'Admin' : 'Admin Only'}`;
          }
        }
      }

      // Username is read-only — it's always the user's email
      if (usernameInput) {
        usernameInput.readOnly = true;
        usernameInput.style.background = 'var(--bg-hover)';
        usernameInput.title = 'Your WebDAV username is your CloudDrive email';
      }

      if (data.hasCustomPassword) {
        if (pwStatusText) pwStatusText.textContent = 'Custom WebDAV Password Active';
        if (pwStatusBadge) {
          pwStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
          pwStatusBadge.style.color = '#10b981';
        }
        if (btnResetPw) btnResetPw.style.display = 'inline-flex';
        if (passwordInput) passwordInput.placeholder = '•••••••• (Custom password saved)';
        if (passwordHint) {
          passwordHint.textContent = 'Dedicated WebDAV password is set. Leave blank to keep existing password, or enter a new one to change.';
          passwordHint.style.color = 'var(--accent-color)';
        }
      } else {
        if (pwStatusText) pwStatusText.textContent = 'Using Account Password';
        if (pwStatusBadge) {
          pwStatusBadge.style.background = 'rgba(59, 130, 246, 0.15)';
          pwStatusBadge.style.color = '#3b82f6';
        }
        if (btnResetPw) btnResetPw.style.display = 'none';
        if (passwordInput) passwordInput.placeholder = 'Leave blank to use Account Password';
        if (passwordHint) {
          passwordHint.textContent = 'No separate WebDAV password set — sign in with your main CloudDrive account password, or type a password to customize.';
          passwordHint.style.color = 'var(--text-secondary)';
        }
      }

      await this.loadWebDavSessions();
    } catch (e) {
      console.warn('Failed to load WebDAV settings:', e);
    }
  },

  async loadWebDavSessions(showToastOnManual = false) {
    try {
      const listEl = document.getElementById('webdav-sessions-list');
      const countBadge = document.getElementById('webdav-sessions-count');
      if (!listEl) return;

      const data = await API.getWebDavSessions();
      const sessions = (data && data.sessions) || [];
      const onlineCount = sessions.filter(s => s.isOnline).length;

      if (countBadge) {
        countBadge.textContent = `${onlineCount} Active`;
        countBadge.style.color = onlineCount > 0 ? '#34c759' : 'var(--text-secondary)';
        countBadge.style.background = onlineCount > 0 ? 'rgba(52, 199, 89, 0.15)' : 'var(--bg-hover)';
      }

      const getDeviceSvg = (osType) => {
        switch (osType) {
          case 'windows':
            return '<svg viewBox="0 0 88 88" width="22" height="22" fill="#5865F2"><path d="M0 12.402l35.689-4.86.016 34.423-35.67.202L0 12.402zm35.67 33.529l.028 34.453L.028 75.48.016 46.133l35.654-.202zm4.33-39.043L87.945 0v41.527l-47.945.31V6.888zm47.973 38.64L88 88l-48.027-6.746V45.73l48.027-.202z"/></svg>';
          case 'apple':
            return '<svg viewBox="0 0 170 170" width="22" height="22" fill="var(--text-primary)"><path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.69-7.83-11.98-14.35-5.99-9.13-10.74-19.66-14.25-31.6-3.51-11.93-5.27-23.08-5.27-33.43 0-14.56 3.7-26.68 11.09-36.37 7.39-9.69 16.74-14.65 28.05-14.88 4.78 0 10.23 1.25 16.34 3.75 6.11 2.5 10.15 3.81 12.11 3.93 1.74-.24 5.92-1.61 12.53-4.11 6.61-2.5 12.31-3.63 17.1-3.39 12.82.76 22.84 5.68 30.08 14.77-11.3 6.85-16.84 16.3-16.62 28.36.22 9.57 3.86 17.5 10.93 23.8 7.07 6.3 15.65 9.89 25.75 10.76-2.18 6.53-4.89 13.06-8.15 19.59zM119.22 31.84c0-7.39 2.67-14.25 8.01-20.57 5.34-6.32 11.9-10.45 19.68-12.38.33 1.52.49 2.94.49 4.24 0 7.39-2.83 14.47-8.49 21.23-5.66 6.76-12.41 10.66-20.25 11.7-.22-1.42-.44-2.82-.44-4.22z"/></svg>';
          case 'android':
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="#3ddc84"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-4.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 2.23 12.95 2 12 2c-.96 0-1.86.23-2.66.63L7.85.99c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 4.26 6 6.01 6 8h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>';
          case 'linux':
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="#FEE75C"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
          default:
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="var(--accent-color)"><path d="M4 6h16v12H4z M2 4c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h20c1.1 0 2-.9 2-2V6c0-1.11-.9-2-2-2H2zm0 14V6h20v12H2z"/></svg>';
        }
      };

      if (sessions.length === 0) {
        listEl.innerHTML = `
          <div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 13px; background: var(--bg-card); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
            No network devices currently connected. Connect via Windows File Explorer or iOS Files to see live session.
          </div>
        `;
      } else {
        listEl.innerHTML = sessions.map(s => {
          let statusBadge = '';
          if (s.status === 'revoked') {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(255, 69, 58, 0.15); color: #ff453a; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#ff453a;"></span>Disconnected</span>';
          } else if (s.isOnline) {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(52, 199, 89, 0.15); color: #34c759; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#34c759;"></span>Online</span>';
          } else {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(255, 179, 0, 0.15); color: #ffb300; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#ffb300;"></span>Idle</span>';
          }

          const actionBtn = s.status === 'revoked'
            ? `<button type="button" class="btn-secondary btn-unrevoke-session" data-session-id="${s.id}" style="padding: 4px 10px; font-size: 11px; color: var(--accent-color);"><span>Re-allow</span></button>`
            : `<button type="button" class="btn-secondary btn-revoke-session" data-session-id="${s.id}" style="padding: 4px 10px; font-size: 11px; color: #ff453a;"><span>Disconnect</span></button>`;

          let timeAgo = 'Just now';
          if (s.lastActiveAgoSeconds > 60) {
            const mins = Math.floor(s.lastActiveAgoSeconds / 60);
            timeAgo = `${mins}m ago`;
          }

          return `
            <div class="webdav-session-card" style="padding: 10px 12px; background: var(--bg-hover); display: flex; align-items: center; justify-content: space-between; gap: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 200px;">
                <div style="width: 34px; height: 34px; border-radius: 8px; background: var(--bg-card); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--border-color);">
                  ${getDeviceSvg(s.osType)}
                </div>
                <div style="min-width: 0; flex: 1;">
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <strong style="font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;">${s.clientName}</strong>
                    ${statusBadge}
                  </div>
                  <p style="font-size: 11px; margin: 3px 0 0; color: var(--text-secondary); line-height: 1.4; word-break: break-word;">
                    IP: <code>${s.ip}</code> · User: <strong>${s.username}</strong> · Last active: ${timeAgo} · <em>${s.lastAction || 'Active'}</em>
                  </p>
                </div>
              </div>
              <div style="flex-shrink: 0; margin-left: auto;">
                ${actionBtn}
              </div>
            </div>
          `;
        }).join('');

        // Attach Revoke & Unrevoke handlers
        listEl.querySelectorAll('.btn-revoke-session').forEach(btn => {
          btn.onclick = async () => {
            const sId = btn.getAttribute('data-session-id');
            try {
              btn.disabled = true;
              await API.revokeWebDavSession(sId);
              UI.showToast('Device session disconnected!', 'info');
              this.loadWebDavSessions();
            } catch (err) {
              UI.showToast('Failed to disconnect device: ' + err.message, 'error');
              btn.disabled = false;
            }
          };
        });

        listEl.querySelectorAll('.btn-unrevoke-session').forEach(btn => {
          btn.onclick = async () => {
            const sId = btn.getAttribute('data-session-id');
            try {
              btn.disabled = true;
              await API.unrevokeWebDavSession(sId);
              UI.showToast('Device re-allowed!', 'success');
              this.loadWebDavSessions();
            } catch (err) {
              UI.showToast('Failed to re-allow device: ' + err.message, 'error');
              btn.disabled = false;
            }
          };
        });
      }

      if (showToastOnManual) {
        UI.showToast('Connected devices list refreshed!', 'info');
      }
    } catch (e) {
      console.warn('Failed to load WebDAV sessions:', e);
    }
  },

  async loadBackupStatus() {
    try {
      const statusEl = document.getElementById('backup-status-text');
      const listContainer = document.getElementById('cloud-backups-container');
      const listEl = document.getElementById('cloud-backups-list');
      if (!statusEl) return;

      const data = await API.getBackupStatus();
      if (data && data.latestBackup) {
        const timeAgo = UI.formatDate(data.latestBackup.created_at);
        const provName = data.latestBackup.provider === 'telegram' ? 'Telegram' : 'Discord';
        const remoteMsgId = data.latestBackup.remote_id || data.latestBackup.discord_message_id || '-';
        statusEl.innerHTML = `Last backup created: <strong>${timeAgo}</strong> (${UI.formatFileSize(data.latestBackup.size)} encrypted snapshot · ${provName} Msg #${remoteMsgId})`;
      } else {
        statusEl.innerHTML = 'Automatic schedule active. First automated cloud backup will run within 24h.';
      }

      if (listContainer && listEl) {
        if (data && data.history && data.history.length > 0) {
          listContainer.style.display = 'block';
          listEl.innerHTML = data.history.map(b => {
            const timeStr = UI.formatDate(b.created_at);
            const sizeStr = UI.formatFileSize(b.size);
            const isTg = b.provider === 'telegram';
            const provName = isTg ? 'Telegram' : 'Discord';
            const provColor = isTg ? '#38bdf8' : '#818cf8';
            const provBg = isTg ? 'rgba(56, 189, 248, 0.12)' : 'rgba(129, 140, 248, 0.12)';
            const provIconSvg = isTg
              ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>`
              : `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
            const remoteId = b.remote_id || b.discord_message_id || '-';

            return `
              <div class="cache-action-box" style="padding: 10px 14px; background: var(--bg-hover); display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 220px;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <strong style="font-size: 13px;">${b.file_name}</strong>
                    <span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; color: ${provColor}; background: ${provBg};">
                      ${provIconSvg} ${provName}
                    </span>
                  </div>
                  <p style="font-size: 12px; margin: 3px 0 0; color: var(--text-secondary);">
                    ${timeStr} · ${sizeStr} · Msg #${remoteId}
                  </p>
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <button type="button" class="btn-secondary btn-restore-cloud-backup" data-id="${b.id}" data-remote-id="${remoteId}" data-provider="${b.provider || 'discord'}" style="padding: 6px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                    <span>Restore</span>
                  </button>
                  <button type="button" class="btn-danger btn-delete-cloud-backup" data-id="${b.id}" data-file="${b.file_name}" style="padding: 6px 10px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;" title="Delete this backup snapshot">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            `;
          }).join('');

          // Attach restore handlers
          listEl.querySelectorAll('.btn-restore-cloud-backup').forEach(btn => {
            btn.onclick = async () => {
              const remoteId = btn.getAttribute('data-remote-id');
              const provider = btn.getAttribute('data-provider') || 'discord';
              const provTitle = provider === 'telegram' ? 'Telegram' : 'Discord';
              const confirmed = await UI.confirm({
                title: 'Restore Database from Cloud?',
                message: `Are you sure you want to restore database from ${provTitle} Cloud Backup (Msg #${remoteId})?`,
                description: `CloudDrive will download the encrypted backup from ${provTitle}, decrypt it using your master encryption key, and restore all files/users.`,
                icon: 'warning',
                confirmText: 'Restore & Reload',
                confirmType: 'danger',
                cancelText: 'Cancel'
              });

              if (!confirmed) return;

              btn.disabled = true;
              btn.innerHTML = '<span>Restoring...</span>';
              UI.showToast(`Downloading & decrypting cloud backup from ${provTitle}...`, 'info', 10000);

              try {
                const res = await API.restoreCloudBackup(remoteId, provider);
                UI.showToast(res.message || 'Database restored successfully! Reloading...', 'success', 4000);
                setTimeout(() => window.location.reload(), 1500);
              } catch (err) {
                UI.showToast('Cloud restore failed: ' + err.message, 'error', 6000);
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg><span>Restore</span>';
              }
            };
          });

          // Attach delete handlers
          listEl.querySelectorAll('.btn-delete-cloud-backup').forEach(btn => {
            btn.onclick = async () => {
              const id = btn.getAttribute('data-id');
              const fileName = btn.getAttribute('data-file');
              const confirmed = await UI.confirm({
                title: 'Delete Cloud Backup?',
                message: `Are you sure you want to delete backup snapshot "${fileName}"?`,
                description: 'This will permanently delete the encrypted database snapshot from cloud storage and remove it from your backup history.',
                icon: 'danger',
                confirmText: 'Delete Backup',
                confirmType: 'danger',
                cancelText: 'Cancel'
              });

              if (!confirmed) return;

              btn.disabled = true;
              btn.innerHTML = '<span>Deleting...</span>';

              try {
                const res = await API.deleteCloudBackup(id);
                UI.showToast(res.message || 'Cloud backup deleted successfully!', 'success');
                await this.loadBackupStatus();
              } catch (err) {
                UI.showToast('Failed to delete backup: ' + err.message, 'error');
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg><span>Delete</span>';
              }
            };
          });
        } else {
          listContainer.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('Failed to load backup status:', e);
    }
  },

  sortItems() {
    const isAsc = this.sortOrder === 'asc';
    const mult = isAsc ? 1 : -1;

    this.folders.sort((a, b) => {
      if (this.sortBy === 'name') return mult * (a.name || '').localeCompare(b.name || '');
      if (this.sortBy === 'date') return mult * (new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0));
      return (a.name || '').localeCompare(b.name || '');
    });

    this.files.sort((a, b) => {
      if (this.sortBy === 'name') return mult * (a.name || '').localeCompare(b.name || '');
      if (this.sortBy === 'date') return mult * (new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0));
      if (this.sortBy === 'size') return mult * ((a.size || 0) - (b.size || 0));
      return (a.name || '').localeCompare(b.name || '');
    });
  },

  initRealtimeEvents() {
    if (this._eventSource) {
      try { this._eventSource.close(); } catch (e) {}
      this._eventSource = null;
    }

    if (!this.user) return;

    try {
      const es = new EventSource('/api/realtime/events', { withCredentials: true });
      this._eventSource = es;

      es.addEventListener('file_uploaded', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.file) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data.file.user_id && currentUserId && data.file.user_id !== currentUserId) return;
          this.addUploadedFileLocally(data.file);
        } catch (err) {
          console.warn('[Realtime] file_uploaded error:', err);
        }
      });

      es.addEventListener('remote_upload_progress', (e) => {
        try {
          const data = JSON.parse(e.data);
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data && data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data && data.taskId && window.Upload && typeof window.Upload.handleRemoteProgress === 'function') {
            window.Upload.handleRemoteProgress(data);
          }
        } catch (err) {
          console.warn('[Realtime] remote_upload_progress error:', err);
        }
      });

      es.addEventListener('remote_upload_completed', (e) => {
        try {
          const data = JSON.parse(e.data);
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data && data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data && data.taskId && window.Upload && typeof window.Upload.handleRemoteCompleted === 'function') {
            window.Upload.handleRemoteCompleted(data);
          }
        } catch (err) {
          console.warn('[Realtime] remote_upload_completed error:', err);
        }
      });

      es.addEventListener('file_deleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.fileId) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          this.removeFileLocally(data.fileId);
        } catch (err) {
          console.warn('[Realtime] file_deleted error:', err);
        }
      });

      es.addEventListener('file_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.file) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data.file.user_id && currentUserId && data.file.user_id !== currentUserId) return;
          this.updateFileLocally(data.file);
        } catch (err) {
          console.warn('[Realtime] file_updated error:', err);
        }
      });

      es.addEventListener('folder_created', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folder) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data.folder.user_id && currentUserId && data.folder.user_id !== currentUserId) return;
          this.addUploadedFolderLocally(data.folder);
        } catch (err) {
          console.warn('[Realtime] folder_created error:', err);
        }
      });

      es.addEventListener('folder_deleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folderId) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          this.removeFolderLocally(data.folderId);
        } catch (err) {
          console.warn('[Realtime] folder_deleted error:', err);
        }
      });

      es.addEventListener('folder_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folder) return;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data.userId && currentUserId && data.userId !== currentUserId) return;
          if (data.folder.user_id && currentUserId && data.folder.user_id !== currentUserId) return;
          this.updateFolderLocally(data.folder);
        } catch (err) {
          console.warn('[Realtime] folder_updated error:', err);
        }
      });

      es.addEventListener('trash_emptied', (e) => {
        try {
          const data = e.data ? JSON.parse(e.data) : null;
          const currentUserId = window.Auth && window.Auth.currentUser ? window.Auth.currentUser.id : null;
          if (data && data.userId && currentUserId && data.userId !== currentUserId) return;
          if (this.currentView === 'trash') {
            this.files = [];
            this.folders = [];
            this.renderContents();
          }
          this.loadStorageStats();
        } catch (err) {}
      });

      es.onerror = () => {
        // EventSource automatically retries
      };
    } catch (e) {
      console.warn('[Realtime] Failed to initialize SSE:', e);
    }
  },

  updateSortButtonsUI() {
    document.querySelectorAll('.sort-btn').forEach(btn => {
      const sort = btn.getAttribute('data-sort');
      const label = sort.charAt(0).toUpperCase() + sort.slice(1);
      if (this.sortBy === sort) {
        btn.classList.add('active');
        const arrow = this.sortOrder === 'asc' ? '↑' : '↓';
        btn.innerHTML = `${label} <span class="sort-arrow">${arrow}</span>`;
      } else {
        btn.classList.remove('active');
        btn.innerHTML = label;
      }
    });
  },

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isInputActive = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);

      // 1. Ctrl+A / Cmd+A -> Select all items in view (when not typing in an input)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (!isInputActive) {
          e.preventDefault();
          const allItems = [...this.folders, ...this.files];
          UI.selectAll(allItems);
          return;
        }
      }

      // 2. Escape -> Close modals / Close preview / Clear selection
      if (e.key === 'Escape') {
        const subModalIds = ['edit-user-modal', 'create-user-modal', 'reset-user-password-modal', 'custom-confirm-modal', 'remote-upload-modal'];
        const openSubModal = subModalIds.find(id => {
          const el = document.getElementById(id);
          return el && el.classList.contains('visible') && el.style.display !== 'none';
        });
        if (openSubModal) {
          UI.hideModal(openSubModal);
          return;
        }
        const anyModal = document.querySelector('.modal.visible');
        if (anyModal) {
          UI.hideAllModals();
          return;
        }
        const previewOverlay = document.getElementById('preview-overlay');
        if (previewOverlay && previewOverlay.style.display !== 'none') {
          if (typeof Preview !== 'undefined' && Preview.close) Preview.close();
          return;
        }
        if (UI.selectedItems.size > 0) {
          UI.clearSelection();
          return;
        }
      }

      // 3. Delete / Backspace -> Trash or Delete selected items
      if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.ctrlKey || e.metaKey))) && !isInputActive) {
        if (UI.selectedItems.size > 0) {
          e.preventDefault();
          const actionDelete = document.getElementById('action-delete');
          const actionPermanentDelete = document.getElementById('action-permanent-delete');
          if (this.currentView === 'trash' && actionPermanentDelete && actionPermanentDelete.style.display !== 'none') {
            actionPermanentDelete.click();
          } else if (actionDelete && actionDelete.style.display !== 'none') {
            actionDelete.click();
          }
          return;
        }
      }

      // 4. F2 -> Rename selected item
      if (e.key === 'F2' && !isInputActive) {
        if (UI.selectedItems.size === 1) {
          e.preventDefault();
          const selected = Array.from(UI.selectedItems.values())[0];
          const fullItem = selected.type === 'folder' ? this.foldersMap.get(selected.id) : this.filesMap.get(selected.id);
          if (fullItem) this.openRenameModal(fullItem);
          return;
        }
      }

      // 5. Space -> Quick Preview single selected file
      if (e.key === ' ' && !isInputActive) {
        const previewOverlay = document.getElementById('preview-overlay');
        if (!previewOverlay || previewOverlay.style.display === 'none') {
          if (UI.selectedItems.size === 1) {
            const selected = Array.from(UI.selectedItems.values())[0];
            if (selected.type === 'file') {
              e.preventDefault();
              const file = this.filesMap.get(selected.id);
              if (file && typeof Preview !== 'undefined' && Preview.open) Preview.open(file);
              return;
            }
          }
        }
      }
    });
  },

  setTheme(theme, sync = true) {
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;
    const currentTheme = root.getAttribute('data-theme') || 'light';
    const themeChanged = currentTheme !== normalizedTheme;

    if (themeChanged) {
      const switchId = (this._themeSwitchId || 0) + 1;
      this._themeSwitchId = switchId;
      root.classList.add('theme-switching');
      root.setAttribute('data-theme', normalizedTheme);
      root.style.colorScheme = normalizedTheme;

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this._themeSwitchId === switchId) root.classList.remove('theme-switching');
        });
      });
    }
    localStorage.setItem('discorddrive_theme', normalizedTheme);
    this.updateThemeToggleIcon(normalizedTheme);
    const themeColor = document.getElementById('app-theme-color');
    if (themeColor) themeColor.setAttribute('content', normalizedTheme === 'dark' ? '#0a0f1d' : '#f8fafc');

    // Sync Appearance buttons in settings modal if open/rendered
    const themeBtnLight = document.getElementById('theme-btn-light');
    const themeBtnDark = document.getElementById('theme-btn-dark');
    if (themeBtnLight && themeBtnDark) {
      if (normalizedTheme === 'dark') {
        themeBtnDark.classList.add('active');
        themeBtnLight.classList.remove('active');
      } else {
        themeBtnLight.classList.add('active');
        themeBtnDark.classList.remove('active');
      }
    }

    if (sync) {
      if (this._themePreferenceTimer) clearTimeout(this._themePreferenceTimer);
      if (this.user) {
        this._themePreferenceTimer = setTimeout(() => {
          this.saveUserPreference('theme', normalizedTheme);
          this._themePreferenceTimer = null;
        }, 240);
      }
    }
  },

  initTheme() {
    const stored = localStorage.getItem('discorddrive_theme');
    const saved = stored === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', saved);
    document.documentElement.style.colorScheme = saved;
    this.updateThemeToggleIcon(saved);
  },

  updateThemeToggleIcon(theme) {
    const themeToggle = document.getElementById('theme-toggle');
    const loginThemeToggle = document.getElementById('login-theme-toggle');
    const darkSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    const lightSvg = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

    if (themeToggle) {
      themeToggle.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      themeToggle.setAttribute('aria-label', themeToggle.title);
      const profileIcon = themeToggle.querySelector('.profile-theme-icon');
      const profileLabel = themeToggle.querySelector('.profile-theme-label');
      const iconTarget = profileIcon || themeToggle;
      if (iconTarget.dataset.themeIcon !== theme) {
        iconTarget.innerHTML = theme === 'dark' ? darkSvg : lightSvg;
        iconTarget.dataset.themeIcon = theme;
      }
      if (profileLabel) profileLabel.textContent = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
    if (loginThemeToggle) {
      loginThemeToggle.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      loginThemeToggle.setAttribute('aria-label', loginThemeToggle.title);
      if (loginThemeToggle.dataset.themeIcon !== theme) {
        loginThemeToggle.innerHTML = theme === 'dark' ? darkSvg : lightSvg;
        loginThemeToggle.dataset.themeIcon = theme;
      }
    }
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    this.setTheme(next);
  },

  applyPreferences(p) {
    if (!p || typeof p !== 'object') return;
    if (p.theme && (p.theme === 'light' || p.theme === 'dark')) {
      this.setTheme(p.theme, false);
    }
    if (p.view_mode && (p.view_mode === 'grid' || p.view_mode === 'list')) {
      this.viewMode = p.view_mode;
      localStorage.setItem('discorddrive_view_mode', p.view_mode);
      const gridViewBtn = document.getElementById('view-grid-btn');
      const listViewBtn = document.getElementById('view-list-btn');
      if (gridViewBtn) {
        gridViewBtn.classList.toggle('active', this.viewMode === 'grid');
        gridViewBtn.setAttribute('aria-pressed', String(this.viewMode === 'grid'));
      }
      if (listViewBtn) {
        listViewBtn.classList.toggle('active', this.viewMode === 'list');
        listViewBtn.setAttribute('aria-pressed', String(this.viewMode === 'list'));
      }
    }
    if (p.sort_by) {
      this.sortBy = p.sort_by;
      localStorage.setItem('discorddrive_sort_by', p.sort_by);
    }
    if (p.sort_order) {
      this.sortOrder = p.sort_order;
      localStorage.setItem('discorddrive_sort_order', p.sort_order);
    }
    if (p.discord_chunk_size || p.chunk_size) {
      const val = String(p.discord_chunk_size || p.chunk_size);
      localStorage.setItem('clouddrive_discord_chunk_size', val);
      localStorage.setItem('discorddrive_chunk_size', val);
      const discSelect = document.getElementById('pref-discord-chunk-size') || document.getElementById('pref-chunk-size');
      if (discSelect) {
        const presets = ['9961472', '20971520', '47185920', '99614720', '471859200'];
        if (presets.includes(val)) {
          discSelect.value = val;
        } else {
          discSelect.value = 'custom';
          const customWrap = document.getElementById('pref-discord-custom-chunk-wrap') || document.getElementById('pref-custom-chunk-wrap');
          const customInput = document.getElementById('pref-discord-custom-chunk-input') || document.getElementById('pref-custom-chunk-input');
          if (customWrap) customWrap.style.display = 'flex';
          if (customInput) customInput.value = (parseFloat(val) / (1024 * 1024)).toFixed(1);
        }
      }
    }

    if (p.telegram_chunk_size) {
      const val = String(p.telegram_chunk_size);
      localStorage.setItem('clouddrive_telegram_chunk_size', val);
      const tgSelect = document.getElementById('pref-telegram-chunk-size');
      if (tgSelect) {
        const presets = ['20971520', '47185920', '99614720', '209715200', '471859200'];
        if (presets.includes(val)) {
          tgSelect.value = val;
        } else {
          tgSelect.value = 'custom';
          const customWrap = document.getElementById('pref-telegram-custom-chunk-wrap');
          const customInput = document.getElementById('pref-telegram-custom-chunk-input');
          if (customWrap) customWrap.style.display = 'flex';
          if (customInput) customInput.value = (parseFloat(val) / (1024 * 1024)).toFixed(1);
        }
      }
    }

    if (p.concurrent_chunks) {
      localStorage.setItem('discorddrive_concurrent_chunks', p.concurrent_chunks);
      const concSelect = document.getElementById('pref-concurrent-chunks') || document.getElementById('setting-concurrent-chunks');
      if (concSelect) concSelect.value = p.concurrent_chunks;
    }
    if (p.wake_lock !== undefined && p.wake_lock !== null) {
      localStorage.setItem('discorddrive_wake_lock', p.wake_lock);
      const wakeLockCheckbox = document.getElementById('pref-wake-lock') || document.getElementById('setting-wake-lock');
      if (wakeLockCheckbox) wakeLockCheckbox.checked = p.wake_lock === 'true' || p.wake_lock === true;
    }

    if (p.encryption_enabled !== undefined && p.encryption_enabled !== null) {
      const isEnc = p.encryption_enabled === 'true' || p.encryption_enabled === true;
      localStorage.setItem('clouddrive_encryption_enabled', isEnc ? 'true' : 'false');
      const encToggle = document.getElementById('settings-encryption-toggle');
      if (encToggle) encToggle.checked = isEnc;
    }

    if (p.default_storage_mode) {
      localStorage.setItem('clouddrive_default_storage_mode', p.default_storage_mode);
      if (this.user) this.user.default_storage_mode = p.default_storage_mode;
      const polEl = document.getElementById('settings-storage-policy');
      if (polEl) polEl.value = p.default_storage_mode;
    }

    if (p.primary_provider) {
      localStorage.setItem('clouddrive_primary_provider', p.primary_provider);
      if (this.user) this.user.primary_provider = p.primary_provider;
      const primaryEl = document.getElementById('settings-primary-provider');
      if (primaryEl) primaryEl.value = p.primary_provider;
    }

    if (p.upload_strategy) {
      localStorage.setItem('clouddrive_upload_strategy', p.upload_strategy);
      const stratEl = document.getElementById('settings-upload-strategy');
      if (stratEl) stratEl.value = p.upload_strategy;
    }

    if (p.file_prefix !== undefined && p.file_prefix !== null) {
      localStorage.setItem('clouddrive_file_prefix', p.file_prefix);
      if (this.user) this.user.file_prefix = p.file_prefix;
      const prefixInput = document.getElementById('pref-file-prefix') || document.getElementById('settings-file-prefix');
      if (prefixInput) prefixInput.value = p.file_prefix;
    }

    this.updateSortButtonsUI();
    this.updateUploadStrategyDropdown();
    this.updateChunkingHints();
  },

  updateChunkingHints() {
    const hintEl = document.getElementById('chunk-provider-hint');
    const policyEl = document.getElementById('settings-storage-policy');
    const mode = policyEl?.value || (this.user?.default_storage_mode) || localStorage.getItem('clouddrive_default_storage_mode') || 'dual';

    if (!hintEl) return;

    const discBytes = parseFloat(localStorage.getItem('clouddrive_discord_chunk_size') || localStorage.getItem('discorddrive_chunk_size') || '9961472');
    const tgBytes = parseFloat(localStorage.getItem('clouddrive_telegram_chunk_size') || '20971520');
    const discMb = (discBytes / (1024 * 1024)).toFixed(1);
    const tgMb = (tgBytes / (1024 * 1024)).toFixed(1);
    const dualMb = (Math.min(discBytes, tgBytes) / (1024 * 1024)).toFixed(1);

    if (mode === 'telegram') {
      hintEl.innerHTML = `
        <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 6px; padding: 6px 10px; background: rgba(56, 189, 248, 0.08); border-left: 3px solid #38bdf8; border-radius: 4px;">
          <strong style="color: #38bdf8;">Telegram Only Active:</strong> Large files split into <strong>${tgMb} MB</strong> chunks (Ultra-fast direct Telegram upload).
        </div>
      `;
    } else if (mode === 'discord') {
      hintEl.innerHTML = `
        <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 6px; padding: 6px 10px; background: rgba(99, 102, 241, 0.08); border-left: 3px solid #6366f1; border-radius: 4px;">
          <strong style="color: #6366f1;">Discord Only Active:</strong> Large files split into <strong>${discMb} MB</strong> chunks (Direct Discord channel storage).
        </div>
      `;
    } else {
      hintEl.innerHTML = `
        <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 6px; padding: 6px 10px; background: rgba(16, 185, 129, 0.08); border-left: 3px solid #10b981; border-radius: 4px;">
          <strong style="color: #10b981;">Dual Cloud Active (Telegram + Discord):</strong> Automatically uses <strong>${dualMb} MB</strong> chunks (Discord: ${discMb} MB, Telegram: ${tgMb} MB) for 100% reliable cross-replication between both clouds without hitting file limits.
        </div>
      `;
    }
  },

  async loadUserPreferences() {
    try {
      const data = await API.getPreferences();
      if (data && data.preferences) {
        this.applyPreferences(data.preferences);
      }
    } catch (e) {
      console.warn('[Preferences] Could not load preferences from server:', e.message);
    }
  },

  async saveUserPreference(key, value) {
    localStorage.setItem(`discorddrive_${key}`, String(value));
    try {
      await API.updatePreferences({ [key]: value });
    } catch (e) {
      console.warn(`[Preferences] Failed to sync ${key} to server:`, e.message);
    }
  },

  async saveUserPreferences(obj) {
    for (const [k, v] of Object.entries(obj)) {
      localStorage.setItem(`discorddrive_${k}`, String(v));
    }
    try {
      await API.updatePreferences(obj);
    } catch (e) {
      console.warn('[Preferences] Failed to sync preferences to server:', e.message);
    }
  }
};

// Start App when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
// Admin-protected recovery and Telegram cleanup actions. Delegation keeps these
// controls live after PWA restores, cache updates, and client-side navigation.
function initAdminRecoveryActions() {
  if (document.documentElement.dataset.adminRecoveryActionsBound === 'true') return;
  document.documentElement.dataset.adminRecoveryActionsBound = 'true';
  document.addEventListener('click', async (event) => {
    const adminCenterLink = event.target.closest('#sidebar-admin-center-link');
    if (adminCenterLink) {
      event.preventDefault();
      if (!App.user || App.user.role !== 'admin') return;
      await App.navigateToView('admin-center');
      return;
    }
    const download = event.target.closest('#btn-download-recovery-bundle');
    if (download) {
      event.preventDefault();
    const password = window.prompt('Enter your admin password to download the recovery bundle:');
    if (!password) return;
    const response = await fetch('/api/settings/download-recovery-bundle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) return window.alert((await response.json().catch(() => ({}))).error || 'Download failed');
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'clouddrive-recovery-bundle.json'; a.click(); URL.revokeObjectURL(url);
      return;
    }
    const purge = event.target.closest('#btn-purge-telegram-known');
    if (!purge) return;
    event.preventDefault();
    const credentials = await openTelegramPurgeModal();
    if (!credentials) return;
    purge.disabled = true;
    const originalLabel = purge.textContent;
    purge.textContent = 'Deleting Telegram uploads…';
    try {
      const response = await fetch('/api/settings/telegram/purge-known', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
      const data = await response.json().catch(() => ({}));
      UI.showToast(data.message || data.error || 'Cleanup failed', response.ok ? 'success' : 'error');
    } catch (error) {
      UI.showToast(`Cleanup request failed: ${error.message}`, 'error');
    } finally {
      purge.disabled = false;
      purge.textContent = originalLabel;
    }
  });
}

function openTelegramPurgeModal() {
  return new Promise(resolve => {
    const modal = document.getElementById('telegram-purge-modal');
    const password = document.getElementById('telegram-purge-password');
    const confirmation = document.getElementById('telegram-purge-confirmation');
    const confirm = document.getElementById('telegram-purge-confirm');
    const cancel = document.getElementById('telegram-purge-cancel');
    if (!modal || !password || !confirmation || !confirm || !cancel || typeof UI === 'undefined') return resolve(null);

    password.value = '';
    confirmation.value = '';
    const refresh = () => {
      confirm.disabled = !(password.value && confirmation.value === 'DELETE_ALL_TELEGRAM_MESSAGES');
    };
    const close = result => {
      password.removeEventListener('input', refresh);
      confirmation.removeEventListener('input', refresh);
      UI.hideModal('telegram-purge-modal');
      resolve(result);
    };
    password.addEventListener('input', refresh);
    confirmation.addEventListener('input', refresh);
    cancel.onclick = () => close(null);
    confirm.onclick = () => close({ password: password.value, confirmation: confirmation.value });
    UI.showModal('telegram-purge-modal');
    refresh();
    password.focus();
  });
}
initAdminRecoveryActions();
