const https = require('https');
const nodemailer = require('nodemailer');
const db = require('../db');

function enabled(key) { return db.getSetting(key) !== 'false'; }
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; });
      response.on('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve(data) : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    request.on('error', reject); request.write(JSON.stringify(body)); request.end();
  });
}

async function notifySecurityEvent(event, details = {}) {
  if (!enabled('alerts_enabled')) return;
  const text = `[CloudDrive alert] ${event}\n${Object.entries(details).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}: ${String(value).slice(0, 300)}`).join('\n')}`;
  const jobs = [];
  const telegramChat = process.env.TELEGRAM_ALERT_CHAT_ID || process.env.TELEGRAM_CHANNEL_ID;
  if (enabled('alert_telegram_enabled') && process.env.TELEGRAM_BOT_TOKEN && telegramChat) {
    jobs.push(postJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {}, { chat_id: telegramChat, text }));
  }
  const discordChannel = process.env.DISCORD_ALERT_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID;
  if (enabled('alert_discord_enabled') && process.env.DISCORD_BOT_TOKEN && discordChannel) {
    jobs.push(postJson(`https://discord.com/api/v10/channels/${discordChannel}/messages`, { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, { content: text }));
  }
  // SMTP secrets remain server-side; neither API responses nor the UI expose them.
  const emailTo = db.getSetting('alert_email_to') || process.env.ALERT_EMAIL_TO;
  if (enabled('alert_email_enabled') && emailTo && process.env.SMTP_HOST) {
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
    jobs.push(transport.sendMail({ from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER, to: emailTo, subject: `[CloudDrive] ${event}`, text }));
  }
  const results = await Promise.allSettled(jobs);
  results.filter(result => result.status === 'rejected').forEach(result => console.warn('[Notifications] Delivery failed:', result.reason.message));
}

module.exports = { notifySecurityEvent };
