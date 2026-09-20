const express = require('express');
const eventBroadcaster = require('../services/eventBroadcaster');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.get('/events', authMiddleware, (req, res) => {
  eventBroadcaster.addClient(res, req.user.id);
});

module.exports = router;
