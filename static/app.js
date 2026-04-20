const rtspUrl = document.getElementById("rtspUrl");
const promptInput = document.getElementById("promptInput");
const modelSelect = document.getElementById("modelSelect");
const frameInterval = document.getElementById("frameInterval");
const structuredOutput = document.getElementById("structuredOutput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const statusBadge = document.getElementById("statusBadge");
const connectionBadge = document.getElementById("connectionBadge");
const liveDot = document.getElementById("liveDot");
const statusText = document.getElementById("statusText");

const responseBox = document.getElementById("responseBox");
const structuredBox = document.getElementById("structuredBox");
const lastUpdate = document.getElementById("lastUpdate");
const lastError = document.getElementById("lastError");

const cpuStat = document.getElementById("cpuStat");
const ramStat = document.getElementById("ramStat");

const logBox = document.getElementById("logBox");
const logMeta = document.getElementById("logMeta");

const videoFeed = document.getElementById("videoFeed");
const videoPlaceholder = document.getElementById("videoPlaceholder");

const congestionAlert = document.getElementById("congestionAlert");
const congestionAlertText = document.getElementById("congestionAlertText");
const sysAmrCount = document.getElementById("sysAmrCount");
const sysAmrCountNum = document.getElementById("sysAmrCountNum");
const sysCongestionStatus = document.getElementById("sysCongestionStatus");
const sysReasonBox = document.getElementById("sysReasonBox");

const applyPromptBtn = document.getElementById("applyPromptBtn");
const palletConfigureBtn = document.getElementById("palletConfigureBtn");

let socket = null;
let reconnectTimer = null;
let visibleLogEntries = [];
const MAX_VISIBLE_LOGS = 80;

// Per-station last-known state (for flash-on-change detection)
const palletStates = [{}, {}, {}];


// ── Glow animations ────────────────────────────────────────────────────────────

function injectGlowStyles() {
  if (document.getElementById("glow-style-tag")) return;
  const style = document.createElement("style");
  style.id = "glow-style-tag";
  style.textContent = `
    @keyframes flashGlow {
      0%   { box-shadow: 0 0 0px rgba(73,162,255,0); }
      30%  { box-shadow: 0 0 18px rgba(73,162,255,0.55); }
      100% { box-shadow: 0 0 0px rgba(73,162,255,0); }
    }
    .flash-glow { animation: flashGlow 0.9s ease forwards; }
    @keyframes flashLog {
      0%   { background: rgba(73,162,255,0); }
      30%  { background: rgba(73,162,255,0.08); }
      100% { background: rgba(73,162,255,0); }
    }
    .flash-log { animation: flashLog 0.9s ease forwards; }
  `;
  document.head.appendChild(style);
}

function flashElement(el, className = "flash-glow") {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  el.addEventListener("animationend", () => el.classList.remove(className), { once: true });
}

injectGlowStyles();

// ── Utilities ──────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeStatus(status) {
  return (status || "").trim().toLowerCase();
}

// ── Status / connection ────────────────────────────────────────────────────────

function setStatus(status, text) {
  const s = normalizeStatus(status);
  if (statusBadge) {
    statusBadge.textContent = s;
    statusBadge.className = `badge ${s}`;
  }
  if (statusText) statusText.textContent = text || s;
}

function setConnectionStatus(state) {
  const normalized = (state || "disconnected").toLowerCase();
  connectionBadge.textContent = normalized;
  connectionBadge.className = `badge connection ${normalized}`;

  if (liveDot) {
    liveDot.classList.remove("live", "reconnecting", "offline");
    if (normalized === "live") {
      liveDot.classList.add("live");
    } else if (normalized === "connecting") {
      liveDot.classList.add("reconnecting");
    } else {
      liveDot.classList.add("offline");
    }
  }
}

// ── Logs ───────────────────────────────────────────────────────────────────────

function formatLogLine(entry) {
  return `[${entry.timestamp}] ${String(entry.level || "info").toUpperCase()}: ${entry.message}`;
}

function updateLogMeta() {
  if (!logMeta) return;
  const count = visibleLogEntries.length;
  logMeta.textContent = `Newest first • ${count} entr${count === 1 ? "y" : "ies"} shown`;
}

function renderLogs(logs) {
  visibleLogEntries = [...(logs || [])].slice(-MAX_VISIBLE_LOGS).reverse();
  logBox.textContent = visibleLogEntries.map(formatLogLine).join("\n");
  logBox.scrollTop = 0;
  updateLogMeta();
}

function prependLog(entry) {
  visibleLogEntries.unshift(entry);
  if (visibleLogEntries.length > MAX_VISIBLE_LOGS) {
    visibleLogEntries = visibleLogEntries.slice(0, MAX_VISIBLE_LOGS);
  }
  logBox.textContent = visibleLogEntries.map(formatLogLine).join("\n");
  logBox.scrollTop = 0;
  updateLogMeta();
  flashElement(logBox, "flash-log");
}

