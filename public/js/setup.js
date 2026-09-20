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
        const botToken = (document.getElementById('setup-bot-token')?.value || '').trim();
        const guildId = (document.getElementById('setup-guild-id')?.value || '').trim();

        if (!botToken) {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast('Please enter your Discord Bot Token', 'error');
          } else {
            alert('Please enter your Discord Bot Token');
          }
          document.getElementById('setup-bot-token')?.focus();
          return;
        }

        if (!guildId) {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast('Please enter your Discord Guild ID', 'error');
          } else {
            alert('Please enter your Discord Guild ID');
          }
          document.getElementById('setup-guild-id')?.focus();
          return;
        }

        this.goToStep(2);
      };
    }

    // Step 2: Back & Next
    const btnStep2Prev = document.getElementById('btn-step-2-prev');
    if (btnStep2Prev) {
      btnStep2Prev.onclick = () => this.goToStep(1);
    }

    const btnStep2Next = document.getElementById('btn-step-2-next');
    if (btnStep2Next) {
      btnStep2Next.onclick = () => {
        const channelId = (document.getElementById('setup-channel-id')?.value || '').trim();
        if (!channelId) {
          if (typeof UI !== 'undefined' && UI.showToast) {
            UI.showToast('Please enter your Discord Channel ID', 'error');
          } else {
            alert('Please enter your Discord Channel ID');
          }
          document.getElementById('setup-channel-id')?.focus();
          return;
        }
        this.goToStep(3);
      };
    }

    // Step 3: Back & Next
    const btnStep3Prev = document.getElementById('btn-step-3-prev');
    if (btnStep3Prev) {
      btnStep3Prev.onclick = () => this.goToStep(2);
    }

    const btnStep3Next = document.getElementById('btn-step-3-next');
    if (btnStep3Next) {
      btnStep3Next.onclick = () => {
        const password = (document.getElementById('setup-password')?.value || '').trim();
        const key = (document.getElementById('setup-key')?.value || '').trim();

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
      if (step === 1) document.getElementById('setup-bot-token')?.focus();
      if (step === 2) document.getElementById('setup-channel-id')?.focus();
      if (step === 3) document.getElementById('setup-password')?.focus();
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
    const password = (document.getElementById('setup-password')?.value || '').trim();
    const key = (document.getElementById('setup-key')?.value || '').trim();

    const payload = {
      adminEmail: 'admin@clouddrive.local',
      adminName: 'Administrator',
      adminPassword: password,
      masterPassword: password,
      encryptionKey: key,
      discordBotToken: botToken,
      discordGuildId: guildId,
      discordChannelId: channelId,
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
