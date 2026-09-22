const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./src/config');
const db = require('./src/db');
const storageManager = require('./src/storage/StorageManager');
const replicationWorker = require('./src/services/replicationWorker');
const { startAutomatedBackups } = require('./src/services/backup');
const securityMiddleware = require('./src/middleware/security');
const { apiLimiter } = require('./src/middleware/rateLimiter');
const maintenanceMode = require('./src/middleware/maintenance');

// Routes
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const filesRoutes = require('./src/routes/files');
const foldersRoutes = require('./src/routes/folders');
const settingsRoutes = require('./src/routes/settings');
const setupRoutes = require('./src/routes/setup');
const shareRoutes = require('./src/routes/share');
const storageRoutes = require('./src/routes/storage');
const realtimeRoutes = require('./src/routes/realtime');
const remoteUploadRoutes = require('./src/routes/remoteUpload');
const webdavRoutes = require('./src/routes/webdav');

const app = express();
// CyberPanel/Nginx commonly forwards the real client address. Set TRUST_PROXY
// to `true` (or a hop count) in production so req.ip is the actual client IP.
const trustProxy = process.env.TRUST_PROXY === 'true'
  ? true
  : (process.env.TRUST_PROXY && /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : (process.env.TRUST_PROXY || 'loopback'));
app.set('trust proxy', trustProxy);

// Security and Parsers
app.use(securityMiddleware());
app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    try {
      const parsed = new URL(origin);
      const allowed = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ||
        (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean).includes(origin);
      return callback(null, allowed);
    } catch (_) {
      return callback(null, false);
    }
  },
  credentials: true
}));
app.use(cookieParser());

// This is a private application. Tell compliant crawlers not to index any
// route, including authenticated pages and public share URLs.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate');
  next();
});

// WebDAV raw handler must mount before json parser
app.use('/webdav', webdavRoutes);

// JSON and URL-Encoded Parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(maintenanceMode);
// Protect every JSON API endpoint from unauthenticated request floods. More
// restrictive limiters still apply to authentication, uploads, and WebDAV.
app.use('/api', apiLimiter);

// Static Assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(?:js|css)$/i.test(filePath)) {
      // Admin-triggered UI refreshes and reverse proxies can safely revalidate
      // versioned front-end assets instead of serving an old deployment.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/folders', foldersRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/realtime', realtimeRoutes);
app.use('/api/remote-upload', remoteUploadRoutes);

// Public share page handler
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Single Page App Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server & Subsystems
async function bootstrap() {
  try {
    console.log('─── Initializing CloudDrive Core ───');
    await db.initialize();
    console.log('[Database] SQLite database initialized successfully.');

    const server = app.listen(config.PORT, config.HOST, () => {
      console.log(`=======================================================`);
      console.log(`🚀 CloudDrive Server running on http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
      console.log(`📁 WebDAV Endpoint: http://localhost:${config.PORT}/webdav`);
      console.log(`🔐 Storage Providers: Discord + Telegram`);
      console.log(`=======================================================`);
    });

    // 30-minute socket and request timeout for massive 2GB (Telegram) / 500MB (Discord) chunk uploads
    server.timeout = 30 * 60 * 1000;
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    // Initialize configured storage providers in background
    storageManager.initializeAll().catch(err => {
      console.warn('[StorageManager] Background initialization warning:', err.message);
    });

    // Start background replication worker
    replicationWorker.start();

    // Start smart cross-cloud storage reconciler & self-healing sync
    const storageReconciler = require('./src/services/storageReconciler');
    storageReconciler.startPeriodicReconciliation(10);

    // Start daily cloud backups
    startAutomatedBackups();
  } catch (err) {
    console.error('Fatal bootstrapping error:', err);
    process.exit(1);
  }
}

bootstrap();
