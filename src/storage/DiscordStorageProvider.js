const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const https = require('https');
const { Readable } = require('stream');
const StorageProvider = require('./StorageProvider');

class DiscordStorageProvider extends StorageProvider {
  constructor() {
    super('discord');
    this.client = null;
    this._cachedChannel = null;
    this.channelId = null;
    this.guildId = null;
    
    // Concurrency & Rate Limit Queue
    this.rateLimitQueue = [];
    this.activeRequests = 0;
    this.MAX_CONCURRENT_OPS = 4;
    this.requestTimestamps = [];
    this.DELAY_MS = 1000;
  }

  async initialize(config = {}) {
    const db = require('../db');
    if (!config.forceConnect && db.getSetting('discord_enabled') === 'false') {
      this.isInitialized = false;
      this.isExplicitlyDisconnected = true;
      return false;
    }

    const botToken = config.botToken || process.env.DISCORD_BOT_TOKEN;
    this.channelId = config.channelId || process.env.DISCORD_CHANNEL_ID;
    this.guildId = config.guildId || process.env.DISCORD_GUILD_ID;

    if (!botToken) {
      console.warn('[DiscordProvider] No bot token configured.');
      this.isInitialized = false;
      return false;
    }

    if (this.client && this.client.isReady() && this.isInitialized) {
      this.isExplicitlyDisconnected = false;
      return true;
    }
    this.isExplicitlyDisconnected = false;

    if (this.client) {
      try { this.client.destroy(); } catch (e) {}
    }

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      rest: {
        timeout: 20 * 60 * 1000, // 20-minute REST timeout for up to 500MB Discord Nitro chunk uploads
        retries: 3
      }
    });

    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      const timer = setTimeout(() => {
        if (this.client && this.client.isReady()) {
          this.isInitialized = true;
          done(true);
        } else {
          console.warn('[DiscordProvider] Gateway ready timeout after 15s');
          done(this.isInitialized || false);
        }
      }, 15000);

      const onReady = () => {
        clearTimeout(timer);
        this._cachedChannel = null;
        this.isInitialized = true;
        console.log(`[DiscordProvider] Connected as ${this.client?.user?.tag || this.client?.user?.username || 'Bot'}`);
        done(true);
      };

      this.client.once('clientReady', onReady);
      this.client.once('ready', onReady);

      this.client.login(botToken).catch((err) => {
        clearTimeout(timer);
        console.error('[DiscordProvider] Login error:', err.message);
        this.isInitialized = false;
        done(false);
      });
    });
  }

  async getChannel() {
    const channelId = this.channelId || process.env.DISCORD_CHANNEL_ID;
    if (!channelId) throw new Error('Discord Channel ID not configured');
    if (this._cachedChannel && this._cachedChannel.id === channelId) {
      return this._cachedChannel;
    }
    if (!this.client || !this.isInitialized) {
      throw new Error('Discord client not initialized');
    }
    const channel = await this.client.channels.fetch(channelId);
    this._cachedChannel = channel;
    return channel;
  }

  async testConnection(credentials = {}) {
    const botToken = credentials.botToken || credentials.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
    const channelId = credentials.channelId || credentials.DISCORD_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID;

    if (!botToken || !channelId) {
      return { success: false, error: 'Bot Token and Channel ID are required' };
    }

    let tempClient = null;
    try {
      tempClient = new Client({ intents: [GatewayIntentBits.Guilds] });
      await tempClient.login(botToken);
      const channel = await tempClient.channels.fetch(channelId);
      if (!channel) throw new Error('Discord Channel not found or bot lacks access');

      const botUser = {
        id: tempClient.user.id,
        username: tempClient.user.tag || tempClient.user.username
      };
      tempClient.destroy();
      return { success: true, bot: botUser };
    } catch (err) {
      if (tempClient) {
        try { tempClient.destroy(); } catch (e) {}
      }
      return { success: false, error: err.message };
    }
  }

  processQueue() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 5000);

    while (this.rateLimitQueue.length > 0 && this.activeRequests < this.MAX_CONCURRENT_OPS) {
      const currentTime = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(t => currentTime - t < 5000);

      if (this.requestTimestamps.length >= 5) {
        const oldest = this.requestTimestamps[0];
        const waitTime = Math.max(50, 5000 - (currentTime - oldest) + 50);
        setTimeout(() => this.processQueue(), waitTime);
        return;
      }

      const item = this.rateLimitQueue.shift();
      if (!item) break;

      this.activeRequests++;
      this.requestTimestamps.push(Date.now());

      item.fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
    }
  }

  enqueueRequest(fn) {
    return new Promise((resolve, reject) => {
      this.rateLimitQueue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  async withRetry(fn, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.enqueueRequest(fn);
      } catch (err) {
        if (err.status === 429) {
          const retryAfter = (err.headers && err.headers.get('retry-after')) || 5;
          console.warn(`[DiscordProvider] Rate limited. Waiting ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async uploadChunk(fileSource, fileName, progressCallback = null) {
    let size = 0;
    if (Buffer.isBuffer(fileSource)) {
      size = fileSource.length;
    } else if (typeof fileSource === 'string') {
      const stats = fs.statSync(fileSource);
      size = stats.size;
    }

    return this.withRetry(async () => {
      const channel = await this.getChannel();
      const attachment = new AttachmentBuilder(fileSource, { name: fileName });

      const isEncrypted = fileName && fileName.endsWith('.enc');
      const content = isEncrypted
        ? `CloudDrive encrypted payload: ${fileName}`
        : `CloudDrive payload: ${fileName}`;

      const message = await channel.send({
        content,
        files: [attachment]
      });

      if (progressCallback && size > 0) {
        progressCallback(size);
      }

      return {
        remoteId: message.id,
        size,
        channelId: channel.id
      };
    });
  }

  async getAttachmentUrl(messageId) {
    return this.withRetry(async () => {
      const channel = await this.getChannel();
      const message = await channel.messages.fetch(messageId);
      const attachment = message.attachments.first();
      if (!attachment) {
        throw new Error(`No attachment found in Discord message: ${messageId}`);
      }
      return attachment.url;
    });
  }

  async downloadChunk(remoteId) {
    const url = await this.getAttachmentUrl(remoteId);
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Discord download HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async *iterDownloadChunk(remoteId, chunkSize = 1024 * 1024) {
    const url = await this.getAttachmentUrl(remoteId);
    const stream = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Discord stream HTTP ${res.statusCode}`));
        }
        resolve(res);
      }).on('error', reject);
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  async deleteChunk(remoteId) {
    return this.deleteChunks([remoteId]);
  }

  async deleteChunks(remoteIds) {
    if (!remoteIds || remoteIds.length === 0) return true;
    try {
      const channel = await this.getChannel();
      const validIds = remoteIds.map(id => String(id).trim()).filter(id => id.length > 0);
      if (validIds.length === 0) return true;

      const batchSize = 100;
      for (let i = 0; i < validIds.length; i += batchSize) {
        const slice = validIds.slice(i, i + batchSize);
        try {
          if (typeof channel.bulkDelete === 'function') {
            await channel.bulkDelete(slice, true);
          } else {
            throw new Error('bulkDelete not supported');
          }
        } catch (bulkErr) {
          // Fallback: delete sequentially with error suppression
          for (const msgId of slice) {
            try {
              const message = await channel.messages.fetch(msgId).catch(() => null);
              if (message) {
                await message.delete().catch(() => {});
              }
            } catch (singleErr) {}
          }
        }
      }
      return true;
    } catch (err) {
      console.warn(`[DiscordProvider] Bulk delete error for ${remoteIds.length} messages:`, err.message);
      return false;
    }
  }

  async disconnect() {
    this.isInitialized = false;
    this.isExplicitlyDisconnected = true;
    this._cachedChannel = null;
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {}
      this.client = null;
    }
    console.log('[DiscordProvider] Disconnected (credentials preserved).');
    return true;
  }

  async getStorageUsage() {
    const isReady = !!(this.client && (this.client.isReady ? this.client.isReady() : !!this.client.user));
    return {
      connected: this.isInitialized && isReady,
      botTag: this.client?.user?.tag || (this.client?.user?.username ? `@${this.client.user.username}` : null),
      botInfo: this.client?.user ? { id: this.client.user.id, username: this.client.user.username, tag: this.client.user.tag } : null
    };
  }
}

module.exports = DiscordStorageProvider;
