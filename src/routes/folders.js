const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const eventBroadcaster = require('../services/eventBroadcaster');
const { generateFolderToken, verifyFolderToken } = require('../securityTokens');

const router = express.Router();
router.use(authMiddleware);

function sanitizeFolder(f) {
  if (!f) return null;
  const { password_hash, ...rest } = f;
  return {
    ...rest,
    is_locked: (f.is_locked === 1 || Boolean(password_hash)) ? 1 : 0
  };
}

function requireUnlockedFolder(req, res, folder) {
  if (!folder || (!folder.is_locked && !folder.password_hash)) return true;
  const token = req.headers['x-folder-token'] || req.query.folderToken;
  if (verifyFolderToken(folder.id, req.user.id, token)) return true;
  res.status(403).json({ error: 'Folder password verification required', isLocked: true });
  return false;
}

function isDescendantFolder(candidateParentId, folderId, userId) {
  let currentId = candidateParentId;
  let hops = 0;
  while (currentId && hops++ < 100) {
    if (String(currentId) === String(folderId)) return true;
    const current = db.getFolderById(currentId, userId);
    if (!current) return false;
    currentId = current.parent_id;
  }
  return hops >= 100;
}

function getBreadcrumbs(folderId, userId, isTrash = false) {
  const breadcrumbs = [];
  let currentId = (folderId && folderId !== 'null' && folderId !== 'undefined' && String(folderId).trim() !== '') ? String(folderId).trim() : null;

  while (currentId) {
    const folder = db.getFolderById(currentId, userId);
    if (!folder) break;
    // In trash view, stop when reaching non-trashed parent
    if (isTrash && folder.is_trashed !== 1) break;
    breadcrumbs.unshift({ id: folder.id, name: folder.name });
    currentId = (folder.parent_id && folder.parent_id !== 'null' && folder.parent_id !== 'undefined' && String(folder.parent_id).trim() !== '') ? String(folder.parent_id).trim() : null;
  }

  breadcrumbs.unshift({ id: null, name: isTrash ? 'Trash' : 'My Drive' });
  return breadcrumbs;
}

// Recursive delete helper (moves folder and contained files to trash)
async function deleteFolderRecursive(folderId, userId) {
  let deletedFiles = 0;
  let deletedFolders = 0;
  const now = new Date().toISOString();

  const files = db.getFilesByFolder(folderId, userId, false);
  for (const file of files) {
    db.updateFile(file.id, { is_trashed: 1, trashed_at: now }, userId);
    deletedFiles++;
  }

  const subfolders = db.getFoldersByParent(folderId, userId, false);
  for (const sub of subfolders) {
    const res = await deleteFolderRecursive(sub.id, userId);
    deletedFiles += res.deletedFiles;
    deletedFolders += res.deletedFolders;
  }

  db.updateFolder(folderId, { is_trashed: 1, trashed_at: now }, userId);
  deletedFolders++;
  if (userId) db.recalculateUserStorage(userId);
  return { deletedFiles, deletedFolders };
}

// Recursive restore helper (restores folder and contained files/subfolders)
async function restoreFolderRecursive(folderId, userId) {
  let restoredFiles = 0;
  let restoredFolders = 0;

  db.updateFolder(folderId, { is_trashed: 0, trashed_at: null }, userId);
  restoredFolders++;

  const files = db.getFilesByFolder(folderId, userId, true);
  for (const file of files) {
    db.updateFile(file.id, { is_trashed: 0, trashed_at: null }, userId);
    restoredFiles++;
  }

  const subfolders = db.getFoldersByParent(folderId, userId, true);
  for (const sub of subfolders) {
    const res = await restoreFolderRecursive(sub.id, userId);
    restoredFiles += res.restoredFiles;
    restoredFolders += res.restoredFolders;
  }

  if (userId) db.recalculateUserStorage(userId);
  return { restoredFiles, restoredFolders };
}

