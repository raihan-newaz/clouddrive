/*
 * TEMPORARY, IRREVERSIBLE TOOL.
 * Deletes every message in the configured Telegram channel, including files
 * that were not uploaded by CloudDrive. Telegram requires a user account
 * session for channel history; bot sessions are rejected.
 * Run only with: PURGE_CONFIRM=DELETE_ALL_TELEGRAM_MESSAGES node ...
 */
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

async function ask(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function main() {
  if (process.env.PURGE_CONFIRM !== 'DELETE_ALL_TELEGRAM_MESSAGES') {
    throw new Error('Refusing to run. Set PURGE_CONFIRM=DELETE_ALL_TELEGRAM_MESSAGES explicitly.');
  }
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!apiId || !apiHash || !channelId) throw new Error('TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_CHANNEL_ID are required.');

  const sessionPath = path.join(config.DATA_DIR, 'telegram_session.txt');
  const savedSession = process.env.TELEGRAM_USER_LOGIN === '1' ? '' :
    (process.env.TELEGRAM_SESSION_STRING || process.env.SESSION_STRING ||
      (fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, 'utf8').trim() : ''));
  const client = new TelegramClient(new StringSession(savedSession), apiId, apiHash, { connectionRetries: 3 });
  if (savedSession) {
    await client.connect();
  } else {
    console.log('No user session found. Telegram will send a login code to your account.');
    await client.start({
      phoneNumber: async () => ask('Telegram phone number (with country code): '),
      phoneCode: async () => ask('Telegram login code: '),
      password: async () => ask('Telegram 2FA password (leave blank if none): '),
      onError: (err) => console.error('Telegram login error:', err.message),
    });
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, client.session.save(), 'utf8');
    console.log(`User session saved locally at ${sessionPath}`);
  }
  const me = await client.getMe();
  if (me?.bot) throw new Error('The configured session belongs to a bot. Use a Telegram user account session (admin in the channel).');
  console.log(`Authenticated as ${me.username ? '@' + me.username : me.firstName || 'Telegram user'}.`);
  const channel = await client.getEntity(channelId);
  const ids = [];
  for await (const message of client.iterMessages(channel, { limit: undefined })) {
    if (message?.id) ids.push(Number(message.id));
  }
  console.log(`Found ${ids.length} Telegram messages.`);
  const confirm = await ask('Type DELETE_ALL_TELEGRAM_MESSAGES again to permanently delete them: ');
  if (confirm !== 'DELETE_ALL_TELEGRAM_MESSAGES') throw new Error('Confirmation did not match; nothing was deleted.');
  console.log('Deleting in batches...');
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    await client.deleteMessages(channel, batch, { revoke: true });
    console.log(`Deleted ${Math.min(i + batch.length, ids.length)}/${ids.length}`);
  }
  await client.disconnect();
  console.log('Telegram channel purge completed. This cannot be undone.');
}

main().catch(err => { console.error('Telegram purge failed:', err.message); process.exitCode = 1; });