// ── VLM response / structured ──────────────────────────────────────────────────

function renderStructuredOutput(data, shouldFlash = false) {
  const nextText = data ? JSON.stringify(data, null, 2) : "No structured output yet.";
  const changed = structuredBox.textContent !== nextText;
  structuredBox.textContent = nextText;
  if (shouldFlash && changed) flashElement(structuredBox);
}

function updateResponseBox(text, shouldFlash = false) {
  const nextText = text || "Waiting for analysis...";
  const changed = responseBox.textContent !== nextText;
  responseBox.textContent = nextText;
  if (shouldFlash && changed) {
    flashElement(responseBox);
    flashElement(lastUpdate);
  }
}

// ── System analysis ────────────────────────────────────────────────────────────

function setSystemAnalysisAwaiting() {
  if (sysAmrCountNum) { sysAmrCountNum.textContent = "—"; sysAmrCountNum.className = "sysStatValue awaiting"; }
  if (sysAmrCount) { sysAmrCount.textContent = "Awaiting Detection"; }
  if (sysCongestionStatus) {
    sysCongestionStatus.textContent = "Awaiting Detection";
    sysCongestionStatus.className = "sysStatValue awaiting";
  }
  if (sysReasonBox) sysReasonBox.textContent = "System analysis will begin with the next sampled frame...";
  if (congestionAlert) congestionAlert.style.display = "none";
}

function updateSystemAnalysis(data, shouldFlash = false) {
  if (!data) {
    if (sysAmrCountNum) { sysAmrCountNum.textContent = "—"; sysAmrCountNum.className = "sysStatValue offline"; }
    if (sysAmrCount) { sysAmrCount.textContent = "Offline"; }
    if (sysCongestionStatus) { sysCongestionStatus.textContent = "Offline"; sysCongestionStatus.className = "sysStatValue offline"; }
    if (sysReasonBox) sysReasonBox.textContent = "Start RTSP analysis to enable system monitoring.";
    if (congestionAlert) congestionAlert.style.display = "none";
    return;
  }

  const amrCount = data.amr_count ?? 0;
  const congestion = !!data.congestion;
  const reason = data.reason || "No details available.";

  if (sysAmrCountNum) {
    sysAmrCountNum.textContent = amrCount;
    sysAmrCountNum.className = `sysStatValue ${amrCount > 0 ? "detected" : "none"}`;
    sysAmrCountNum.style.fontSize = "32px";
  }
  if (sysAmrCount) {
    sysAmrCount.textContent = amrCount > 0 ? `AMR${amrCount === 1 ? "" : "s"} Detected` : "No AMR Seen";
  }
  if (sysCongestionStatus) {
    sysCongestionStatus.textContent = congestion ? "Congestion Detected" : "No Congestion";
    sysCongestionStatus.className = `sysStatValue ${congestion ? "congested" : "clear"}`;
  }
  if (sysReasonBox) sysReasonBox.textContent = reason;

  if (congestionAlert) {
    if (congestion) {
      congestionAlert.style.display = "flex";
      if (congestionAlertText) congestionAlertText.textContent = `Congestion detected: ${reason}`;
    } else {
      congestionAlert.style.display = "none";
    }
  }

  if (shouldFlash) {
    flashElement(sysReasonBox);
    if (sysAmrCount) flashElement(sysAmrCount.closest(".sysStatCard"));
    if (sysCongestionStatus) flashElement(sysCongestionStatus.closest(".sysStatCard"));
  }
}

// ── Video feed ─────────────────────────────────────────────────────────────────

function updateVideoFeed(rtspValue) {
  if (!videoFeed) return;
  const hasRtsp = !!(rtspValue && rtspValue.trim());
  if (!hasRtsp) {
    videoFeed.style.display = "none";
    if (videoPlaceholder) {
      videoPlaceholder.style.display = "block";
      videoPlaceholder.textContent = "No RTSP source loaded.";
    }
    return;
  }
  const url = `/api/video_feed?t=${Date.now()}`;
  videoFeed.src = url;
  videoFeed.style.display = "block";
  if (videoPlaceholder) videoPlaceholder.style.display = "none";
}

// ── Pallet station rendering ───────────────────────────────────────────────────

const STATE_BADGE_TEXT = {
  no_amr: "No AMR",
  amr_detected: "AMR Detected",
  scanning: "Scanning...",
  aligned: "ALIGNED",
  misaligned_alert: "MISALIGNED — Alert",
};

const STATE_BADGE_CLASS = {
  no_amr: "no-amr",
  amr_detected: "amr-detected",
  scanning: "scanning",
  aligned: "aligned",
  misaligned_alert: "misaligned-alert",
};

