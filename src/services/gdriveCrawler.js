const https = require('https');

async function crawlPublicGdriveUrl(url) {
  // Extract file or folder ID
  const match = url.match(/[-\w]{25,}/);
  if (!match) {
    throw new Error('Could not parse valid Google Drive ID from URL');
  }
  const id = match[0];
  const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0&confirm=t`;

  return {
    id,
    directUrl: downloadUrl
  };
}

module.exports = {
  crawlPublicGdriveUrl
};