// Permanently delete folder and all contained files across providers & DB
async function permanentlyDeleteFolderRecursive(folderId, userId) {
  let deletedFiles = 0;
  let deletedFolders = 0;

  const subfolders = db.getFoldersByParent(folderId, userId, true);
  for (const sub of subfolders) {
    const res = await permanentlyDeleteFolderRecursive(sub.id, userId);
    deletedFiles += res.deletedFiles;
    deletedFolders += res.deletedFolders;
  }

  const files = db.getFilesByFolder(folderId, userId, true);
  const filesRouter = require('./files');
  for (const file of files) {
    if (filesRouter.permanentlyDeleteFile) {
      await filesRouter.permanentlyDeleteFile(file);
      deletedFiles++;
    }
  }

  db.deleteFolder(folderId, userId);
  deletedFolders++;
  if (userId) db.recalculateUserStorage(userId);
  return { deletedFiles, deletedFolders };
}

// Get Folders & Contents
router.get('/', (req, res) => {
  const { parentId, search, trash, trashed } = req.query;
  const isTrash = (trash === 'true' || trash === '1' || trashed === 'true' || trashed === '1');
  const targetParent = (parentId === 'null' || parentId === 'root' || !parentId) ? null : parentId;

  if (isTrash) {
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      const allTrashed = db.getAllTrashedFolders(req.user.id);
      const matched = allTrashed.filter(f => (f.name || '').toLowerCase().includes(q)).map(sanitizeFolder);
      const allTrashedFiles = db.getAllTrashedFiles(req.user.id);
      const matchedFiles = allTrashedFiles.filter(f => (f.name || '').toLowerCase().includes(q));
      return res.json({ success: true, currentFolder: null, folders: matched, files: matchedFiles, breadcrumbs: [{ id: null, name: 'Trash' }] });
    }

    const rawFolder = targetParent ? db.getFolderById(targetParent, req.user.id) : null;
    const currentFolder = rawFolder ? sanitizeFolder(rawFolder) : null;
    const breadcrumbs = getBreadcrumbs(targetParent, req.user.id, true);
    const rawFolders = db.getTrashedFolders(req.user.id, targetParent);
    const folders = (rawFolders || []).map(sanitizeFolder);
    const files = db.getTrashedFiles(req.user.id, targetParent);

    return res.json({
      success: true,
      currentFolder,
      folders,
      files,
      breadcrumbs,
      isLocked: false
    });
  }

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    const allFolders = targetParent ? db.getFoldersByParent(targetParent, req.user.id, false) : db.getAllFolders(req.user.id, false);
    const matched = allFolders.filter(f => (f.name || '').toLowerCase().includes(q)).map(sanitizeFolder);
    const allFiles = targetParent ? db.getFilesByFolder(targetParent, req.user.id, false) : db.getAllFiles(req.user.id, false);
    const matchedFiles = allFiles.filter(f => (f.name || '').toLowerCase().includes(q));
    return res.json({ success: true, currentFolder: null, folders: matched, files: matchedFiles, breadcrumbs: [] });
  }

  const rawFolder = targetParent ? db.getFolderById(targetParent, req.user.id) : null;
  const currentFolder = rawFolder ? sanitizeFolder(rawFolder) : null;
  const breadcrumbs = getBreadcrumbs(targetParent, req.user.id, false);

  // Security: Check if folder is locked and verify token
  if (rawFolder && (rawFolder.is_locked === 1 || Boolean(rawFolder.password_hash))) {
    const token = req.headers['x-folder-token'] || req.query.folderToken;
    const isUnlocked = verifyFolderToken(targetParent, req.user.id, token);
    if (!isUnlocked) {
      return res.json({
        success: true,
        currentFolder,
        folders: [],
        files: [],
        breadcrumbs,
        isLocked: true
      });
    }
  }

  const rawFolders = db.getFoldersByParent(targetParent, req.user.id, false);
  const folders = (rawFolders || []).map(sanitizeFolder);
  const files = db.getFilesByFolder(targetParent, req.user.id, false);

  res.json({
    success: true,
    currentFolder,
    folders,
    files,
    breadcrumbs,
    isLocked: false
  });
});

// Create Folder
router.post('/', async (req, res) => {
  const { name, parentId, storagePolicy, pinPassword, password } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Folder name is required' });
  }

  const pass = password || pinPassword;
  if (parentId && parentId !== 'null' && parentId !== 'root') {
    const parent = db.getFolderById(parentId, req.user.id);
    if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
    if (!requireUnlockedFolder(req, res, parent)) return;
  }
  let passwordHash = null;
  let isLocked = 0;
  if (pass && pass.trim().length > 0) {
    passwordHash = await bcrypt.hash(pass.trim(), 10);
    isLocked = 1;
  }

  const folder = {
    id: uuidv4(),
    user_id: req.user.id,
    name: name.trim(),
    parent_id: (parentId === 'null' || parentId === 'root' || !parentId) ? null : parentId,
    storage_policy: storagePolicy || null,
    is_locked: isLocked,
    password_hash: passwordHash
  };

  const created = db.createFolder(folder);
  const sanitized = sanitizeFolder(created);
  eventBroadcaster.broadcast('folder_created', { folder: sanitized, userId: req.user.id }, req.user.id);
  res.json({ success: true, folder: sanitized });
});

