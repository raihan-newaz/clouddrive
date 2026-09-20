const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('../config');
const TelegramStorageProvider = require('../storage/TelegramStorageProvider');
const DiscordStorageProvider = require('../storage/DiscordStorageProvider');
const cryptoModule = require('../crypto');

const FILE_PATH = 'C:\\Users\\Md Raihan Newaz\\Downloads\\android-studio-quail4-windows.exe';
const CHUNK_SIZE = Math.floor(9.5 * 1024 * 1024); // 9.5 MB
const CONCURRENCY = 2; // Default CloudDrive concurrency

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function prepareChunksOnProvider(provider, providerName, filePath) {
  console.log(`\n[${providerName}] Preparing & uploading test chunks to remote...`);
  const fileStats = fs.statSync(filePath);
  const fileSize = fileStats.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const fileId = uuidv4();
  const userKey = cryptoModule.generateUserEncryptionKey();
  const fd = fs.openSync(filePath, 'r');

  const chunkMetadata = [];
  let chunkQueue = [];
  for (let i = 0; i < totalChunks; i++) {
    chunkQueue.push(i);
  }

  let preparedCount = 0;
  let lastLogTime = Date.now();

  async function uploadWorker() {
    while (chunkQueue.length > 0) {
      const chunkIndex = chunkQueue.shift();
      if (chunkIndex === undefined) break;

      const offset = chunkIndex * CHUNK_SIZE;
      const currentChunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
      const chunkBuffer = Buffer.alloc(currentChunkSize);
      fs.readSync(fd, chunkBuffer, 0, currentChunkSize, offset);

      const encResult = cryptoModule.encryptChunkBuffer(
        chunkBuffer,
        userKey,
        fileId,
        chunkIndex
      );

      const remoteFileName = `dl_benchmark_${path.basename(filePath)}.part${chunkIndex}.enc`;
      const res = await provider.uploadChunk(encResult.ciphertext, remoteFileName);

      chunkMetadata[chunkIndex] = {
        chunkIndex,
        remoteId: res.remoteId,
        size: currentChunkSize,
        iv: encResult.iv,
        authTag: encResult.authTag
      };

      preparedCount++;
      const now = Date.now();
      if (now - lastLogTime >= 3000 || preparedCount === totalChunks) {
        lastLogTime = now;
        const pct = ((preparedCount / totalChunks) * 100).toFixed(1);
        console.log(`[${providerName} Setup] Prepared & Uploaded chunk ${preparedCount}/${totalChunks} (${pct}%)`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(uploadWorker());
  }

  await Promise.all(workers);
  fs.closeSync(fd);
  console.log(`[${providerName}] All ${totalChunks} chunks uploaded and ready for download test.\n`);

  return {
    fileSize,
    totalChunks,
    fileId,
    userKey,
    chunkMetadata
  };
}

async function runDownloadBenchmark(provider, providerName, prepData) {
  console.log(`======================================================`);
  console.log(` Starting Download Benchmark: [${providerName.toUpperCase()}]`);
  console.log(`======================================================`);

  const { fileSize, totalChunks, fileId, userKey, chunkMetadata } = prepData;
  let downloadedBytes = 0;
  let completedChunks = 0;

  let downloadQueue = [];
  for (let i = 0; i < totalChunks; i++) {
    downloadQueue.push(chunkMetadata[i]);
  }

  const startTime = Date.now();
  let lastLogTime = startTime;

  async function dlWorker() {
    while (downloadQueue.length > 0) {
      const item = downloadQueue.shift();
      if (!item) break;

      // Download chunk
      const encryptedBuffer = await provider.downloadChunk(item.remoteId);

      // Decrypt chunk
      const decrypted = cryptoModule.decryptChunkBuffer(
        encryptedBuffer,
        userKey,
        fileId,
        item.chunkIndex,
        item.iv,
        item.authTag
      );

      downloadedBytes += decrypted.length;
      completedChunks++;

      const now = Date.now();
      const elapsedSec = (now - startTime) / 1000;
      const speedMBps = (downloadedBytes / (1024 * 1024)) / (elapsedSec || 1);
      const percent = ((downloadedBytes / fileSize) * 100).toFixed(1);
      const remainingBytes = fileSize - downloadedBytes;
      const etaSec = remainingBytes / (speedMBps * 1024 * 1024 || 1);

      if (now - lastLogTime >= 3000 || completedChunks === totalChunks) {
        lastLogTime = now;
        console.log(
          `[${providerName.padEnd(8)} DL] Chunk ${String(completedChunks).padStart(String(totalChunks).length, ' ')}/${totalChunks} ` +
          `(${percent.padStart(5, ' ')}%) | ` +
          `${formatBytes(downloadedBytes).padStart(9, ' ')} / ${formatBytes(fileSize)} | ` +
          `Speed: ${speedMBps.toFixed(2).padStart(6, ' ')} MB/s (${(speedMBps * 8).toFixed(2)} Mbps) | ` +
          `Elapsed: ${formatDuration(elapsedSec)} | ETA: ${formatDuration(etaSec)}`
        );
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(dlWorker());
  }

  await Promise.all(workers);

  const endTime = Date.now();
  const totalDurationSec = (endTime - startTime) / 1000;
  const avgSpeedMBps = (fileSize / (1024 * 1024)) / totalDurationSec;
  const avgSpeedMbps = avgSpeedMBps * 8;

  console.log(`\n------------------------------------------------------`);
  console.log(` [${providerName.toUpperCase()}] Download Completed!`);
  console.log(` Total Time: ${formatDuration(totalDurationSec)} (${totalDurationSec.toFixed(2)} seconds)`);
  console.log(` Average Download Speed: ${avgSpeedMBps.toFixed(2)} MB/s (${avgSpeedMbps.toFixed(2)} Mbps)`);
  console.log(` Total Chunks Downloaded: ${completedChunks}`);
  console.log(`------------------------------------------------------\n`);

  return {
    providerName,
    fileSize,
    totalChunks,
    totalDurationSec,
    avgSpeedMBps,
    avgSpeedMbps,
    chunkMetadata
  };
}

async function main() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`File does not exist: ${FILE_PATH}`);
    process.exit(1);
  }

  console.log(`\n=============================================================`);
  console.log(` CLOUDDRIVE DOWNLOAD BENCHMARK: TELEGRAM VS DISCORD`);
  console.log(` Target: ${FILE_PATH}`);
  console.log(`=============================================================\n`);

  // 1. Telegram Benchmark
  const tgProvider = new TelegramStorageProvider();
  await tgProvider.initialize();
  const tgPrep = await prepareChunksOnProvider(tgProvider, 'Telegram', FILE_PATH);
  const tgResult = await runDownloadBenchmark(tgProvider, 'Telegram', tgPrep);

  console.log(`[Telegram] Cleaning up remote chunks...`);
  for (const m of tgPrep.chunkMetadata) {
    try { await tgProvider.deleteChunk(m.remoteId); } catch (e) {}
  }
  console.log(`[Telegram] Cleanup complete.\n`);

  // 2. Discord Benchmark
  const dcProvider = new DiscordStorageProvider();
  await dcProvider.initialize();
  const dcPrep = await prepareChunksOnProvider(dcProvider, 'Discord', FILE_PATH);
  const dcResult = await runDownloadBenchmark(dcProvider, 'Discord', dcPrep);

  console.log(`[Discord] Cleaning up remote chunks...`);
  for (const m of dcPrep.chunkMetadata) {
    try { await dcProvider.deleteChunk(m.remoteId); } catch (e) {}
  }
  console.log(`[Discord] Cleanup complete.\n`);

  // 3. Final Summary & Comparison
  console.log(`\n=============================================================`);
  console.log(` DOWNLOAD BENCHMARK COMPARISON RESULTS`);
  console.log(`=============================================================`);
  console.log(`File: ${path.basename(FILE_PATH)} (${formatBytes(tgResult.fileSize)})`);
  console.log(`Total Chunks: ${tgResult.totalChunks} (Chunk size: ${formatBytes(CHUNK_SIZE)})`);
  console.log(``);
  console.log(`+------------+----------------+-----------------+---------------+`);
  console.log(`| Platform   | Duration       | Avg Speed (MB/s)| Speed (Mbps)  |`);
  console.log(`+------------+----------------+-----------------+---------------+`);
  console.log(`| Telegram   | ${formatDuration(tgResult.totalDurationSec).padEnd(14, ' ')} | ${(tgResult.avgSpeedMBps.toFixed(2) + ' MB/s').padEnd(15, ' ')} | ${(tgResult.avgSpeedMbps.toFixed(2) + ' Mbps').padEnd(13, ' ')} |`);
  console.log(`| Discord    | ${formatDuration(dcResult.totalDurationSec).padEnd(14, ' ')} | ${(dcResult.avgSpeedMBps.toFixed(2) + ' MB/s').padEnd(15, ' ')} | ${(dcResult.avgSpeedMbps.toFixed(2) + ' Mbps').padEnd(13, ' ')} |`);
  console.log(`+------------+----------------+-----------------+---------------+`);

  const fasterProvider = tgResult.totalDurationSec < dcResult.totalDurationSec ? 'Telegram' : 'Discord';
  const slowerProvider = fasterProvider === 'Telegram' ? 'Discord' : 'Telegram';
  const fasterTime = Math.min(tgResult.totalDurationSec, dcResult.totalDurationSec);
  const slowerTime = Math.max(tgResult.totalDurationSec, dcResult.totalDurationSec);
  const timeSaved = slowerTime - fasterTime;
  const percentFaster = (((slowerTime - fasterTime) / slowerTime) * 100).toFixed(1);

  console.log(`\nResult: ${fasterProvider} is ${percentFaster}% faster (${formatDuration(timeSaved)} faster than ${slowerProvider}).`);
  console.log(`\nBenchmark completed successfully.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Download benchmark failed:', err);
  process.exit(1);
});
