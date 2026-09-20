/**
 * CloudDrive — PWA Integration & Installation Module
 * Supports:
 * - Service Worker Lifecycle & Offline Synchronization
 * - Android & Chromium One-Click Install (`beforeinstallprompt`)
 * - iOS Safari Guided "Add to Home Screen" Modal
 * - Desktop Chrome / Edge App Installation
 * - Online / Offline Network Status Detection
 * - Standalone Mode Detection
 */

let deferredInstallPrompt = null;

const PWA = {
  isStandalone: false,
  isIOS: false,
  isAndroid: false,

  init() {
    this.detectEnvironment();
    this.registerServiceWorker();
    this.setupInstallListeners();
    this.setupNetworkListeners();
    this.renderInstallUI();
  },

  detectEnvironment() {
    const userAgent = window.navigator.userAgent.toLowerCase();
    this.isIOS = /iphone|ipad|ipod/.test(userAgent) && !window.MSStream;
    this.isAndroid = /android/.test(userAgent);
    this.isStandalone = 
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://');

    if (this.isStandalone) {
      document.body.classList.add('is-pwa-standalone');
      console.log('[PWA] Running in Standalone Application Mode');
    }
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js')
          .then((registration) => {
            console.log('[PWA] Service Worker registered successfully with scope:', registration.scope);
            
            // Check for SW updates
            registration.onupdatefound = () => {
              const installingWorker = registration.installing;
              if (installingWorker) {
                installingWorker.onstatechange = () => {
                  if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    console.log('[PWA] New version available. Refresh to update.');
                  }
                };
              }
            };
          })
          .catch((error) => {
            console.warn('[PWA] Service Worker registration failed:', error);
          });
      });
    }
  },

  setupInstallListeners() {
    // Capture Chromium install prompt event
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      this.showInstallButtons();
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      this.hideInstallButtons();
      if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast('CloudDrive installed successfully!', 'success');
      }
    });
  },

  setupNetworkListeners() {
    window.addEventListener('online', () => {
      if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast('Internet connection restored. You are online.', 'success');
      }
    });

    window.addEventListener('offline', () => {
      if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast('You are currently offline. CloudDrive is running in offline mode.', 'info');
      }
    });
  },

  showInstallButtons() {
    const buttons = document.querySelectorAll('.pwa-install-btn');
    buttons.forEach((btn) => {
      btn.classList.add('pwa-ready');
      btn.style.removeProperty('display');
    });
  },

  hideInstallButtons() {
    const buttons = document.querySelectorAll('.pwa-install-btn');
    buttons.forEach((btn) => {
      btn.classList.remove('pwa-ready');
      btn.style.display = 'none';
    });
  },

  renderInstallUI() {
    if (this.isStandalone) {
      this.hideInstallButtons();
      return;
    }

    // On iOS Safari, display the install buttons if not in standalone mode
    if (this.isIOS) {
      this.showInstallButtons();
    }
  },

  async promptInstall() {
    if (this.isStandalone) {
      if (window.UI && typeof window.UI.showToast === 'function') {
        window.UI.showToast('CloudDrive is already installed as an app.');
      }
      return;
    }

    if (deferredInstallPrompt) {
      // Chromium native prompt
      try {
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        if (choiceResult && choiceResult.outcome === 'accepted') {
          console.log('[PWA] User accepted the install prompt');
        }
      } catch (err) {
        console.warn('[PWA] Install prompt error:', err);
      }
      deferredInstallPrompt = null;
      this.hideInstallButtons();
    } else if (this.isIOS) {
      // iOS Safari Guided Modal
      this.openIOSInstallModal();
    } else {
      // Desktop / Other browser fallback modal
      this.openGeneralInstallModal();
    }
  },

  openIOSInstallModal() {
    const modal = document.getElementById('ios-pwa-modal');
    if (modal) {
      modal.style.display = 'flex';
    }
  },

  closeIOSInstallModal() {
    const modal = document.getElementById('ios-pwa-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  openGeneralInstallModal() {
    const modal = document.getElementById('general-pwa-modal');
    if (modal) {
      modal.style.display = 'flex';
    }
  },

  closeGeneralInstallModal() {
    const modal = document.getElementById('general-pwa-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  }
};

window.PWA = PWA;
document.addEventListener('DOMContentLoaded', () => {
  PWA.init();
});