// Rename / Move / Update Folder (PATCH)
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, parent_id, parentId, storagePolicy, storage_policy } = req.body;
  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (!requireUnlockedFolder(req, res, folder)) return;

  const targetParent = parent_id !== undefined ? parent_id : parentId;
  if (targetParent === id || isDescendantFolder(targetParent, id, req.user.id)) {
    return res.status(400).json({ error: 'Cannot move folder into itself' });
  }
  if (targetParent && targetParent !== 'null' && targetParent !== 'root') {
    const parent = db.getFolderById(targetParent, req.user.id);
    if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
    if (!requireUnlockedFolder(req, res, parent)) return;
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (targetParent !== undefined) updates.parent_id = (targetParent === 'null' || targetParent === 'root' || !targetParent) ? null : targetParent;
  const policy = storagePolicy !== undefined ? storagePolicy : storage_policy;
  if (policy !== undefined) updates.storage_policy = policy || null;

  const updated = db.updateFolder(id, updates, req.user.id);
  res.json(sanitizeFolder(updated));
});

// Rename / Move Folder (PUT alias)
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, parentId, parent_id, storagePolicy } = req.body;

  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (!requireUnlockedFolder(req, res, folder)) return;

  const targetParent = parentId !== undefined ? parentId : parent_id;
  if (targetParent === id || isDescendantFolder(targetParent, id, req.user.id)) {
    return res.status(400).json({ error: 'Cannot move folder into itself' });
  }
  if (targetParent && targetParent !== 'null' && targetParent !== 'root') {
    const parent = db.getFolderById(targetParent, req.user.id);
    if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
    if (!requireUnlockedFolder(req, res, parent)) return;
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (targetParent !== undefined) updates.parent_id = (targetParent === 'null' || targetParent === 'root' || !targetParent) ? null : targetParent;
  if (storagePolicy !== undefined) updates.storage_policy = storagePolicy || null;

  const updated = db.updateFolder(id, updates, req.user.id);
  res.json({ success: true, folder: sanitizeFolder(updated) });
});

// Lock / Set Password on Folder
router.post('/:id/lock', async (req, res) => {
  const { id } = req.params;
  const pass = req.body.password || req.body.pinPassword;
  if (!pass || pass.trim().length < 3) {
    return res.status(400).json({ error: 'Folder password must be at least 3 characters' });
  }

  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (folder.password_hash && !requireUnlockedFolder(req, res, folder)) return;

  const passwordHash = await bcrypt.hash(pass.trim(), 10);
  const updated = db.updateFolder(id, {
    is_locked: 1,
    password_hash: passwordHash
  }, req.user.id);

  res.json({ success: true, folder: sanitizeFolder(updated), message: 'Folder locked successfully' });
});

// Verify Folder Lock & Return HMAC Token
router.post('/:id/verify-lock', async (req, res) => {
  const { id } = req.params;
  const pass = req.body.password || req.body.pinPassword;
  if (!pass) return res.status(400).json({ error: 'Password is required' });

  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  if (!folder.password_hash) {
    return res.json({ success: true, folderToken: generateFolderToken(id), message: 'Folder is not locked' });
  }

  const match = await bcrypt.compare(pass, folder.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect folder password' });
  }

  const folderToken = generateFolderToken(id, req.user.id);
  res.json({ success: true, folderToken, message: 'Folder unlocked successfully' });
});

