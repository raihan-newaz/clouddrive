const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const sharing = require('../services/userSharing');

const router = express.Router();
router.use(authMiddleware);

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100).toLowerCase();
  res.set('Cache-Control', 'no-store');
  if (q.length < 2) return res.json({ users: [] });
  const users = db.all("SELECT id, email, name FROM users WHERE id != ? AND status = 'active' AND lower(email) LIKE ? ORDER BY email LIMIT 8", [req.user.id, `%${q}%`]);
  res.set('Cache-Control', 'no-store');
  res.json({ users });
});

router.post('/', (req, res) => {
  const emails = Array.isArray(req.body.emails) ? req.body.emails : [];
  const resources = Array.isArray(req.body.resources) ? req.body.resources : [];
  if (!emails.length || emails.length > 20 || !resources.length || resources.length > 200) return res.status(400).json({ error: 'Choose 1–20 recipients and 1–200 items' });
  if (typeof req.body.canDownload !== 'boolean' || typeof req.body.canDelete !== 'boolean') return res.status(400).json({ error: 'Download and delete permissions must be selected explicitly' });
  const recipients = [];
  for (const value of emails) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'One or more recipient emails are invalid' });
    const recipient = db.getUserByEmail(email);
    if (!recipient || recipient.status !== 'active') return res.status(404).json({ error: `Active user not found: ${email}` });
    if (String(recipient.id) === String(req.user.id)) return res.status(400).json({ error: 'You cannot share items with yourself' });
    recipients.push(recipient);
  }
  const uniqueRecipients = [...new Map(recipients.map(user => [user.id, user])).values()];
  const validResources = [];
  for (const resource of resources) {
    const type = resource && resource.type;
    if (type === 'root') {
      validResources.push({ type, id: null });
    } else if (type === 'file') {
      const file = db.getFileById(String(resource.id || ''), req.user.id);
      if (!file || file.is_trashed) return res.status(404).json({ error: 'A selected file is missing or in Trash' });
      if (sharing.isLockedPath(file.folder_id, req.user.id)) return res.status(403).json({ error: `Unlock/remove the password from the containing folder before sharing ${file.name}` });
      validResources.push({ type, id: file.id });
    } else if (type === 'folder') {
      const folder = db.getFolderById(String(resource.id || ''), req.user.id);
      if (!folder || folder.is_trashed) return res.status(404).json({ error: 'A selected folder is missing or in Trash' });
      if (sharing.isLockedPath(folder.id, req.user.id)) return res.status(403).json({ error: `Unlock/remove the password from ${folder.name} before sharing it` });
      validResources.push({ type, id: folder.id });
    } else {
      return res.status(400).json({ error: 'Unsupported item type' });
    }
  }
  let created = 0;
  try {
    for (const recipient of uniqueRecipients) {
      for (const resource of validResources) {
        db.createUserShare({ id: uuidv4(), owner_id: req.user.id, recipient_id: recipient.id, resource_type: resource.type, resource_id: resource.id, can_download: req.body.canDownload, can_delete: req.body.canDelete });
        created++;
      }
    }
    db.logAuditEvent({ userId: req.user.id, userEmail: req.user.email, action: 'USER_ITEMS_SHARED', details: { recipients: uniqueRecipients.length, resources: validResources.length }, ipAddress: req.ip, userAgent: req.get('User-Agent') });
    res.status(201).json({ success: true, created, message: `Shared ${validResources.length} item(s) with ${uniqueRecipients.length} user(s)` });
  } catch (error) {
    console.error('[UserShares] Create failed:', error);
    res.status(500).json({ error: 'Could not create shares' });
  }
});

router.get('/with-me', (req, res) => {
  const entries = db.getActiveUserSharesForRecipient(req.user.id)
    .map(grant => sharing.rootEntry(grant)).filter(Boolean);
  res.set('Cache-Control', 'no-store');
  res.json({ entries });
});

router.get('/mine', (req, res) => {
  const shares = db.getActiveUserSharesForOwner(req.user.id).map(share => {
    let item = null;
    if (share.resource_type === 'file') item = db.getFileById(share.resource_id, req.user.id);
    if (share.resource_type === 'folder') item = db.getFolderById(share.resource_id, req.user.id);
    return { id: share.id, resource_type: share.resource_type, resource_id: share.resource_id, name: item?.name || 'My Drive', recipient_email: share.recipient_email, recipient_name: share.recipient_name, can_download: Boolean(share.can_download), can_delete: Boolean(share.can_delete), created_at: share.created_at };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ shares });
});

router.get('/:id/contents', (req, res) => {
  const grant = db.getUserShare(req.params.id);
  if (!grant || grant.revoked_at || String(grant.recipient_id) !== String(req.user.id)) return res.status(404).json({ error: 'Shared item not found' });
  const contents = sharing.listContents(req.user.id, grant, req.query.folderId || null);
  if (!contents) return res.status(404).json({ error: 'Shared folder not found or access was revoked' });
  res.set('Cache-Control', 'no-store');
  res.json(contents);
});

router.patch('/:id', (req, res) => {
  if (typeof req.body.canDownload !== 'boolean' || typeof req.body.canDelete !== 'boolean') return res.status(400).json({ error: 'Invalid permissions' });
  const existing = db.getUserShare(req.params.id);
  if (!existing || String(existing.owner_id) !== String(req.user.id) || existing.revoked_at) return res.status(404).json({ error: 'Share not found' });
  db.updateUserSharePermissions(existing.id, req.user.id, req.body.canDownload, req.body.canDelete);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const existing = db.getUserShare(req.params.id);
  if (!existing || String(existing.owner_id) !== String(req.user.id) || existing.revoked_at) return res.status(404).json({ error: 'Share not found' });
  db.revokeUserShare(existing.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
