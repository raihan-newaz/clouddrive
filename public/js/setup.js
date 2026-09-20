/**
 * CloudDrive Initial Setup Wizard Controller
 */
const Setup = {
  currentStep: 1,
  totalSteps: 4,
  isTesting: false,
  isSubmitting: false,

  async checkStatus() {
    try {
      const status = await API.getSetupStatus();
      if (status && status.isComplete === false) {
        if (typeof App !== 'undefined' && App.showScreen) {
          App.showScreen('setup');
        }
        this.init();
      }
    } catch (e) {
      console.warn('[Setup] Status check failed:', e.message);
    }
  },

  init() {
    this.currentStep = 1;
    this.goToStep(1);
    this.bindEvents();
  },

  bindEvents() {
    // Step 1: Next
    const btnStep1Next = document.getElementById('btn-step-1-next');
    if (btnStep1Next) {
      btnStep1Next.onclick = () => {
        const apiId = (document.getElementById('setup-telegram-api-id')?.value || '').trim();
        const apiHash = (document.getElementById('setup-telegram-api-hash')?.value || '').trim();
        const botToken = (document.getElementById('setup-telegram-bot-token')?.value || '').trim();
        const channelId = (document.getElementById('setup-telegram-channel-id')?.value || '').trim();

        if (!apiId || !/^\d+$/.test(apiId)) {
          UI.showToast('Please enter a valid Telegram API ID', 'error');
          document.getElementById('setup-telegram-api-id')?.focus();
          return;
        }
        if (!apiHash) {
          UI.showToast('Please enter your Telegram API Hash', 'error');
          document.getElementById('setup-telegram-api-hash')?.focus();
          return;
        }
        if (!botToken) {
          UI.showToast('Please enter your Telegram Bot Token', 'error');
          document.getElementById('setup-telegram-bot-token')?.focus();
          return;
        }
        if (!channelId) {
          UI.showToast('Please enter your Telegram Channel ID', 'error');
          document.getElementById('setup-telegram-channel-id')?.focus();
          return;
        }
        this.goToStep(2);
      };
    }

    const btnTestTelegram = document.getElementById('btn-test-telegram');
    if (btnTestTelegram) btnTestTelegram.onclick = () => this.testTelegramConnection();

    // Step 2: Discord is optional; continue even when all fields are empty.
    const btnStep2Next = document.getElementById('btn-step-2-next');
    if (btnStep2Next) {
      btnStep2Next.onclick = () => {
        const token = (document.getElementById('setup-bot-token')?.value || '').trim();
        const guild = (document.getElementById('setup-guild-id')?.value || '').trim();
        const channel = (document.getElementById('setup-channel-id')?.value || '').trim();
        if ((token || guild || channel) && (!token || !channel)) {
          UI.showToast('Enter both Discord Bot Token and Channel ID, or skip Discord entirely', 'error');
          return;
        }
        this.goToStep(3);
      };
    }

    // Step 2: Back
    const btnStep2Prev = document.getElementById('btn-step-2-prev');
    if (btnStep2Prev) {
      btnStep2Prev.onclick = () => this.goToStep(1);
    }

    // Step 3: Back & Next
    const btnStep3Prev = document.getElementById('btn-step-3-prev');
    if (btnStep3Prev) {
      btnStep3Prev.onclick = () => this.goToStep(2);
    }

    const btnStep3Next = document.getElementById('btn-step-3-next');
    if (btnStep3Next) {
      btnStep3Next.onclick = () => {
        const adminName = (document.getElementById('setup-admin-name')?.value || '').trim();
        const adminEmail = (document.getElementById('setup-admin-email')?.value || '').trim().toLowerCase();
        const password = (document.getElementById('setup-password')?.value || '').trim();
        const key = (document.getElementById('setup-key')?.value || '').trim();

        if (!adminName || adminName.length < 2) {
          UI.showToast('Please enter the admin name', 'error');
          document.getElementById('setup-admin-name')?.focus();
          return;
        }
        if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
          UI.showToast('Please enter a valid admin email address', 'error');
          document.getElementById('setup-admin-email')?.focus();
          return;
        }
        if (!password || password.length < 6) {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast('Master password must be at least 6 characters', 'error');
          } else {
            alert('Master password must be at least 6 characters');
          }
          document.getElementById('setup-password')?.focus();
          return;
        }

        if (!key) {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast('Please enter an encryption passphrase', 'error');
          } else {
            alert('Please enter an encryption passphrase');
          }
          document.getElementById('setup-key')?.focus();
          return;
        }

        this.goToStep(4);
      };
    }

    // Step 4: Back, Test Connection, Complete
    const btnStep4Prev = document.getElementById('btn-step-4-prev');
    if (btnStep4Prev) {
      btnStep4Prev.onclick = () => this.goToStep(3);
    }

    const btnTest = document.getElementById('btn-test-connection');
    if (btnTest) {
      btnTest.onclick = () => this.testConnection();
    }

    const btnComplete = document.getElementById('btn-complete-setup');
    if (btnComplete) {
      btnComplete.onclick = () => this.completeSetup();
    }
  },

  goToStep(step) {
    this.currentStep = step;

    // Show only the active step
    for (let i = 1; i <= this.totalSteps; i++) {
      const stepEl = document.getElementById(`wizard-step-${i}`);
      if (stepEl) {
        stepEl.style.display = i === step ? 'block' : 'none';
      }
    }

    // Update progress nodes
    const nodes = document.querySelectorAll('.wizard-progress .step-node');
    nodes.forEach(node => {
      const nodeStep = parseInt(node.getAttribute('data-step'), 10);
      node.classList.remove('active', 'completed');
      if (nodeStep === step) {
        node.classList.add('active');
      } else if (nodeStep < step) {
        node.classList.add('completed');
      }
    });

    // Auto-focus input of active step
    setTimeout(() => {
      if (step === 1) document.getElementById('setup-telegram-api-id')?.focus();
      if (step === 2) document.getElementById('setup-bot-token')?.focus();
      if (step === 3) document.getElementById('setup-admin-name')?.focus();
    }, 100);
  },

  async testConnection() {
    if (this.isTesting) return;
    this.isTesting = true;

    const statusBox = document.getElementById('setup-test-status');
    const btnTest = document.getElementById('btn-test-connection');

    if (statusBox) {
      statusBox.style.display = 'block';
      statusBox.className = 'test-status-box info';
      statusBox.innerHTML = `<span>Connecting to Discord bot & checking channel permissions...</span>`;
    }
    if (btnTest) btnTest.disabled = true;

    const botToken = (document.getElementById('setup-bot-token')?.value || '').trim();
    const guildId = (document.getElementById('setup-guild-id')?.value || '').trim();
    const channelId = (document.getElementById('setup-channel-id')?.value || '').trim();

    try {
      const res = await API.request('POST', '/api/setup/test-discord', {
        botToken,
        guildId,
        channelId
      });

      if (res && res.success) {
        if (statusBox) {
          statusBox.className = 'test-status-box success';
          statusBox.innerHTML = `<strong class="flat-icon-label">${UI.icon('check', 16)} Connection Successful!</strong> Connected as <b>${UI.escapeHtml(res.bot?.username || 'Bot')}</b>. Storage channel is verified.`;
        }
        if (typeof UI !== 'undefined' && UI.showToast) {
          UI.showToast('Discord connection verified successfully!', 'success');
        }
      } else {
        throw new Error(res?.error || 'Discord validation failed');
      }
    } catch (err) {
      if (statusBox) {
        statusBox.className = 'test-status-box error';
        statusBox.innerHTML = `<strong class="flat-icon-label">${UI.icon('error', 16)} Connection Failed:</strong> ${UI.escapeHtml(err.message || 'Could not connect to Discord')}`;
      }
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast(err.message || 'Discord connection failed', 'error');
      }
    } finally {
      this.isTesting = false;
      if (btnTest) btnTest.disabled = false;
    }
  },

  async testTelegramConnection() {
    if (this.isTesting) return;
    this.isTesting = true;
    const btn = document.getElementById('btn-test-telegram');
    const apiId = (document.getElementById('setup-telegram-api-id')?.value || '').trim();
    const apiHash = (document.getElementById('setup-telegram-api-hash')?.value || '').trim();
    const botToken = (document.getElementById('setup-telegram-bot-token')?.value || '').trim();
    const channelId = (document.getElementById('setup-telegram-channel-id')?.value || '').trim();
    if (!apiId || !apiHash || !botToken) {
      UI.showToast('Complete the Telegram fields before testing', 'error');
      this.isTesting = false;
      return;
    }
    if (btn) { btn.disabled = true; btn.innerHTML = '<span>Testing…</span>'; }
    try {
      const res = await API.request('POST', '/api/setup/test-telegram', { apiId, apiHash, botToken, channelId });
      if (!res?.success) throw new Error(res?.error || 'Telegram validation failed');
      UI.showToast('Telegram connection verified successfully!', 'success');
    } catch (err) {
      UI.showToast(err.message || 'Telegram connection failed', 'error');
    } finally {
      this.isTesting = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<span>Test Telegram</span>'; }
    }
  },

  async completeSetup() {
    if (this.isSubmitting) return;
    this.isSubmitting = true;

    const btnComplete = document.getElementById('btn-complete-setup');
    if (btnComplete) {
      btnComplete.disabled = true;
      btnComplete.innerHTML = `<span>Setting up CloudDrive...</span>`;
    }

    const botToken = (document.getElementById('setup-bot-token')?.value || '').trim();
    const guildId = (document.getElementById('setup-guild-id')?.value || '').trim();
    const channelId = (document.getElementById('setup-channel-id')?.value || '').trim();
    const telegramApiId = (document.getElementById('setup-telegram-api-id')?.value || '').trim();
    const telegramApiHash = (document.getElementById('setup-telegram-api-hash')?.value || '').trim();
    const telegramBotToken = (document.getElementById('setup-telegram-bot-token')?.value || '').trim();
    const telegramChannelId = (document.getElementById('setup-telegram-channel-id')?.value || '').trim();
    const password = (document.getElementById('setup-password')?.value || '').trim();
    const key = (document.getElementById('setup-key')?.value || '').trim();
    const adminName = (document.getElementById('setup-admin-name')?.value || '').trim();
    const adminEmail = (document.getElementById('setup-admin-email')?.value || '').trim().toLowerCase();

    const payload = {
      adminEmail,
      adminName,
      adminPassword: password,
      masterPassword: password,
      encryptionKey: key,
      discordBotToken: botToken,
      discordGuildId: guildId,
      discordChannelId: channelId,
      telegramApiId,
      telegramApiHash,
      telegramBotToken,
      telegramChannelId,
      defaultStorageMode: 'dual',
      uploadStrategy: 'primary_first',
      primaryProvider: 'telegram'
    };

    try {
      const res = await API.request('POST', '/api/setup/init', payload);

      if (res && res.token) {
        API.setToken(res.token);
        if (typeof UI !== 'undefined' && UI.showToast) {
          UI.showToast('CloudDrive setup completed successfully! Welcome!', 'success');
        }
        setTimeout(() => {
          window.location.reload();
        }, 800);
      } else {
        throw new Error(res?.error || 'Setup failed');
      }
    } catch (err) {
      if (typeof UI !== 'undefined' && UI.showToast) {
        UI.showToast(err.message || 'Setup initialization failed', 'error');
      } else {
        alert('Setup failed: ' + (err.message || 'Unknown error'));
      }
      if (btnComplete) {
        btnComplete.disabled = false;
        btnComplete.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg><span>Complete & Launch</span>`;
      }
      this.isSubmitting = false;
    }
  }
};

window.Setup = Setup;