// Unlock Permanently (Remove lock)
router.post('/:id/unlock-permanently', async (req, res) => {
  const { id } = req.params;
  const pass = req.body.password || req.body.pinPassword;
  if (!pass) return res.status(400).json({ error: 'Current password is required to remove lock' });

  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  if (folder.password_hash) {
    const match = await bcrypt.compare(pass, folder.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect folder password' });
  }

  const updated = db.updateFolder(id, {
    is_locked: 0,
    password_hash: null
  }, req.user.id);

  res.json({ success: true, folder: sanitizeFolder(updated), message: 'Folder unlocked permanently' });
});

// Legacy Unlock (Verify PIN)
router.post('/:id/unlock', async (req, res) => {
  const { id } = req.params;
  const pass = req.body.password || req.body.pinPassword;

  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  if (!folder.is_locked || !folder.password_hash) {
    return res.json({ success: true, unlocked: true, folderToken: generateFolderToken(id) });
  }

  const match = await bcrypt.compare(pass || '', folder.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect folder password' });
  }

  res.json({ success: true, unlocked: true, folderToken: generateFolderToken(id) });
});

// Delete Folder (Soft or Permanent)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (!requireUnlockedFolder(req, res, folder)) return;

  const isPermanent = req.query.permanent === 'true';
  const result = isPermanent ?
    await permanentlyDeleteFolderRecursive(id, req.user.id) :
    await deleteFolderRecursive(id, req.user.id);

  res.json({ success: true, ...result });
});

// Restore Folder from Trash
router.post('/:id/restore', async (req, res) => {
  const { id } = req.params;
  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const result = await restoreFolderRecursive(id, req.user.id);
  res.json({ success: true, ...result, message: 'Folder restored successfully' });
});

// Folder Tree for Move Modal
router.get('/tree', (req, res) => {
  const allFolders = db.getAllFolders(req.user.id);
  const map = new Map();
  const roots = [];

  for (const f of allFolders) {
    map.set(f.id, { ...sanitizeFolder(f), children: [] });
  }

  for (const f of allFolders) {
    if (f.parent_id && map.has(f.parent_id)) {
      map.get(f.parent_id).children.push(map.get(f.id));
    } else {
      roots.push(map.get(f.id));
    }
  }

  res.json({ success: true, tree: roots });
});

// Helper for calculating recursive folder statistics
function getFolderStatsRecursive(folderId, userId) {
  let totalFiles = 0;
  let totalSize = 0;
  let directFiles = 0;
  let directSize = 0;
  let directFolders = 0;
  let totalFolders = 0;
  const mimeBreakdown = {};

  function traverse(currentId, isRoot = false) {
    const files = db.getFilesByFolder(currentId, userId, false) || [];
    if (isRoot) {
      directFiles = files.length;
      directSize = files.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
    }
    for (const f of files) {
      totalFiles++;
      const sz = Number(f.size) || 0;
      totalSize += sz;
      const mime = f.mime_type || 'application/octet-stream';
      const mainType = mime.split('/')[0] || 'other';
      mimeBreakdown[mainType] = (mimeBreakdown[mainType] || 0) + 1;
    }

    const subfolders = db.getFoldersByParent(currentId, userId, false) || [];
    if (isRoot) {
      directFolders = subfolders.length;
    }
    for (const sub of subfolders) {
      totalFolders++;
      traverse(sub.id, false);
    }
  }

  traverse(folderId, true);

  return {
    totalFiles,
    totalSize,
    directFiles,
    directSize,
    directFolders,
    totalFolders,
    mimeBreakdown
  };
}

// Get Folder Properties & Statistics (Files count, Total Size, Subfolders)
router.get('/:id/stats', (req, res) => {
  const { id } = req.params;
  const folder = db.getFolderById(id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  // Security: Check if folder is locked and verify token
  if (folder.is_locked === 1 || Boolean(folder.password_hash)) {
    const token = req.headers['x-folder-token'] || req.query.folderToken;
    const isUnlocked = verifyFolderToken(id, req.user.id, token);
    if (!isUnlocked) {
      return res.status(403).json({ error: 'Folder is locked. Please unlock it to view details.', isLocked: true });
    }
  }

  const stats = getFolderStatsRecursive(id, req.user.id);
  const breadcrumbs = getBreadcrumbs(id, req.user.id);

  res.json({
    success: true,
    folder: sanitizeFolder(folder),
    breadcrumbs,
    stats
  });
});

router.deleteFolderRecursive = deleteFolderRecursive;
router.restoreFolderRecursive = restoreFolderRecursive;
router.permanentlyDeleteFolderRecursive = permanentlyDeleteFolderRecursive;
router.generateFolderToken = generateFolderToken;
router.verifyFolderToken = verifyFolderToken;

module.exports = router;
