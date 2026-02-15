// server.js
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
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
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

  // FIX 1: If already in flow and user sends trigger again, ignore
  if (isTriggerStart && state) {
    logger.info("User already in flow, ignoring duplicate trigger");
    return;
  }

  if (!isTriggerStart && !state) {
    return;
  }

  if (isTriggerStart && !state) {
    currentModeByChat.set(chatId, "awaiting_type");
    await msg.reply("What do you need? Video or Audio?");
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

    // FIX: Clear state immediately to prevent duplicate processing
    currentModeByChat.delete(chatId);

    await enqueueDownloadJob({ msg, url, mode });
    return;
  }

  currentModeByChat.delete(chatId);
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

  try {
    updateProgress("info", 0, { message: "Starting yt-dlp..." });

    const baseName = `${Date.now()}_${jobId}`;
    const outputTemplate = path.join(
      config.DOWNLOAD_DIR,
      `${baseName}.%(ext)s`
    );

    // FIX 2: Use more flexible format selectors that work for all videos
    const args =
      mode === "video"
        ? [
            "-f",
            "best[ext=mp4]/best",  // Try best mp4, fallback to any best format
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "-o",
            outputTemplate,
            url
          ]
        : [
            "-f",
            "bestaudio/best",  // Try best audio, fallback to best overall
            "-x",
            "--audio-format",
            "mp3",
            "--no-playlist",
            "-o",
            outputTemplate,
            url
          ];

    const downloadInfo = await runYtDlp(jobId, args, updateProgress);

    let finalPath = null;
    if (downloadInfo && downloadInfo.filename) {
      finalPath = downloadInfo.filename;
    } else {
      const files = fs
        .readdirSync(config.DOWNLOAD_DIR)
        .filter(f => f.startsWith(baseName + "."));
      if (files.length > 0) {
        finalPath = path.join(config.DOWNLOAD_DIR, files[0]);
      }
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      throw new Error("Downloaded file not found");
    }

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
    let lastFilename = null;
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

      const fileMatch = text.match(/Destination:\s(.+)$/m);
      if (fileMatch) {
        lastFilename = fileMatch[1].trim();
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
        resolve({ filename: lastFilename });
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

async function sendAndDelete(msg, filePath, mode, progressCb) {
  const fileName = path.basename(filePath);
  progressCb("send", 0, { message: `Sending ${fileName} via WhatsApp...` });

  const stats = fs.statSync(filePath);
  const sizeBytes = stats.size;

  const chat = await msg.getChat();
  
  // Send file as media with proper MIME type detection
  const messageMedia = require("whatsapp-web.js").MessageMedia;
  const media = messageMedia.fromFilePath(filePath);
  
  await chat.sendMessage(media, {
    caption: fileName
  });

  progressCb("send", 100, { message: `Sent ${fileName} (${sizeBytes} bytes)` });

  try {
    fs.unlinkSync(filePath);
    progressCb("cleanup", 100, { message: "Temporary file deleted" });
  } catch (err) {
    logger.warn({ err }, "Failed to delete temp file");
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
  
  // Clean Chromium lock files from previous runs
  const sessionsDir = path.join(__dirname, "sessions");
  if (fs.existsSync(sessionsDir)) {
    const cleanLockFiles = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanLockFiles(fullPath);
          } else if (entry.name === "SingletonLock") {
            try {
              fs.unlinkSync(fullPath);
              logger.info({ path: fullPath }, "Removed Chromium lock file");
            } catch (err) {
              logger.warn({ err, path: fullPath }, "Could not remove lock");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, dir }, "Error scanning sessions directory");
      }
    };
    cleanLockFiles(sessionsDir);
  }
  
  client.initialize();
});
