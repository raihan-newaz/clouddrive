const db = require('../db');

function activeGrants(userId) {
  return db.getActiveUserSharesForRecipient(userId) || [];
}

function folderPath(folderId, ownerId) {
  const path = [];
  let id = folderId;
  const seen = new Set();
  while (id && path.length < 128 && !seen.has(String(id))) {
    seen.add(String(id));
    const folder = db.getFolderById(id, ownerId);
    if (!folder) return null;
    path.push(folder);
    id = folder.parent_id;
  }
  return id ? null : path;
}

function isLockedPath(folderId, ownerId) {
  const path = folderPath(folderId, ownerId);
  return !path || path.some(folder => folder.is_locked || folder.password_hash);
}

function getFilePermission(userId, file, permission = 'read') {
  if (!file) return null;
  if (String(file.user_id) === String(userId)) return { isOwner: true, ownerId: file.user_id, canDownload: true, canDelete: true, grantId: null };
  const path = file.folder_id ? folderPath(file.folder_id, file.user_id) : [];
  if (path === null || path.some(folder => folder.is_trashed || folder.is_locked || folder.password_hash) || file.is_trashed) return null;
  const ids = new Set(path.map(folder => String(folder.id)));
  let result = null;
  for (const grant of activeGrants(userId)) {
    const matches = (grant.resource_type === 'file' && String(grant.resource_id) === String(file.id)) ||
      (String(grant.owner_id) === String(file.user_id) && grant.resource_type === 'root') ||
      (String(grant.owner_id) === String(file.user_id) && grant.resource_type === 'folder' && ids.has(String(grant.resource_id)));
    if (!matches) continue;
    result = {
      isOwner: false,
      ownerId: file.user_id,
      canDownload: Boolean(result?.canDownload || grant.can_download),
      canDelete: Boolean(result?.canDelete || grant.can_delete),
      grantId: grant.id
    };
  }
  if (!result || (permission === 'download' && !result.canDownload) || (permission === 'delete' && !result.canDelete)) return null;
  return result;
}

function getFolderPermission(userId, folder, permission = 'read') {
  if (!folder) return null;
  if (String(folder.user_id) === String(userId)) return { isOwner: true, ownerId: folder.user_id, canDownload: true, canDelete: true, grantId: null };
  const path = folderPath(folder.id, folder.user_id);
  if (!path || path.some(item => item.is_trashed || item.is_locked || item.password_hash)) return null;
  let result = null;
  for (const grant of activeGrants(userId)) {
    const matches = String(grant.owner_id) === String(folder.user_id) && (grant.resource_type === 'root' || (grant.resource_type === 'folder' && path.some(item => String(item.id) === String(grant.resource_id))));
    if (!matches) continue;
    result = {
      isOwner: false,
      ownerId: folder.user_id,
      canDownload: Boolean(result?.canDownload || grant.can_download),
      canDelete: Boolean(result?.canDelete || grant.can_delete),
      grantId: grant.id
    };
  }
  if (!result || (permission === 'delete' && !result.canDelete)) return null;
  return result;
}

function serializeFile(file, grant) {
  return {
    id: file.id, name: file.name, mime_type: file.mime_type, size: file.size,
    folder_id: file.folder_id, is_starred: 0, is_trashed: 0,
    created_at: file.created_at, updated_at: file.updated_at,
    shared: true, can_download: Boolean(grant.canDownload), can_delete: Boolean(grant.canDelete)
  };
}

function serializeFolder(folder, grant) {
  return {
    id: folder.id, name: folder.name, parent_id: folder.parent_id,
    is_locked: 0, is_trashed: 0, created_at: folder.created_at,
    shared: true, can_download: Boolean(grant.canDownload), can_delete: Boolean(grant.canDelete)
  };
}

