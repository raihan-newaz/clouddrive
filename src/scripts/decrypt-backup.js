const fs = require('fs');
const path = require('path');
const cryptoModule = require('../crypto');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log('Usage: node decrypt-backup.js <encrypted_file> <output_file> <encryption_key> [iv_base64]');
    process.exit(1);
  }

  const [encPath, outPath, key, iv] = args;
  try {
    console.log('Decrypting offline database backup...');
    await cryptoModule.decryptFile(encPath, outPath, key, iv || null, null, 'db-backup');
    console.log(`Successfully decrypted to: ${outPath}`);
  } catch (err) {
    console.error('Decryption failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
