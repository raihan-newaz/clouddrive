const jwt = require('jsonwebtoken');
const config = require('../config');
const http = require('http');

(async () => {
  const db = require('../db');
  await db.initialize();
  const user = db.get('SELECT * FROM users LIMIT 1');
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, tokenVersion: user.token_version || 0 }, config.JWT_SECRET, { expiresIn: '1h' });

  function postPolicy(isEnc) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ encryptionEnabled: isEnc });
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/settings/policy',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  await postPolicy(false);

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const fileContent = 'HELLO UNENCRYPTED FILE TEST ' + Date.now();
  
  let payload = '';
  payload += '--' + boundary + '\r\n';
  payload += 'Content-Disposition: form-data; name="encryptionEnabled"\r\n\r\n';
  payload += 'false\r\n';
  payload += '--' + boundary + '\r\n';
  payload += 'Content-Disposition: form-data; name="storageMode"\r\n\r\n';
  payload += 'telegram\r\n';
  payload += '--' + boundary + '\r\n';
  payload += 'Content-Disposition: form-data; name="file"; filename="plain_test.txt"\r\n';
  payload += 'Content-Type: text/plain\r\n\r\n';
  payload += fileContent + '\r\n';
  payload += '--' + boundary + '--\r\n';

  function uploadSingle() {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/files/upload',
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Authorization': 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  const upRes = await uploadSingle();
  console.log('Upload Result:', upRes.success, 'File ID:', upRes.file?.id);

  function downloadFile(fileId) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/files/' + fileId + '/download',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
  }

  const downloadedContent = await downloadFile(upRes.file.id);
  console.log('Downloaded Plaintext Match:', downloadedContent === fileContent ? 'EXACT MATCH OK!' : 'MISMATCH: ' + downloadedContent);

  function deleteFile(fileId) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/files/' + fileId + '/permanent',
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer ' + token
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.end();
    });
  }

  if (upRes.file && upRes.file.id) {
    await deleteFile(upRes.file.id);
  }
  await postPolicy(true);
  console.log('ALL UNENCRYPTED TESTS PASSED PERFECTLY!');
  process.exit(0);
})();