function rootEntry(grant) {
  if (grant.resource_type === 'file') {
    const file = db.getFileById(grant.resource_id, grant.owner_id);
    return file && !file.is_trashed ? { item: serializeFile(file, { canDownload: grant.can_download, canDelete: grant.can_delete }), grant } : null;
  }
  if (grant.resource_type === 'folder') {
    const folder = db.getFolderById(grant.resource_id, grant.owner_id);
    return folder && !folder.is_trashed && !isLockedPath(folder.id, grant.owner_id)
      ? { item: serializeFolder(folder, { canDownload: grant.can_download, canDelete: grant.can_delete }), grant }
      : null;
  }
  return {
    item: {
      id: `shared-root:${grant.id}`, name: `${grant.owner_name || grant.owner_email}'s Drive`,
      type: 'folder', parent_id: null, is_virtual_share_root: true,
      shared: true, can_download: Boolean(grant.can_download), can_delete: Boolean(grant.can_delete)
    }, grant
  };
}

function listContents(userId, grant, folderId = null) {
  if (!grant || String(grant.recipient_id) !== String(userId)) return null;
  if (grant.resource_type === 'file') return folderId ? null : [];
  let targetId = folderId;
  if (grant.resource_type === 'folder' && !targetId) targetId = grant.resource_id;
  if (grant.resource_type === 'root' && targetId === `shared-root:${grant.id}`) targetId = null;
  if (targetId) {
    const folder = db.getFolderById(targetId, grant.owner_id);
    if (!folder || !getFolderPermission(userId, folder) || (grant.resource_type === 'folder' && !isWithinSharedRoot(folder.id, grant))) return null;
    const permission = getFolderPermission(userId, folder);
    const folders = db.getFoldersByParent(folder.id, grant.owner_id, false)
      .filter(item => !isLockedPath(item.id, grant.owner_id) && getFolderPermission(userId, item))
      .map(item => serializeFolder(item, getFolderPermission(userId, item)));
    const files = db.getFilesByFolder(folder.id, grant.owner_id, false)
      .filter(item => getFilePermission(userId, item))
      .map(item => serializeFile(item, getFilePermission(userId, item)));
    const orderedPath = folderPath(folder.id, grant.owner_id).reverse();
    const shareRootIndex = grant.resource_type === 'folder' ? orderedPath.findIndex(item => String(item.id) === String(grant.resource_id)) : -1;
    const visiblePath = grant.resource_type === 'folder' ? orderedPath.slice(Math.max(0, shareRootIndex)) : orderedPath;
    const breadcrumbs = [{ id: null, name: 'Shared with me' }];
    if (grant.resource_type === 'root') breadcrumbs.push({ id: `shared-root:${grant.id}`, name: `${grant.owner_name || grant.owner_email}'s Drive` });
    visiblePath.forEach(item => breadcrumbs.push({ id: item.id, name: item.name }));
    return { folders: folders.map(item => ({ ...item, _shareGrantId: grant.id })), files, currentFolder: { ...serializeFolder(folder, permission), _shareGrantId: grant.id }, breadcrumbs };
  }
  if (grant.resource_type !== 'root') return null;
  const folders = db.getFoldersByParent(null, grant.owner_id, false)
    .filter(item => !isLockedPath(item.id, grant.owner_id) && getFolderPermission(userId, item))
    .map(item => ({ ...serializeFolder(item, { canDownload: grant.can_download, canDelete: grant.can_delete }), _shareGrantId: grant.id }));
  const files = db.getFilesByFolder(null, grant.owner_id, false)
    .filter(item => getFilePermission(userId, item))
    .map(item => serializeFile(item, getFilePermission(userId, item)));
  return { folders, files, currentFolder: null, breadcrumbs: [{ id: null, name: 'Shared with me' }, { id: `shared-root:${grant.id}`, name: `${grant.owner_name || grant.owner_email}'s Drive` }] };
}

function isWithinSharedRoot(folderId, grant) {
  if (grant.resource_type === 'root') return true;
  if (grant.resource_type !== 'folder') return false;
  const path = folderPath(folderId, grant.owner_id);
  return Boolean(path && path.some(folder => String(folder.id) === String(grant.resource_id)));
}

module.exports = { activeGrants, folderPath, isLockedPath, getFilePermission, getFolderPermission, serializeFile, serializeFolder, rootEntry, listContents, isWithinSharedRoot };
