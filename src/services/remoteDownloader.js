const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');

function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || a >= 224;
  }
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
}

/**
 * Validates whether a remote URL is safe from SSRF attacks (private networks & metadata services)
 * @param {string} urlString
 * @returns {Promise<boolean>}
 */
async function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const host = parsed.hostname.toLowerCase();

    // Block loopback & local domains
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === '0.0.0.0'
    ) {
      return false;
    }

    // Check direct IPv4 literal
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = host.match(ipv4Regex);
    if (match) {
      const octet1 = parseInt(match[1], 10);
      const octet2 = parseInt(match[2], 10);

      // Loopback (127.0.0.0/8)
      if (octet1 === 127) return false;
      // 0.0.0.0/8
      if (octet1 === 0) return false;
      // Private Class A (10.0.0.0/8)
      if (octet1 === 10) return false;
      // Private Class B (172.16.0.0/12)
      if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return false;
      // Private Class C (192.168.0.0/16)
      if (octet1 === 192 && octet2 === 168) return false;
      // Link-Local / Cloud Instance Metadata (169.254.0.0/16)
      if (octet1 === 169 && octet2 === 254) return false;
    }

    // IPv6 checks
    if (host === '::1' || host === '[::1]' || host.startsWith('fc') || host.startsWith('fe80')) {
      return false;
    }

    const resolved = await dns.promises.lookup(host, { all: true, verbatim: true });
    return resolved.length > 0 && resolved.every(entry => !isPrivateAddress(entry.address));
  } catch (e) {
    return false;
  }
}

async function downloadRemoteUrl(url, destinationPath, progressCallback = null, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');
  const safe = await isSafeUrl(url);
  if (!safe) {
    throw new Error('Access to local, private, or restricted network addresses is blocked for security');
  }
  const parsedUrl = new URL(url);
  const resolvedAddresses = await dns.promises.lookup(parsedUrl.hostname, { all: true, verbatim: true });
  if (!resolvedAddresses.length || resolvedAddresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Remote host resolved to a restricted network address');
  }
  const pinnedAddress = resolvedAddresses[0];

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    const request = client.get(url, {
      lookup: (_hostname, _options, callback) => callback(null, pinnedAddress.address, pinnedAddress.family)
    }, async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const origin = new URL(url).origin;
          redirectUrl = `${origin}${redirectUrl}`;
        }
        res.resume();
        return downloadRemoteUrl(redirectUrl, destinationPath, progressCallback, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Remote server responded with HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      const maxBytes = 512 * 1024 * 1024;
      if (totalBytes > maxBytes) {
        res.resume();
        return reject(new Error('Remote file exceeds the 512 MB limit'));
      }
      let downloadedBytes = 0;
      const fileStream = fs.createWriteStream(destinationPath);

      res.on('data', chunk => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          res.destroy(new Error('Remote file exceeds the 512 MB limit'));
          fileStream.destroy();
          return;
        }
        if (progressCallback && totalBytes > 0) {
          progressCallback(downloadedBytes, totalBytes);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve({ path: destinationPath, size: downloadedBytes }));
      });

      fileStream.on('error', (err) => {
        fs.unlink(destinationPath, () => {});
        reject(err);
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Remote download timed out')));
    request.on('error', reject);
  });
}

module.exports = {
  downloadRemoteUrl,
  isSafeUrl
};
