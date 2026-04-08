const rtspUrl = document.getElementById("rtspUrl");
const promptInput = document.getElementById("promptInput");
const modelSelect = document.getElementById("modelSelect");
const frameInterval = document.getElementById("frameInterval");
const structuredOutput = document.getElementById("structuredOutput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const statusBadge = document.getElementById("statusBadge");
const connectionBadge = document.getElementById("connectionBadge");
const statusText = document.getElementById("statusText");
const responseBox = document.getElementById("responseBox");
const structuredBox = document.getElementById("structuredBox");
const lastUpdate = document.getElementById("lastUpdate");
const lastError = document.getElementById("lastError");
const cpuStat = document.getElementById("cpuStat");
const ramStat = document.getElementById("ramStat");
const logBox = document.getElementById("logBox");
const logMeta = document.getElementById("logMeta");

const amrList = document.getElementById("amrList");
const globalStopMissionBtn = document.getElementById("globalStopMissionBtn");

const videoFeed = document.getElementById("videoFeed");
const videoPlaceholder = document.getElementById("videoPlaceholder");

let socket = null;
let reconnectTimer = null;
let visibleLogEntries = [];
const MAX_VISIBLE_LOGS = 80;
const STREAM_REFRESH_MS = 1000;

injectGlowStyles();

function injectGlowStyles() {
  if (document.getElementById("live-update-glow-styles")) return;

  const style = document.createElement("style");
  style.id = "live-update-glow-styles";
  style.textContent = `
    .flash-update {
      animation: flashUpdateGlow 1s ease;
    }

    .flash-log {
      animation: flashLogGlow 0.8s ease;
    }

    @keyframes flashUpdateGlow {
      0% {
        box-shadow: 0 0 0 rgba(59, 130, 246, 0);
        transform: scale(1);
      }
      20% {
        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.18),
                    0 0 18px rgba(59, 130, 246, 0.35);
        transform: scale(1.01);
      }
      100% {
        box-shadow: 0 0 0 rgba(59, 130, 246, 0);
        transform: scale(1);
      }
    }

    @keyframes flashLogGlow {
      0% {
        box-shadow: 0 0 0 rgba(34, 197, 94, 0);
      }
      25% {
        box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14),
                    0 0 16px rgba(34, 197, 94, 0.28);
      }
      100% {
        box-shadow: 0 0 0 rgba(34, 197, 94, 0);
      }
    }
  `;
  document.head.appendChild(style);
}

function flashElement(el, className = "flash-update") {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);

  setTimeout(() => {
    el.classList.remove(className);
  }, 1100);
}


function setStatus(status, text) {
  statusBadge.textContent = status || "idle";
  statusBadge.className = `badge ${status || "idle"}`;
  statusText.textContent = text || status || "System idle.";
}

function setConnectionStatus(state) {
  if (!connectionBadge) return;
  connectionBadge.textContent = state;
  const normalized = (state || "").toLowerCase();
  connectionBadge.className = `badge connection ${normalized}`;
}

function formatLogLine(entry) {
  return `[${entry.timestamp}] ${String(entry.level || "info").toUpperCase()}: ${entry.message}`;
}

function updateLogMeta() {
  if (!logMeta) return;
  const count = visibleLogEntries.length;
  logMeta.textContent = `Newest first • ${count} entr${count === 1 ? "y" : "ies"} shown`;
}

function renderLogs(logs) {
  visibleLogEntries = [...(logs || [])]
    .slice(-MAX_VISIBLE_LOGS)
    .reverse();

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

function renderStructuredOutput(data, shouldFlash = false) {
  const nextText = data
    ? JSON.stringify(data, null, 2)
    : "No structured output yet.";

  const changed = structuredBox.textContent !== nextText;
  structuredBox.textContent = nextText;

  if (shouldFlash && changed) {
    flashElement(structuredBox);
  }
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

function renderAmrs(amrs) {
  if (!amrList) return;

  const items = Array.isArray(amrs) ? amrs : [];

  if (!items.length) {
    amrList.innerHTML = `
      <div class="amrEmpty">
        No active AMRs detected.
      </div>
    `;
    return;
  }

  amrList.innerHTML = items.map((amr) => {
    const id = amr.id || "Unknown";
    const status = amr.status || "Unknown";
    const mission = amr.mission || "No mission data";
    const location = amr.location || "Unknown location";

    return `
      <div class="amrCard">
        <div class="amrCardTop">
          <div>
            <div class="amrTitle">${id}</div>
            <div class="amrMeta">${location}</div>
          </div>
          <div class="amrStatus ${String(status).toLowerCase()}">${status}</div>
        </div>

        <div class="amrMission">${mission}</div>

        <div class="amrActions">
          <button class="secondary stopMissionBtn" data-amr-id="${id}">
            Stop Mission
          </button>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".stopMissionBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const amrId = btn.dataset.amrId;
      await stopMission(amrId);
    });
  });
}

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

  if (videoPlaceholder) {
    videoPlaceholder.style.display = "none";
  }
}

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
  renderAmrs(data.active_amrs || []);
  updateVideoFeed(data.rtsp_url || "");
}

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
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!data.ok) {
      lastError.textContent = data.error || "Failed to start analysis.";
      setStatus("error", data.error || "Failed to start analysis.");
      return;
    }

    updateVideoFeed(payload.rtsp_url);
  } catch (err) {
    lastError.textContent = err.message || "Failed to start analysis.";
    setStatus("error", err.message || "Failed to start analysis.");
  } finally {
    startBtn.disabled = false;
  }
}

async function stopAnalysis() {
  stopBtn.disabled = true;

  try {
    await fetch("/api/stop", {
      method: "POST"
    });
  } catch (err) {
    lastError.textContent = err.message || "Failed to stop analysis.";
  } finally {
    stopBtn.disabled = false;
  }
}

async function stopMission(amrId) {
  if (!amrId) return;

  try {
    const res = await fetch(`/api/amr/${encodeURIComponent(amrId)}/stop`, {
      method: "POST"
    });

    const data = await res.json();

    if (!data.ok) {
      lastError.textContent = data.error || `Failed to stop mission for ${amrId}.`;
      return;
    }
  } catch (err) {
    lastError.textContent = err.message || `Failed to stop mission for ${amrId}.`;
  }
}

async function stopAllMissions() {
  try {
    const res = await fetch("/api/amr/stop_all", {
      method: "POST"
    });

    const data = await res.json();

    if (!data.ok) {
      lastError.textContent = data.error || "Failed to stop all missions.";
    }
  } catch (err) {
    lastError.textContent = err.message || "Failed to stop all missions.";
  }
}

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
    renderAmrs(msg.active_amrs || []);
    updateVideoFeed(msg.rtsp_url || "");
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

  if (msg.type === "amrs") {
    renderAmrs(msg.active_amrs || []);
    return;
  }

  if (msg.type === "video") {
    updateVideoFeed(msg.rtsp_url || rtspUrl.value || "");
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

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(connectEvents, 1500);
  };
}



startBtn.addEventListener("click", startAnalysis);
stopBtn.addEventListener("click", stopAnalysis);

if (globalStopMissionBtn) {
  globalStopMissionBtn.addEventListener("click", stopAllMissions);
}

loadState();
connectEvents();
