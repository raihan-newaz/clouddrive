const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const path = require('path');
const fs = require('fs');
const StorageProvider = require('./StorageProvider');

class TelegramStorageProvider extends StorageProvider {
  constructor() {
    super('telegram');
    this.client = null;
    this.channelId = null;
    this._cachedChannelEntity = null;
  }

  async initialize(config = {}) {
    const db = require('../db');
    if (!config.forceConnect && db.getSetting('telegram_enabled') === 'false') {
      this.isInitialized = false;
      this.isExplicitlyDisconnected = true;
      return false;
    }

    const apiId = config.apiId || process.env.TELEGRAM_API_ID;
    const apiHash = config.apiHash || process.env.TELEGRAM_API_HASH;
    const botToken = config.botToken || process.env.TELEGRAM_BOT_TOKEN;
    this.channelId = config.channelId || process.env.TELEGRAM_CHANNEL_ID;

    if (!apiId || !apiHash || !botToken) {
      console.warn('[TelegramProvider] Incomplete Telegram credentials.');
      this.isInitialized = false;
      return false;
    }
    this.isExplicitlyDisconnected = false;

    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const sessionFile = path.join(dataDir, 'telegram_session.txt');
    let sessionStr = process.env.TELEGRAM_SESSION_STRING || process.env.SESSION_STRING || '';
    if (!sessionStr && fs.existsSync(sessionFile)) {
      try {
        sessionStr = fs.readFileSync(sessionFile, 'utf8').trim();
      } catch (e) {}
    }

    const stringSession = new StringSession(sessionStr);

    if (this.client) {
      try { await this.client.disconnect(); } catch (e) {}
    }

    this.client = new TelegramClient(stringSession, parseInt(apiId, 10), apiHash, {
      connectionRetries: 2,
      autoReconnect: true,
    });

    try {
      if (sessionStr) {
        await this.client.connect();
      } else {
        await this.client.start({
          botAuthToken: botToken,
        });
        const saved = this.client.session.save();
        try { fs.writeFileSync(sessionFile, saved); } catch (e) {}
      }
      this.isInitialized = true;
      this._cachedChannelEntity = null;
      console.log('[TelegramProvider] Connected to Telegram MTProto successfully');
      return true;
    } catch (err) {
      if (err.seconds) {
        console.warn(`[TelegramProvider] FloodWait detected: waiting ${err.seconds}s...`);
        await new Promise(r => setTimeout(r, (err.seconds + 2) * 1000));
        await this.client.start({ botAuthToken: botToken });
        const saved = this.client.session.save();
        try { fs.writeFileSync(sessionFile, saved); } catch (e) {}
        this.isInitialized = true;
        return true;
      }
      console.error('[TelegramProvider] Initialization failed:', err.message);
      this.isInitialized = false;
      return false;
    }
  }

  async getChannelEntity() {
    const channelId = this.channelId || process.env.TELEGRAM_CHANNEL_ID;
    if (!channelId) throw new Error('Telegram Channel ID not configured');

    if (this._cachedChannelEntity) {
      return this._cachedChannelEntity;
    }

    if (!this.client || !this.client.connected) {
      throw new Error('Telegram client is not connected');
    }

    let entity;
    try {
      entity = await this.client.getEntity(channelId);
    } catch (e) {
      try {
        entity = await this.client.getEntity(BigInt(channelId));
      } catch (e2) {
        try {
          const dialogs = await this.client.getDialogs();
          const found = dialogs.find(d => String(d.id) === String(channelId) || String(d.entity?.id) === String(channelId));
          if (found) entity = found.entity;
        } catch (e3) {}
      }
    }

    if (!entity) {
      throw new Error(`Could not resolve Telegram Channel entity for: ${channelId}`);
    }

    this._cachedChannelEntity = entity;
    return entity;
  }

