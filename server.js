const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { v4: uuidv4 } = require("uuid");
const pino = require("pino");
const { spawn } = require("child_process");
const JobQueue = require("./queue");
const config = require("./config");

if (!fs.existsSync(config.DOWNLOAD_DIR)) {
  fs.mkdirSync(config.DOWNLOAD_DIR, { recursive: true });
}

const logger = pino(
  process.env.NODE_ENV === "production"
    ? {}
    : { transport: { target: "pino-pretty" } }
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, "public")));

let connectionStatus = "disconnected";
let qrCodeData = null;
let currentModeByChat = new Map();

const downloadQueue = new JobQueue(config.MAX_CONCURRENT_JOBS);

io.on("connection", socket => {
  logger.info({ id: socket.id }, "Dashboard client connected");
  socket.emit("status", connectionStatus);
  if (qrCodeData) socket.emit("qr", qrCodeData);
  socket.emit("queue", downloadQueue.getSnapshot());
});

function broadcast(event, payload) {
  io.sockets.emit(event, payload);
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, "sessions")
  }),
  puppeteer: {
    headless: true,
    timeout: 180000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu"
    ]
  }
});

client.on("loading_screen", (percent, message) => {
  logger.info({ percent, message }, "Loading screen");
  broadcast("log", `Loading: ${percent}% - ${message}`);
});

client.on("qr", async qr => {
  logger.info("Received QR code");
  connectionStatus = "connecting";
  broadcast("status", connectionStatus);

  try {
    qrCodeData = await qrcode.toDataURL(qr, { margin: 1, width: 300 });
    broadcast("qr", qrCodeData);
  } catch (err) {
    logger.error({ err }, "Failed to generate QR");
    broadcast("error", "Failed to generate QR code");
  }
});

client.on("authenticated", () => {
  logger.info("WhatsApp authenticated");
  connectionStatus = "authenticated";
  qrCodeData = null;
  broadcast("status", connectionStatus);
  broadcast("qr", null);
});

client.on("ready", () => {
  logger.info("WhatsApp client ready");
  connectionStatus = "connected";
  broadcast("status", connectionStatus);
});

client.on("auth_failure", msg => {
  logger.error({ msg }, "Authentication failure");
  connectionStatus = "auth_failure";
  qrCodeData = null;
  broadcast("status", connectionStatus);
  broadcast("error", `Auth failure: ${msg}`);
});

client.on("disconnected", reason => {
  logger.warn({ reason }, "WhatsApp disconnected");
  connectionStatus = "disconnected";
  qrCodeData = null;
  broadcast("status", connectionStatus);
  broadcast("error", `Disconnected: ${reason}`);
  client.initialize();
});

client.on("message", async msg => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const from = msg.from;
    const bareNumber = from.split("@")[0];

    const content = msg.body || "";
    const timestamp = new Date(msg.timestamp * 1000).toISOString();

    const displayName =
      contact.pushname || contact.name || contact.number || from;

    const isFromTrigger =
      bareNumber === config.TRIGGER_NUMBER ||
      contact.number === config.TRIGGER_NUMBER;

    const uiMessage = {
      id: msg.id._serialized,
      from,
      number: bareNumber,
      name: displayName,
      chatId: chat.id._serialized,
      content,
      timestamp,
      isFromTrigger
    };

    logger.info({ from, content }, "Incoming message");
    broadcast("message", uiMessage);

    if (!isFromTrigger) return;

    await handleTriggerFlow(msg, content.trim(), chat.id._serialized);
  } catch (err) {
    logger.error({ err }, "Error handling incoming message");
    broadcast("error", "Error handling incoming WhatsApp message");
  }
});

async function handleTriggerFlow(msg, content, chatId) {
  const text = content.trim();
  const lower = text.toLowerCase();

  const triggerPhrase = "can you download this?";
  const isTriggerStart = lower === triggerPhrase;

  const state = currentModeByChat.get(chatId) || null;

  if (!isTriggerStart && !state) {
    return;
  }

  if (isTriggerStart && !state) {
    currentModeByChat.set(chatId, "awaiting_type");
    await msg.reply("Welcome to Vohala World. What do you need? Video or Audio?");
    return;
  }

  if (state === "awaiting_type") {
    if (lower.includes("video")) {
      currentModeByChat.set(chatId, "awaiting_link_video");
      await msg.reply("Please send the YouTube link for the video.");
      return;
    }
    if (lower.includes("audio")) {
      currentModeByChat.set(chatId, "awaiting_link_audio");
      await msg.reply("Please send the YouTube link for the audio.");
      return;
    }

    await msg.reply('Please reply with either "Video" or "Audio".');
    return;
  }

  if (
    state === "awaiting_link_video" ||
    state === "awaiting_link_audio"
  ) {
    const urlMatch = text.match(
      /(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/[^\s]+)/i
    );
    if (!urlMatch) {
      await msg.reply(
        "I did not find a valid YouTube link. Please send a full YouTube URL."
      );
      return;
    }

    const url = urlMatch[1];
    const mode = state === "awaiting_link_video" ? "video" : "audio";

    currentModeByChat.set(chatId, null);

    await enqueueDownloadJob({ msg, url, mode });
    return;
  }

  currentModeByChat.set(chatId, null);
}

