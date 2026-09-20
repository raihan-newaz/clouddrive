const crypto = require('crypto');

/**
 * Real-time Device & Session Tracker for WebDAV and CloudDrive Clients
 */
class SessionTracker {
  constructor() {
    this.sessions = new Map();
    this.activeSessions = new Map();
    this.browserSessions = new Map();
    this.revokedSessionIds = new Set();
  }

  /**
   * Helper to parse client IP
   */
  getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || req.ip || '127.0.0.1';
  }

  /**
   * Parse Friendly Device / Client Information from User-Agent
   */
  parseDevice(userAgent = '') {
    const ua = userAgent.toLowerCase();

    let clientName = 'WebDAV Client';
    let osType = 'generic';

    if (ua.includes('microsoft-webdav-miniredir') || ua.includes('davclnt')) {
      clientName = 'Windows File Explorer';
      osType = 'windows';
    } else if (ua.includes('webdavfs') || ua.includes('finder')) {
      clientName = 'macOS Finder';
      osType = 'apple';
    } else if (ua.includes('cfnetwork') || ua.includes('files/') || ua.includes('mobilefileviewer')) {
      clientName = 'iOS Files App';
      osType = 'apple';
    } else if (ua.includes('solidexplorer')) {
      clientName = 'Solid Explorer';
      osType = 'android';
    } else if (ua.includes('cxfileexplorer')) {
      clientName = 'Cx File Explorer';
      osType = 'android';
    } else if (ua.includes('rclone')) {
      clientName = 'Rclone Sync';
      osType = 'linux';
    } else if (ua.includes('cyberduck') || ua.includes('mountainduck')) {
      clientName = 'Cyberduck';
      osType = 'apple';
    } else if (ua.includes('winscp')) {
      clientName = 'WinSCP';
      osType = 'windows';
    } else if (ua.includes('windows')) {
      clientName = 'Windows Device';
      osType = 'windows';
    } else if (ua.includes('macintosh') || ua.includes('mac os')) {
      clientName = 'Mac Device';
      osType = 'apple';
    } else if (ua.includes('iphone') || ua.includes('ipad')) {
      clientName = 'iPhone / iPad';
      osType = 'apple';
    } else if (ua.includes('android')) {
      clientName = 'Android Device';
      osType = 'android';
    } else if (ua.includes('linux')) {
      clientName = 'Linux Client';
      osType = 'linux';
    }

    return { clientName, osType };
  }

  /**
   * Generate deterministic session ID
   */
  generateSessionId(ip, userAgent, username) {
    return crypto.createHash('md5').update(`${ip}::${userAgent}::${username || 'admin'}`).digest('hex');
  }

  /**
   * Track User Login Session
   */
  track(userId, req, sessionId = null) {
    if (!userId) return;
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    this.activeSessions.set(userId, {
      ip,
      userAgent,
      lastSeen: Date.now()
    });
    if (sessionId && this.browserSessions.has(sessionId)) {
      const session = this.browserSessions.get(sessionId);
      session.lastActive = Date.now();
      session.ip = ip;
      session.userAgent = userAgent;
    }
  }

  createBrowserSession(user, req, sessionId = crypto.randomUUID()) {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown browser';
    const parsed = this.parseDevice(userAgent);
    this.browserSessions.set(sessionId, {
      id: sessionId, type: 'browser', userId: user.id, username: user.email,
      ip, userAgent, clientName: parsed.clientName, osType: parsed.osType,
      connectedAt: new Date().toISOString(), lastActive: Date.now(),
      lastAction: 'Signed in', requestCount: 1, revoked: false
    });
    this.track(user.id, req, sessionId);
    return sessionId;
  }

  getActiveSession(userId) {
    return this.activeSessions.get(userId) || null;
  }

  /**
   * Track an incoming WebDAV request
   */
  trackWebDavRequest(req, username = 'admin') {
    const ip = this.getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Generic-WebDAV';
    const sessionId = this.generateSessionId(ip, userAgent, username);

    const now = Date.now();
    const parsed = this.parseDevice(userAgent);

    let action = 'Browsing';
    const method = req.method.toUpperCase();
    if (method === 'PUT') action = 'Uploading / Editing file';
    else if (method === 'GET') action = 'Downloading / Streaming';
    else if (method === 'DELETE') action = 'Deleting item';
    else if (method === 'MKCOL') action = 'Creating folder';
    else if (method === 'MOVE') action = 'Renaming / Moving';
    else if (method === 'PROPFIND') action = 'Browsing directory';
    else if (method === 'LOCK' || method === 'UNLOCK') action = 'Locking / Syncing file';

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActive = now;
      existing.lastAction = action;
      existing.lastPath = req.path || '/';
      existing.requestCount = (existing.requestCount || 0) + 1;
      existing.revoked = this.revokedSessionIds.has(sessionId);
    } else {
      this.sessions.set(sessionId, {
        id: sessionId,
        type: 'webdav',
        ip,
        userAgent,
        clientName: parsed.clientName,
        osType: parsed.osType,
        username,
        connectedAt: new Date(now).toISOString(),
        lastActive: now,
        lastAction: action,
        lastPath: req.path || '/',
        requestCount: 1,
        revoked: this.revokedSessionIds.has(sessionId),
      });
    }

    this.cleanupOldSessions();
    return sessionId;
  }

  /**
   * Check if session or IP is revoked
   */
  isRevoked(ip, userAgent, username) {
    const sessionId = this.generateSessionId(ip, userAgent, username);
    return this.revokedSessionIds.has(sessionId);
  }

  /**
   * Revoke / Disconnect a device session
   */
  revokeSession(sessionId) {
    this.revokedSessionIds.add(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.revoked = true;
    }
    const browserSession = this.browserSessions.get(sessionId);
    if (browserSession) browserSession.revoked = true;
    return true;
  }

  /**
   * Re-allow / Unrevoke a device session
   */
  unrevokeSession(sessionId) {
    this.revokedSessionIds.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.revoked = false;
    }
    return true;
  }

  /**
   * Get all active & recent connected sessions
   */
  getActiveSessions() {
    const now = Date.now();
    const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    const list = [...this.sessions.values(), ...this.browserSessions.values()].map(s => {
      const isOnline = (now - s.lastActive) < ONLINE_THRESHOLD_MS && !s.revoked;
      return {
        ...s,
        isOnline,
        status: s.revoked ? 'revoked' : (isOnline ? 'online' : 'idle'),
        lastActiveAgoSeconds: Math.floor((now - s.lastActive) / 1000),
      };
    });

    // Sort: Online first, then by last active timestamp descending
    list.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return b.lastActive - a.lastActive;
    });

    return list;
  }

  isBrowserSessionRevoked(sessionId) {
    return Boolean(sessionId && (this.revokedSessionIds.has(sessionId) || this.browserSessions.get(sessionId)?.revoked));
  }

  /**
   * Clean up sessions inactive for more than 7 days
   */
  cleanupOldSessions() {
    if (this.sessions.size < 100) return;
    const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (now - s.lastActive > MAX_AGE) {
        this.sessions.delete(id);
        this.revokedSessionIds.delete(id);
      }
    }
  }
}

const sessionTracker = new SessionTracker();
module.exports = sessionTracker;