  async withRetry(fn, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.client && !this.client.connected) {
          try { await this.client.connect(); } catch (e) {}
        }
        return await fn();
      } catch (err) {
        if (err.seconds) {
          console.warn(`[TelegramProvider] FloodWait detected: waiting ${err.seconds + 1}s...`);
          await new Promise(r => setTimeout(r, (err.seconds + 1) * 1000));
          continue;
        }
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async testConnection(credentials = {}) {
    const apiId = credentials.apiId || credentials.TELEGRAM_API_ID || process.env.TELEGRAM_API_ID;
    const apiHash = credentials.apiHash || credentials.TELEGRAM_API_HASH || process.env.TELEGRAM_API_HASH;
    const botToken = credentials.botToken || credentials.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const channelId = credentials.channelId || credentials.TELEGRAM_CHANNEL_ID || process.env.TELEGRAM_CHANNEL_ID;

    if (!apiId || !apiHash || !botToken) {
      return { success: false, error: 'API ID, API Hash, and Bot Token are required' };
    }

    let tempClient = null;
    try {
      tempClient = new TelegramClient(new StringSession(''), parseInt(apiId, 10), apiHash, {
        connectionRetries: 3
      });
      await tempClient.start({ botAuthToken: botToken });
      const me = await tempClient.getMe();

      if (channelId) {
        try {
          await tempClient.getEntity(channelId);
        } catch (e) {
          try { await tempClient.getEntity(BigInt(channelId)); } catch (e2) {}
        }
      }

      await tempClient.disconnect();
      return {
        success: true,
        bot: {
          id: me?.id ? me.id.toString() : '',
          username: me?.username || me?.firstName || 'Telegram Bot'
        }
      };
    } catch (err) {
      if (tempClient) {
        try { await tempClient.disconnect(); } catch (e) {}
      }
      return { success: false, error: err.message };
    }
  }

  async uploadChunk(fileSource, fileName, progressCallback = null) {
    return this.withRetry(async () => {
      const channel = await this.getChannelEntity();
      let toUpload;
      let size = 0;

      if (Buffer.isBuffer(fileSource)) {
        size = fileSource.length;
        toUpload = new CustomFile(fileName, size, '', fileSource);
      } else if (typeof fileSource === 'string') {
        const stats = fs.statSync(fileSource);
        size = stats.size;
        toUpload = new CustomFile(fileName, size, fileSource);
      }

      const fileHandle = await this.client.uploadFile({
        file: toUpload,
        workers: 4, // 4 parallel MTProto workers for high throughput on up to 2GB chunks
        maxBufferSize: 2 * 1024 * 1024 * 1024, // 2GB buffer limit: ensures in-memory chunk buffers (up to 2GB) upload directly without requiring filePath
        onProgress: (progress) => {
          if (progressCallback && size > 0) {
            progressCallback(Math.min(Math.round(progress * size), size));
          }
        }
      });

      const isEncrypted = fileName && fileName.endsWith('.enc');
      // Keep storage-channel messages compact: the filename already identifies
      // the payload and encryption is reflected by the .enc extension.
      const caption = isEncrypted ? `Encrypted · ${fileName}` : fileName;

      const message = await this.client.sendFile(channel, {
        file: fileHandle,
        caption,
        forceDocument: true,
        attributes: [
          new Api.DocumentAttributeFilename({ fileName })
        ]
      });

      return {
        remoteId: message.id.toString(),
        size,
        channelId: this.channelId
      };
    });
  }

  async downloadChunk(remoteId) {
    return this.withRetry(async () => {
      const channel = await this.getChannelEntity();
      const messageId = parseInt(remoteId, 10);
      const messages = await this.client.getMessages(channel, { ids: [messageId] });
      const message = messages[0];

      if (!message || !message.media) {
        throw new Error(`Telegram message or media not found: ${remoteId}`);
      }

      const buffer = await this.client.downloadMedia(message.media, {
        workers: 2
      });
      return buffer;
    });
  }

  async *iterDownloadChunk(remoteId, chunkSize = 1024 * 1024) {
    const channel = await this.getChannelEntity();
    const messageId = parseInt(remoteId, 10);
    const messages = await this.client.getMessages(channel, { ids: [messageId] });
    const message = messages[0];

    if (!message || !message.media) {
      throw new Error(`Telegram message or media not found: ${remoteId}`);
    }

    const iter = this.client.iterDownload({
      file: message.media,
      requestSize: chunkSize
    });

    for await (const chunk of iter) {
      yield chunk;
    }
  }

  async deleteChunk(remoteId) {
    return this.deleteChunks([remoteId]);
  }

  async deleteChunks(remoteIds) {
    if (!remoteIds || remoteIds.length === 0) return true;
    try {
      return await this.withRetry(async () => {
        const channel = await this.getChannelEntity();
        const validIds = remoteIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
        if (validIds.length === 0) return true;

        // Telegram deleteMessages accepts an array of up to 100 message IDs per call
        const batchSize = 100;
        for (let i = 0; i < validIds.length; i += batchSize) {
          const slice = validIds.slice(i, i + batchSize);
          await this.client.deleteMessages(channel, slice, { revoke: true });
        }
        return true;
      });
    } catch (err) {
      console.warn(`[TelegramProvider] Bulk delete error for ${remoteIds.length} messages:`, err.message);
      return false;
    }
  }

  async disconnect() {
    this.isInitialized = false;
    this.isExplicitlyDisconnected = true;
    this._cachedChannelEntity = null;
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (e) {}
      this.client = null;
    }
    console.log('[TelegramProvider] Disconnected (credentials preserved).');
    return true;
  }

  async getStorageUsage() {
    return {
      connected: this.isInitialized && !!this.client?.connected
    };
  }
}

module.exports = TelegramStorageProvider;