function renderStation(info) {
  if (!info || info.id === undefined) return;

  const id = info.id;
  const stateKey = info.state || "no_amr";
  const scanCount = info.scan_count || 0;
  const explanation = info.explanation || "";
  const streaming = !!info.streaming;
  const hasUrl = !!info.rtsp_url;

  const badge       = document.getElementById(`stationBadge${id}`);
  const videoWrap   = document.getElementById(`stationVideoWrap${id}`);
  const video       = document.getElementById(`stationVideo${id}`);
  const placeholder = document.getElementById(`stationPlaceholder${id}`);
  const scanInfo    = document.getElementById(`stationScanInfo${id}`);
  const scanCountEl = document.getElementById(`stationScanCount${id}`);
  const progressBar = document.getElementById(`stationProgressBar${id}`);
  const explanEl    = document.getElementById(`stationExplanation${id}`);
  const alertEl     = document.getElementById(`stationAlertMsg${id}`);
  const successEl   = document.getElementById(`stationSuccessMsg${id}`);

  if (badge) {
    badge.textContent = STATE_BADGE_TEXT[stateKey] || stateKey;
    badge.className = `stationBadge ${STATE_BADGE_CLASS[stateKey] || "no-amr"}`;
  }

  if (streaming) {
    if (videoWrap) videoWrap.style.display = "block";
    if (placeholder) placeholder.style.display = "none";
    if (video) {
      const expected = `/api/pallet/stream/${id}`;
      if (!video.src.includes(expected)) {
        video.src = `${expected}?t=${Date.now()}`;
      }
    }
  } else {
    if (videoWrap) videoWrap.style.display = "none";
    if (video) video.src = "";
    if (placeholder) {
      placeholder.style.display = "block";
      placeholder.textContent = hasUrl ? "Camera idle — no AMR detected" : "No camera configured";
    }
  }

  const showScan = stateKey === "scanning" || stateKey === "aligned" || stateKey === "misaligned_alert";
  if (scanInfo) scanInfo.style.display = showScan ? "block" : "none";
  if (showScan) {
    if (scanCountEl) scanCountEl.textContent = `${scanCount} / 5`;
    if (progressBar) {
      const pct = Math.min((scanCount / 5) * 100, 100);
      progressBar.style.width = `${pct}%`;
      progressBar.className = `stationProgressBar${stateKey === "aligned" ? " bar-aligned" : stateKey === "misaligned_alert" ? " bar-alert" : ""}`;
    }
  }

  if (explanEl) explanEl.textContent = explanation;
  if (alertEl)   alertEl.style.display   = stateKey === "misaligned_alert" ? "flex" : "none";
  if (successEl) successEl.style.display = stateKey === "aligned"          ? "flex" : "none";

  const prev = palletStates[id];
  if (prev.state && prev.state !== stateKey) {
    const card = document.getElementById(`stationCard${id}`);
    flashElement(card);
  }

  palletStates[id] = info;
}

// ── Pallet camera configuration ────────────────────────────────────────────────

async function configurePalletCameras() {
  const urls = [
    (document.getElementById("palletUrl0") || {}).value || "",
    (document.getElementById("palletUrl1") || {}).value || "",
    (document.getElementById("palletUrl2") || {}).value || "",
  ].map(u => u.trim());

  const model = (document.getElementById("palletModel") || {}).value || "llama3.2-vision:11b";

  if (palletConfigureBtn) palletConfigureBtn.disabled = true;

  try {
    const res = await fetch("/api/pallet/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, model }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (lastError) lastError.textContent = data.error || "Failed to configure pallet cameras.";
    }
  } catch (err) {
    if (lastError) lastError.textContent = err.message || "Failed to configure pallet cameras.";
  } finally {
    if (palletConfigureBtn) palletConfigureBtn.disabled = false;
  }
}

// ── State load ─────────────────────────────────────────────────────────────────

async function loadState() {
  const res = await fetch("/api/state");
  const data = await res.json();

  rtspUrl.value = data.rtsp_url || "";
  promptInput.value = data.prompt || "";
  modelSelect.value = data.model || "llama3.2-vision:11b";
  frameInterval.value = data.frame_interval || 2.0;
  structuredOutput.checked = !!data.structured_output;

  updateResponseBox(data.latest_response || "Waiting for analysis...");
  renderStructuredOutput(data.latest_structured);
  lastUpdate.textContent = data.last_update || "—";
  lastError.textContent = data.last_error || "—";
  cpuStat.textContent = `${data.cpu_percent || 0}%`;
  ramStat.textContent = `${data.ram_percent || 0}%`;
  setStatus(data.status || "idle", data.status_text || "System idle.");
  renderLogs(data.logs || []);
  updateVideoFeed(data.rtsp_url || "");
  updateSystemAnalysis(data.latest_system_analysis || null);
}

