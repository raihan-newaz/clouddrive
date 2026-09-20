const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('../config');
const TelegramStorageProvider = require('../storage/TelegramStorageProvider');
const DiscordStorageProvider = require('../storage/DiscordStorageProvider');
const cryptoModule = require('../crypto');

const FILE_PATH = 'C:\\Users\\Md Raihan Newaz\\Downloads\\android-studio-quail4-windows.exe';
const CHUNK_SIZE = Math.floor(9.5 * 1024 * 1024); // 9.5 MB
const CONCURRENCY = 2; // Default CloudDrive upload concurrency

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

async function runBenchmarkForProvider(provider, providerName, filePath) {
  console.log(`\n======================================================`);
  console.log(` Starting Benchmark: [${providerName.toUpperCase()}]`);
  console.log(`======================================================`);

  const fileStats = fs.statSync(filePath);
  const fileSize = fileStats.size;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const fileId = uuidv4();
  const userKey = cryptoModule.generateUserEncryptionKey();
  const fd = fs.openSync(filePath, 'r');

  console.log(`File: ${path.basename(filePath)}`);
  console.log(`Size: ${formatBytes(fileSize)} (${fileSize.toLocaleString()} bytes)`);
  console.log(`Chunk size: ${formatBytes(CHUNK_SIZE)}`);
  console.log(`Total Chunks: ${totalChunks}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Initializing ${providerName} provider...`);

  const initOk = await provider.initialize();
  if (!initOk) {
    throw new Error(`Failed to initialize provider: ${providerName}`);
  }
  console.log(`[${providerName}] Provider connected & ready.\n`);

  let uploadedBytes = 0;
  let completedChunks = 0;
  const remoteIds = [];
  let chunkQueue = [];
  for (let i = 0; i < totalChunks; i++) {
    chunkQueue.push(i);
  }

  const startTime = Date.now();
  let lastLogTime = startTime;

  async function worker() {
    while (chunkQueue.length > 0) {
      const chunkIndex = chunkQueue.shift();
      if (chunkIndex === undefined) break;

      const offset = chunkIndex * CHUNK_SIZE;
      const currentChunkSize = Math.min(CHUNK_SIZE, fileSize - offset);
      const chunkBuffer = Buffer.alloc(currentChunkSize);
      fs.readSync(fd, chunkBuffer, 0, currentChunkSize, offset);

      // Encrypt chunk (AES-256-GCM standard in CloudDrive)
      const encResult = cryptoModule.encryptChunkBuffer(
        chunkBuffer,
        userKey,
        fileId,
        chunkIndex
      );

      const remoteFileName = `benchmark_${path.basename(filePath)}.part${chunkIndex}.enc`;

      // Upload chunk
      const res = await provider.uploadChunk(encResult.ciphertext, remoteFileName);
      remoteIds.push(res.remoteId);

      uploadedBytes += currentChunkSize;
      completedChunks++;

      const now = Date.now();
      const elapsedSec = (now - startTime) / 1000;
      const speedMBps = (uploadedBytes / (1024 * 1024)) / (elapsedSec || 1);
      const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
      const remainingBytes = fileSize - uploadedBytes;
      const etaSec = remainingBytes / (speedMBps * 1024 * 1024 || 1);

      // Log progress every ~3 seconds or on milestone
      if (now - lastLogTime >= 3000 || completedChunks === totalChunks) {
        lastLogTime = now;
        console.log(
          `[${providerName.padEnd(8)}] Chunk ${String(completedChunks).padStart(String(totalChunks).length, ' ')}/${totalChunks} ` +
          `(${percent.padStart(5, ' ')}%) | ` +
          `${formatBytes(uploadedBytes).padStart(9, ' ')} / ${formatBytes(fileSize)} | ` +
          `Speed: ${speedMBps.toFixed(2).padStart(6, ' ')} MB/s (${(speedMBps * 8).toFixed(2)} Mbps) | ` +
          `Elapsed: ${formatDuration(elapsedSec)} | ETA: ${formatDuration(etaSec)}`
        );
      }
    }
  }

  // Run workers concurrently
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  fs.closeSync(fd);

  const endTime = Date.now();
  const totalDurationSec = (endTime - startTime) / 1000;
  const avgSpeedMBps = (fileSize / (1024 * 1024)) / totalDurationSec;
  const avgSpeedMbps = avgSpeedMBps * 8;

  console.log(`\n------------------------------------------------------`);
  console.log(` [${providerName.toUpperCase()}] Upload Completed!`);
  console.log(` Total Time: ${formatDuration(totalDurationSec)} (${totalDurationSec.toFixed(2)} seconds)`);
  console.log(` Average Speed: ${avgSpeedMBps.toFixed(2)} MB/s (${avgSpeedMbps.toFixed(2)} Mbps)`);
  console.log(` Total Chunks: ${completedChunks}`);
  console.log(`------------------------------------------------------\n`);

  return {
    providerName,
    fileSize,
    totalChunks,
    totalDurationSec,
    avgSpeedMBps,
    avgSpeedMbps,
    remoteIds
  };
}

async function main() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`File does not exist: ${FILE_PATH}`);
    process.exit(1);
  }

  console.log(`\n=============================================================`);
  console.log(` CLOUDDRIVE UPLOAD BENCHMARK: TELEGRAM VS DISCORD`);
  console.log(` Target: ${FILE_PATH}`);
  console.log(`=============================================================\n`);

  // 1. Telegram Benchmark
  const tgProvider = new TelegramStorageProvider();
  const tgResult = await runBenchmarkForProvider(tgProvider, 'Telegram', FILE_PATH);

  // 2. Discord Benchmark
  const dcProvider = new DiscordStorageProvider();
  const dcResult = await runBenchmarkForProvider(dcProvider, 'Discord', FILE_PATH);

  // 3. Final Summary & Comparison
  console.log(`\n=============================================================`);
  console.log(` BENCHMARK COMPARISON RESULTS`);
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

  // Clean up uploaded benchmark files from channels
  console.log(`\nCleaning up benchmark chunks from channels...`);
  for (const id of tgResult.remoteIds) {
    try { await tgProvider.deleteChunk(id); } catch (e) {}
  }
  console.log(`Cleaned up Telegram benchmark chunks.`);

  for (const id of dcResult.remoteIds) {
    try { await dcProvider.deleteChunk(id); } catch (e) {}
  }
  console.log(`Cleaned up Discord benchmark chunks.`);

  console.log(`\nBenchmark completed successfully.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