async function enqueueDownloadJob({ msg, url, mode }) {
  const chatId = (await msg.getChat()).id._serialized;
  const jobId = uuidv4();

  const description =
    mode === "video" ? "YouTube Video download" : "YouTube Audio download";

  broadcast("job", {
    id: jobId,
    chatId,
    url,
    mode,
    description,
    status: "queued"
  });

  downloadQueue.add({
    id: jobId,
    run: () => handleDownloadJob(jobId, msg, url, mode)
  });

  await msg.reply(
    `${description} queued. I will send it here when it's ready.`
  );
}

async function handleDownloadJob(jobId, msg, url, mode) {
  const updateProgress = (stage, percent, extra = {}) => {
    broadcast("job-progress", { jobId, stage, percent, ...extra });
  };

  const MAX_FILE_SIZE = 100 * 1024 * 1024;

  try {
    updateProgress("info", 0, { message: "Starting yt-dlp..." });

    const baseName = `${Date.now()}_${jobId}`;
    const ext = mode === "video" ? "mp4" : "mp3";
    const outputTemplate = path.join(
      config.DOWNLOAD_DIR,
      `${baseName}.${ext}`
    );

    const args =
      mode === "video"
        ? [
            "-f",
            "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4][height<=720]/best[height<=720]",
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--max-filesize",
            "100M",
            "-o",
            outputTemplate,
            url
          ]
        : [
            "-f",
            "bestaudio",
            "-x",
            "--audio-format",
            "mp3",
            "--no-playlist",
            "--max-filesize",
            "100M",
            "-o",
            outputTemplate,
            url
          ];

    await runYtDlp(jobId, args, updateProgress);

    let finalPath = null;

    if (fs.existsSync(outputTemplate)) {
      finalPath = outputTemplate;
    } else {
      const files = fs
        .readdirSync(config.DOWNLOAD_DIR)
        .filter(f => f.startsWith(baseName));
      if (files.length > 0) {
        finalPath = path.join(config.DOWNLOAD_DIR, files[0]);
      }
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      throw new Error("Downloaded file not found after yt-dlp completed");
    }

    if (mode === "video") {
      updateProgress("encode", 0, { message: "Re-encoding for WhatsApp compatibility..." });
      
      const reEncodedPath = finalPath.replace('.mp4', '_whatsapp.mp4');
      
      try {
        await reEncodeForWhatsApp(finalPath, reEncodedPath, updateProgress);
        fs.unlinkSync(finalPath);
        finalPath = reEncodedPath;
        updateProgress("encode", 100, { message: "Re-encoding complete" });
      } catch (err) {
        logger.warn({ err }, "Re-encoding failed, will try sending original");
      }
    }

    const stats = fs.statSync(finalPath);
    const sizeBytes = stats.size;
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

    if (sizeBytes > MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${sizeMB} MB exceeds ${MAX_FILE_SIZE / (1024 * 1024)} MB limit. WhatsApp Web cannot reliably send files this large via browser.`
      );
    }

    updateProgress("validate", 100, {
      message: `File size OK: ${sizeMB} MB`
    });

    await sendAndDelete(msg, finalPath, mode, updateProgress);
  } catch (err) {
    logger.error({ err }, "Download job failed");
    broadcast("job-error", { jobId, error: err.message || String(err) });
    await msg.reply(
      `Sorry, I could not process that ${mode}. Error: ${err.message || err}`
    );
    throw err;
  } finally {
    broadcast("job-finish", { jobId });
  }
}

function runYtDlp(jobId, args, progressCb) {
  return new Promise((resolve, reject) => {
    let stderrBuffer = "";

    const proc = spawn("yt-dlp", args);

    proc.stdout.on("data", data => {
      const text = data.toString();
      broadcast("log", `[yt-dlp ${jobId}] ${text.trim()}`);

      const match = text.match(/(\d+(?:\.\d+)?)%/);
      if (match) {
        const percent = Math.round(parseFloat(match[1]));
        progressCb("download", percent, { message: "Downloading..." });
      }
    });

    proc.stderr.on("data", data => {
      const text = data.toString();
      stderrBuffer += text;
      broadcast("log", `[yt-dlp ${jobId} ERR] ${text.trim()}`);
    });

    proc.on("close", code => {
      if (code === 0) {
        progressCb("download", 100, { message: "Download completed" });
        resolve();
      } else {
        const errMsg =
          stderrBuffer.split("\n").filter(Boolean).slice(-3).join(" | ") ||
          `yt-dlp exited with code ${code}`;
        reject(new Error(errMsg));
      }
    });

    proc.on("error", err => {
      reject(err);
    });
  });
}

function reEncodeForWhatsApp(inputPath, outputPath, progressCb) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-c:a', 'aac',
      '-strict', 'experimental',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    const proc = spawn('ffmpeg', args);
    let stderrBuffer = '';

    proc.stderr.on('data', data => {
      const text = data.toString();
      stderrBuffer += text;
      
      const match = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseFloat(match[3]);
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        
        progressCb("encode", Math.min(90, Math.floor(totalSeconds / 2)), {
          message: `Re-encoding: ${Math.floor(totalSeconds)}s processed...`
        });
      }
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        const errMsg = stderrBuffer.split('\n').filter(Boolean).slice(-3).join(' | ') ||
          `ffmpeg exited with code ${code}`;
        reject(new Error(errMsg));
      }
    });

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new Error('ffmpeg not found - install ffmpeg to enable video re-encoding'));
      } else {
        reject(err);
      }
    });
  });
}

async function sendAndDelete(msg, filePath, mode, progressCb) {
  const fileName = path.basename(filePath);
  const stats = fs.statSync(filePath);
  const sizeBytes = stats.size;
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

  progressCb("send", 0, {
    message: `Preparing to send ${fileName} (${sizeMB} MB)...`
  });

  try {
    const mimetype = mode === "video" ? "video/mp4" : "audio/mpeg";
    const media = await MessageMedia.fromFilePath(filePath);
    media.mimetype = mimetype;
    media.filename = fileName;
    
    progressCb("send", 30, {
      message: `Loaded ${fileName} into memory, uploading...`
    });

    const chat = await msg.getChat();
    
    const sendOptions = {
      caption: `${fileName} (${sizeMB} MB)`,
      sendMediaAsDocument: true
    };

    let lastError = null;
    const MAX_RETRIES = 2;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        progressCb("send", 40 + (attempt - 1) * 20, {
          message: `Sending to WhatsApp (attempt ${attempt}/${MAX_RETRIES})...`
        });
        
        await chat.sendMessage(media, sendOptions);
        
        progressCb("send", 100, {
          message: `Successfully sent ${fileName} (${sizeMB} MB)`
        });
        
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        logger.warn(
          { err, attempt, maxRetries: MAX_RETRIES },
          `Send attempt ${attempt} failed`
        );
        
        if (
          err.message?.includes("Target closed") ||
          err.message?.includes("Protocol error")
        ) {
          if (attempt < MAX_RETRIES) {
            progressCb("send", 40 + (attempt - 1) * 20, {
              message: `Browser error, retrying in 3s...`
            });
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } else {
          throw err;
        }
      }
    }
    
    if (lastError) {
      throw new Error(
        `Failed to send after ${MAX_RETRIES} attempts: ${lastError.message}`
      );
    }
  } finally {
    try {
      fs.unlinkSync(filePath);
      progressCb("cleanup", 100, { message: "Temporary file deleted" });
    } catch (err) {
      logger.warn({ err }, "Failed to delete temp file");
    }
  }
}

downloadQueue.on("job-start", jobId => {
  broadcast("job-status", { jobId, status: "running" });
  broadcast("queue", downloadQueue.getSnapshot());
});

downloadQueue.on("job-success", jobId => {
  broadcast("job-status", { jobId, status: "success" });
  broadcast("queue", downloadQueue.getSnapshot());
});

downloadQueue.on("job-error", (jobId, err) => {
  broadcast("job-status", {
    jobId,
    status: "error",
    error: err.message || String(err)
  });
  broadcast("queue", downloadQueue.getSnapshot());
});

downloadQueue.on("job-finish", jobId => {
  broadcast("queue", downloadQueue.getSnapshot());
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: connectionStatus,
    queue: downloadQueue.getSnapshot()
  });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  logger.info(`Server listening on http://${HOST}:${PORT}`);
  client.initialize();
});
