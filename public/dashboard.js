(() => {
  const socket = io();

  const statusEl = document.getElementById("status");
  const qrImg = document.getElementById("qr-image");
  const qrPlaceholder = document.getElementById("qr-placeholder");
  const messagesEl = document.getElementById("messages");
  const jobsEl = document.getElementById("jobs");
  const logsEl = document.getElementById("logs");
  const queueActiveEl = document.getElementById("queue-active");
  const queueQueuedEl = document.getElementById("queue-queued");

  const jobs = {};

  function setStatus(status) {
    statusEl.textContent = status;

    statusEl.className = "badge";
    let css = "badge-disconnected";
    if (status === "connected") css = "badge-connected";
    else if (status === "authenticated") css = "badge-authenticated";
    else if (status === "connecting") css = "badge-connecting";
    else if (status === "auth_failure") css = "badge-auth_failure";

    statusEl.classList.add(css);
  }

  function setQR(dataUrl) {
    if (dataUrl) {
      qrImg.src = dataUrl;
      qrImg.style.display = "block";
      qrPlaceholder.style.display = "none";
    } else {
      qrImg.src = "";
      qrImg.style.display = "none";
      qrPlaceholder.style.display = "block";
    }
  }

  function appendMessage(msg) {
    const div = document.createElement("div");
    div.className = "message-item";
    if (msg.isFromTrigger) {
      div.classList.add("message-trigger");
    }

    const header = document.createElement("div");
    header.className = "message-header";

    const left = document.createElement("div");
    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = msg.name || msg.from;

    const number = document.createElement("span");
    number.className = "message-number";
    number.textContent = ` (${msg.number})`;

    left.appendChild(name);
    left.appendChild(number);

    const time = document.createElement("span");
    time.textContent = new Date(msg.timestamp).toLocaleTimeString();

    header.appendChild(left);
    header.appendChild(time);

    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = msg.content;

    div.appendChild(header);
    div.appendChild(content);

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendLog(text) {
    const line = document.createElement("div");
    line.className = "log-line";
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${text}`;
    logsEl.appendChild(line);
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  function upsertJob(job) {
    const id = job.jobId || job.id;
    if (!id) return;
    if (!jobs[id]) {
      jobs[id] = {
        id,
        mode: job.mode,
        url: job.url,
        stage: "queued",
        percent: 0,
        status: job.status || "queued",
        el: null
      };
    }

    const j = jobs[id];
    if (job.status) j.status = job.status;
    if (job.stage) j.stage = job.stage;
    if (typeof job.percent === "number") j.percent = job.percent;

    renderJob(j);
  }

  function renderJob(job) {
    let el = job.el;
    if (!el) {
      el = document.createElement("div");
      el.className = "job-item";
      el.dataset.id = job.id;

      const header = document.createElement("div");
      header.className = "job-header";

      const left = document.createElement("div");
      left.textContent = `${job.id.slice(0, 8)} • ${job.mode || ""}`;

      const statusSpan = document.createElement("span");
      statusSpan.className = "job-status";
      statusSpan.textContent = job.status || "queued";

      header.appendChild(left);
      header.appendChild(statusSpan);

      const urlDiv = document.createElement("div");
      urlDiv.style.fontSize = "11px";
      urlDiv.style.color = "#8696a0";
      urlDiv.textContent = job.url || "";

      const progressBar = document.createElement("div");
      progressBar.className = "job-progress-bar";

      const fill = document.createElement("div");
      fill.className = "job-progress-fill";
      progressBar.appendChild(fill);

      const stageDiv = document.createElement("div");
      stageDiv.style.fontSize = "11px";
      stageDiv.style.marginTop = "2px";
      stageDiv.textContent = "";

      el.appendChild(header);
      el.appendChild(urlDiv);
      el.appendChild(progressBar);
      el.appendChild(stageDiv);

      jobsEl.appendChild(el);
      job.el = el;
      job._statusEl = statusSpan;
      job._fillEl = fill;
      job._stageEl = stageDiv;
    }

    if (job._statusEl) {
      job._statusEl.textContent = job.status || "queued";
      job._statusEl.className = "job-status";
      if (job.status === "running") {
        job._statusEl.classList.add("job-status-running");
      } else if (job.status === "success") {
        job._statusEl.classList.add("job-status-success");
      } else if (job.status === "error") {
        job._statusEl.classList.add("job-status-error");
      }
    }

    if (job._fillEl) {
      job._fillEl.style.width = `${job.percent || 0}%`;
    }

    if (job._stageEl) {
      const stageText = `${job.stage || "queued"} ${job.percent || 0}%`;
      job._stageEl.textContent = stageText;
    }
  }

  // Socket events
  socket.on("status", setStatus);
  socket.on("qr", setQR);

  socket.on("message", appendMessage);

  socket.on("log", text => {
    appendLog(text);
  });

  socket.on("error", text => {
    appendLog(`ERROR: ${text}`);
  });

  socket.on("queue", snapshot => {
    if (!snapshot) return;
    queueActiveEl.textContent = snapshot.active;
    queueQueuedEl.textContent = snapshot.queued;
  });

  socket.on("job", job => {
    upsertJob(job);
    appendLog(
      `Job ${job.id} (${job.mode || ""}) queued for ${job.url || ""}`
    );
  });

  socket.on("job-status", job => {
    upsertJob(job);
    appendLog(`Job ${job.jobId} status: ${job.status}`);
  });

  socket.on("job-progress", p => {
    upsertJob(p);
  });

  socket.on("job-error", e => {
    appendLog(`Job ${e.jobId} error: ${e.error}`);
  });

  socket.on("job-finish", f => {
    appendLog(`Job ${f.jobId} finished`);
  });

  socket.on("connect", () => appendLog("Dashboard connected to server"));
  socket.on("disconnect", () => appendLog("Dashboard disconnected from server"));
})();