async function loadPalletState() {
  try {
    const res = await fetch("/api/pallet/state");
    const data = await res.json();
    if (data.stations) data.stations.forEach(renderStation);
  } catch (_) {}
}

// ── Analysis controls ──────────────────────────────────────────────────────────

async function startAnalysis() {
  const payload = {
    rtsp_url: rtspUrl.value.trim(),
    prompt: promptInput.value.trim(),
    model: modelSelect.value,
    frame_interval: parseFloat(frameInterval.value || "2.0"),
    structured_output: structuredOutput.checked,
  };

  startBtn.disabled = true;
  lastError.textContent = "—";

  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      lastError.textContent = data.error || "Failed to start analysis.";
      setStatus("error", data.error || "Failed to start analysis.");
      return;
    }
    setSystemAnalysisAwaiting();
    updateVideoFeed(payload.rtsp_url);
  } catch (err) {
    lastError.textContent = err.message || "Failed to start analysis.";
    setStatus("error", err.message || "Failed to start analysis.");
  } finally {
    startBtn.disabled = false;
  }
}

async function applyPromptLive() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  if (applyPromptBtn) applyPromptBtn.disabled = true;

  try {
    const res = await fetch("/api/update_prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!data.ok) {
      lastError.textContent = data.error || "Failed to update prompt.";
    } else {
      flashElement(promptInput);
    }
  } catch (err) {
    lastError.textContent = err.message || "Failed to update prompt.";
  } finally {
    if (applyPromptBtn) applyPromptBtn.disabled = false;
  }
}

async function stopAnalysis() {
  stopBtn.disabled = true;
  try {
    await fetch("/api/stop", { method: "POST" });
  } catch (err) {
    lastError.textContent = err.message || "Failed to stop analysis.";
  } finally {
    stopBtn.disabled = false;
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

function handleSocketMessage(msg) {
  if (msg.type === "state") {
    updateResponseBox(msg.latest_response || "Waiting for analysis...");
    renderStructuredOutput(msg.latest_structured);
    lastUpdate.textContent = msg.last_update || "—";
    lastError.textContent = msg.last_error || "—";
    cpuStat.textContent = `${msg.cpu_percent || 0}%`;
    ramStat.textContent = `${msg.ram_percent || 0}%`;
    setStatus(msg.status || "idle", msg.status_text || "System idle.");
    renderLogs(msg.logs || []);
    updateVideoFeed(msg.rtsp_url || "");
    updateSystemAnalysis(msg.latest_system_analysis || null);
    if (Array.isArray(msg.pallet_stations)) msg.pallet_stations.forEach(renderStation);
    return;
  }

  if (msg.type === "status") {
    setStatus(msg.status || "idle", msg.status_text || "Status update");
    return;
  }

  if (msg.type === "response") {
    updateResponseBox(msg.latest_response || "", true);
    renderStructuredOutput(msg.latest_structured, true);
    lastUpdate.textContent = msg.last_update || "—";
    return;
  }

  if (msg.type === "error") {
    lastError.textContent = msg.message || "Unknown error";
    setStatus("error", msg.message || "Unknown error");
    return;
  }

  if (msg.type === "metrics") {
    cpuStat.textContent = `${msg.cpu_percent || 0}%`;
    ramStat.textContent = `${msg.ram_percent || 0}%`;
    return;
  }

  if (msg.type === "log") {
    prependLog(msg.entry);
    return;
  }

  if (msg.type === "video") {
    updateVideoFeed(msg.rtsp_url || rtspUrl.value || "");
    return;
  }

  if (msg.type === "system_analysis") {
    updateSystemAnalysis(msg.data, true);
    return;
  }

  if (msg.type === "pallet_update") {
    renderStation(msg.station);
    return;
  }
}

function connectEvents() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws/events`);

  setConnectionStatus("connecting");

  socket.onopen = () => {
    setConnectionStatus("live");
    socket.send("hello");
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleSocketMessage(msg);
  };

  socket.onerror = () => {
    setConnectionStatus("disconnected");
  };

  socket.onclose = () => {
    setConnectionStatus("disconnected");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectEvents, 1500);
  };
}

// ── Event listeners ────────────────────────────────────────────────────────────

startBtn.addEventListener("click", startAnalysis);
stopBtn.addEventListener("click", stopAnalysis);

if (applyPromptBtn) {
  applyPromptBtn.addEventListener("click", applyPromptLive);
}

if (palletConfigureBtn) {
  palletConfigureBtn.addEventListener("click", configurePalletCameras);
}

loadState();
loadPalletState();
connectEvents();
