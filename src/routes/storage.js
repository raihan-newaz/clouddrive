const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const storageManager = require('../storage/StorageManager');

const router = express.Router();
router.use(authMiddleware);

// Get User & System Storage Stats
router.get('/stats', async (req, res) => {
  try {
    const detailed = db.getUserDetailedStorageStats(req.user.id) || {};
    const stats = db.getStorageStats(req.user.id) || {};
    const providersStatus = await storageManager.getProvidersStatus();

    const mergedStats = {
      ...detailed,
      ...stats,
      totalFiles: detailed.activeFileCount !== undefined ? detailed.activeFileCount : (stats.totalFiles || 0),
      totalBytes: detailed.activeFilesSize !== undefined ? detailed.activeFilesSize : (stats.totalBytes || 0),
      logicalFiles: stats.logicalFiles || stats.totalFiles || detailed.activeFileCount || 0,
      logicalBytes: stats.logicalBytes || stats.totalBytes || detailed.activeFilesSize || 0,
      discordBytes: stats.discord?.bytes || stats.discordBytes || 0,
      telegramBytes: stats.telegram?.bytes || stats.telegramBytes || 0,
      physicalBytes: (stats.discord?.bytes || 0) + (stats.telegram?.bytes || 0),
      userLimit: req.user.storage_limit || detailed.storageLimit || 0,
      userUsed: detailed.storageUsed !== undefined ? detailed.storageUsed : (req.user.storage_used || stats.totalBytes || 0),
      discord: stats.discord || { files: 0, chunks: 0, bytes: 0 },
      telegram: stats.telegram || { files: 0, chunks: 0, bytes: 0 }
    };

    res.json({
      success: true,
      stats: mergedStats,
      providers: providersStatus
    });
  } catch (error) {
    console.error('[Storage API] Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// Category-based storage breakdown
router.get('/breakdown', (req, res) => {
  try {
    const breakdown = db.getUserStorageBreakdown(req.user.id);
    res.json({ success: true, ...breakdown });
  } catch (error) {
    console.error('[Storage API] Breakdown error:', error);
    res.status(500).json({ error: 'Failed to fetch storage breakdown' });
  }
});

// Top largest active files
router.get('/largest', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const files = db.getUserLargestFiles(req.user.id, limit);
    res.json({ success: true, files });
  } catch (error) {
    console.error('[Storage API] Largest files error:', error);
    res.status(500).json({ error: 'Failed to fetch largest files' });
  }
});

// Recent storage activity
router.get('/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const activities = db.getUserRecentStorageActivity(req.user.id, limit);
    res.json({ success: true, activities });
  } catch (error) {
    console.error('[Storage API] Recent activity error:', error);
    res.status(500).json({ error: 'Failed to fetch storage activity' });
  }
});

// Recalculate storage usage
router.post('/recalculate', (req, res) => {
  try {
    db.recalculateUserStorage(req.user.id);
    const detailed = db.getUserDetailedStorageStats(req.user.id);
    res.json({ success: true, stats: detailed });
  } catch (error) {
    console.error('[Storage API] Recalculate error:', error);
    res.status(500).json({ error: 'Failed to recalculate storage' });
  }
});

// Live Multi-Cloud Sync Status
router.get('/sync-status', async (req, res) => {
  try {
    const storageReconciler = require('../services/storageReconciler');
    const status = await storageReconciler.getSyncStatus(req.user.id);
    res.json({ success: true, sync: status });
  } catch (error) {
    console.error('[Storage API] Sync status error:', error);
    res.status(500).json({ error: 'Failed to fetch sync status: ' + error.message });
  }
});

// Trigger Smart Storage Reconcile & Cross-Cloud Auto-Heal
router.post('/reconcile', async (req, res) => {
  try {
    const storageReconciler = require('../services/storageReconciler');
    const result = await storageReconciler.scanAndHealMissingReplicas(req.user.role === 'admin' ? null : req.user.id);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[Storage API] Reconcile error:', error);
    res.status(500).json({ error: 'Failed to execute storage reconciliation: ' + error.message });
  }
});

module.exports = router;
