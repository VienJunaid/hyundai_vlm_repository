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

const amrList = document.getElementById("amrList");
const globalStopMissionBtn = document.getElementById("globalStopMissionBtn");

const fleetTotalBadge = document.getElementById("fleetTotalBadge");
const fleetActiveCount = document.getElementById("fleetActiveCount");
const fleetDelayedCount = document.getElementById("fleetDelayedCount");
const fleetIdleCount = document.getElementById("fleetIdleCount");
const fleetMissionCount = document.getElementById("fleetMissionCount");

const demoAmrId = document.getElementById("demoAmrId");
const demoMissionId = document.getElementById("demoMissionId");
const demoAmrStatus = document.getElementById("demoAmrStatus");
const demoAmrLocation = document.getElementById("demoAmrLocation");
const demoAmrBattery = document.getElementById("demoAmrBattery");
const addDemoAmrBtn = document.getElementById("addDemoAmrBtn");
const clearDemoAmrsBtn = document.getElementById("clearDemoAmrsBtn");

const videoFeed = document.getElementById("videoFeed");
const videoPlaceholder = document.getElementById("videoPlaceholder");

const congestionAlert = document.getElementById("congestionAlert");
const congestionAlertText = document.getElementById("congestionAlertText");
const sysAmrCount = document.getElementById("sysAmrCount");
const sysCongestionStatus = document.getElementById("sysCongestionStatus");
const sysReasonBox = document.getElementById("sysReasonBox");

let socket = null;
let reconnectTimer = null;
let visibleLogEntries = [];
let backendAmrs = [];
let demoAmrs = [
  {
    id: "AMR-01",
    status: "Active",
    mission: "Mission M-1007 • Transporting pallet to outbound lane",
    location: "Pickup A3",
    battery: 84,
    source: "demo"
  },
  {
    id: "AMR-04",
    status: "Charging",
    mission: "Mission queue paused • Awaiting recharge completion",
    location: "Dock Station 2",
    battery: 22,
    source: "demo"
  },
  {
    id: "AMR-08",
    status: "Delayed",
    mission: "Mission M-1015 • Congestion near crossing and pallet merge point",
    location: "Lane C",
    battery: 61,
    source: "demo"
  }
];

const MAX_VISIBLE_LOGS = 80;

injectGlowStyles();

function injectGlowStyles() {
  if (document.getElementById("live-update-glow-styles")) return;

  const style = document.createElement("style");
  style.id = "live-update-glow-styles";
  style.textContent = `
    .flash-update {
      animation: flashUpdateGlow 1.4s ease;
    }

    .flash-log {
      animation: flashLogGlow 0.8s ease;
    }

    @keyframes flashUpdateGlow {
      0% {
        box-shadow: 0 0 0 0 rgba(73, 162, 255, 0);
        background: #0d1626;
      }
      18% {
        box-shadow: 0 0 0 4px rgba(73, 162, 255, 0.6),
                    0 0 32px rgba(73, 162, 255, 0.4),
                    inset 0 0 16px rgba(73, 162, 255, 0.1);
        background: rgba(73, 162, 255, 0.09);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(73, 162, 255, 0);
        background: #0d1626;
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
  }, 1500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeStatus(status) {
  return String(status || "Unknown").trim();
}

function statusClass(status) {
  const normalized = normalizeStatus(status).toLowerCase();
  if (normalized.includes("active") || normalized.includes("running")) return "active";
  if (normalized.includes("idle")) return "idle";
  if (normalized.includes("charging")) return "charging";
  if (normalized.includes("delay")) return "delayed";
  if (normalized.includes("error") || normalized.includes("stop")) return "error";
  return "idle";
}

function getCombinedAmrs() {
  return [...backendAmrs, ...demoAmrs];
}

function updateFleetSummary(items) {
  const amrs = Array.isArray(items) ? items : [];
  const active = amrs.filter((amr) => {
    const cls = statusClass(amr.status);
    return cls === "active";
  }).length;

  const delayed = amrs.filter((amr) => {
    const cls = statusClass(amr.status);
    return cls === "delayed" || cls === "error";
  }).length;

  const idle = amrs.filter((amr) => {
    const cls = statusClass(amr.status);
    return cls === "idle" || cls === "charging";
  }).length;

  if (fleetActiveCount) fleetActiveCount.textContent = String(active);
  if (fleetDelayedCount) fleetDelayedCount.textContent = String(delayed);
  if (fleetIdleCount) fleetIdleCount.textContent = String(idle);
  if (fleetMissionCount) fleetMissionCount.textContent = String(amrs.length);
  if (fleetTotalBadge) fleetTotalBadge.textContent = `${amrs.length} Units`;
}

function setStatus(status, text) {
  statusBadge.textContent = status || "idle";
  statusBadge.className = `badge ${status || "idle"}`;
  statusText.textContent = text || status || "System idle.";
}

function setConnectionStatus(state) {
  if (!connectionBadge) return;
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

function renderStructuredOutput(data, shouldFlash = false) {
  const nextText = data ? JSON.stringify(data, null, 2) : "No structured output yet.";
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

function setSystemAnalysisAwaiting() {
  if (sysAmrCount) {
    sysAmrCount.textContent = "Awaiting Detection";
    sysAmrCount.className = "sysStatValue awaiting";
  }
  if (sysCongestionStatus) {
    sysCongestionStatus.textContent = "Awaiting Detection";
    sysCongestionStatus.className = "sysStatValue awaiting";
  }
  if (sysReasonBox) sysReasonBox.textContent = "System analysis will begin with the next sampled frame...";
  if (congestionAlert) congestionAlert.style.display = "none";
}

function updateSystemAnalysis(data, shouldFlash = false) {
  if (!data) {
    if (sysAmrCount) {
      sysAmrCount.textContent = "Offline";
      sysAmrCount.className = "sysStatValue offline";
    }
    if (sysCongestionStatus) {
      sysCongestionStatus.textContent = "Offline";
      sysCongestionStatus.className = "sysStatValue offline";
    }
    if (sysReasonBox) sysReasonBox.textContent = "Start RTSP analysis to enable system monitoring.";
    if (congestionAlert) congestionAlert.style.display = "none";
    return;
  }

  const amrCount = data.amr_count ?? 0;
  const congestion = !!data.congestion;
  const reason = data.reason || "No details available.";

  if (sysAmrCount) {
    sysAmrCount.textContent = amrCount > 0 ? "AMR Detected" : "No AMR Seen";
    sysAmrCount.className = `sysStatValue ${amrCount > 0 ? "detected" : "none"}`;
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

function renderAmrs() {
  if (!amrList) return;

  const items = getCombinedAmrs();

  updateFleetSummary(items);

  if (!items.length) {
    amrList.innerHTML = `
      <div class="amrEmpty">
        No active AMRs detected.
      </div>
    `;
    return;
  }

  amrList.innerHTML = items.map((amr, index) => {
    const id = escapeHtml(amr.id || "Unknown");
    const status = normalizeStatus(amr.status || "Unknown");
    const location = escapeHtml(amr.location || "Unknown location");
    const mission = escapeHtml(amr.mission || "No mission data");
    const battery = amr.battery ?? "—";
    const source = amr.source || "backend";
    const cardStatusClass = statusClass(status);

    return `
      <div class="amrCard">
        <div class="amrCardTop">
          <div>
            <div class="amrTitle">${id}</div>
            <div class="amrMeta">${location} • ${source === "demo" ? "Demo Unit" : "Detected Unit"}</div>
          </div>
          <div class="amrStatus ${cardStatusClass}">${escapeHtml(status)}</div>
        </div>

        <div class="amrMission">${mission}</div>

        <div class="amrDetails">
          <div class="amrDetailBox">
            <div class="amrDetailLabel">Battery</div>
            <div class="amrDetailValue">${escapeHtml(battery)}%</div>
          </div>
          <div class="amrDetailBox">
            <div class="amrDetailLabel">Mission Source</div>
            <div class="amrDetailValue">${source === "demo" ? "Manual Demo" : "Backend Feed"}</div>
          </div>
        </div>

        <div class="amrActions">
          <button class="secondary stopMissionBtn" data-amr-id="${id}" data-source="${source}">
            Stop
          </button>
          <button class="secondary amrEditBtn" data-index="${index}" data-source="${source}">
            Edit
          </button>
          <button class="secondary amrDeleteBtn" data-index="${index}" data-source="${source}">
            Delete
          </button>
        </div>
      </div>
    `;
  }).join("");

  wireAmrButtons();
}

function wireAmrButtons() {
  document.querySelectorAll(".stopMissionBtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const amrId = btn.dataset.amrId;
      const source = btn.dataset.source;

      if (source === "demo") {
        demoAmrs = demoAmrs.map((amr) =>
          amr.id === amrId
            ? { ...amr, status: "Stopped", mission: "Mission manually aborted from demo panel" }
            : amr
        );
        renderAmrs();
        return;
      }

      await stopMission(amrId);
    });
  });

  document.querySelectorAll(".amrDeleteBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const source = btn.dataset.source;
      const index = Number(btn.dataset.index);

      if (source === "demo") {
        const demoIndex = index - backendAmrs.length;
        if (demoIndex >= 0) {
          demoAmrs.splice(demoIndex, 1);
          renderAmrs();
        }
      }
    });
  });

  document.querySelectorAll(".amrEditBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const source = btn.dataset.source;
      const index = Number(btn.dataset.index);

      if (source !== "demo") return;

      const demoIndex = index - backendAmrs.length;
      const amr = demoAmrs[demoIndex];
      if (!amr) return;

      const newMission = window.prompt("Update Mission", amr.mission || "");
      if (newMission === null) return;

      const newLocation = window.prompt("Update Location / Zone", amr.location || "");
      if (newLocation === null) return;

      const newStatus = window.prompt("Update Status", amr.status || "");
      if (newStatus === null) return;

      const newBattery = window.prompt("Update Battery %", String(amr.battery ?? 100));
      if (newBattery === null) return;

      demoAmrs[demoIndex] = {
        ...amr,
        mission: newMission.trim() || amr.mission,
        location: newLocation.trim() || amr.location,
        status: newStatus.trim() || amr.status,
        battery: Number(newBattery) >= 0 ? Number(newBattery) : amr.battery
      };

      renderAmrs();
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
  backendAmrs = Array.isArray(data.active_amrs) ? data.active_amrs.map((amr) => ({ ...amr, source: "backend" })) : [];
  renderAmrs();
  updateVideoFeed(data.rtsp_url || "");
  updateSystemAnalysis(data.latest_system_analysis || null);
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

    setSystemAnalysisAwaiting();
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

    demoAmrs = demoAmrs.map((amr) => ({
      ...amr,
      status: "Stopped",
      mission: "Mission manually aborted from global control"
    }));
    renderAmrs();
  } catch (err) {
    lastError.textContent = err.message || "Failed to stop all missions.";
  }
}

function addDemoAmr() {
  const id = demoAmrId.value.trim();
  const missionId = demoMissionId.value.trim();
  const status = demoAmrStatus.value.trim();
  const location = demoAmrLocation.value.trim() || "Unassigned Zone";
  const battery = Number(demoAmrBattery.value || 100);

  if (!id || !missionId) {
    window.alert("Please enter both AMR ID and Mission ID.");
    return;
  }

  demoAmrs.unshift({
    id,
    status,
    mission: `Mission ${missionId} • Demo task assignment`,
    location,
    battery,
    source: "demo"
  });

  demoAmrId.value = "";
  demoMissionId.value = "";
  demoAmrLocation.value = "";
  demoAmrBattery.value = "";
  demoAmrStatus.value = "Active";

  renderAmrs();
}

function clearDemoAmrs() {
  demoAmrs = [];
  renderAmrs();
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
    backendAmrs = Array.isArray(msg.active_amrs) ? msg.active_amrs.map((amr) => ({ ...amr, source: "backend" })) : [];
    renderAmrs();
    updateVideoFeed(msg.rtsp_url || "");
    updateSystemAnalysis(msg.latest_system_analysis || null);
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
    backendAmrs = Array.isArray(msg.active_amrs) ? msg.active_amrs.map((amr) => ({ ...amr, source: "backend" })) : [];
    renderAmrs();
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

if (addDemoAmrBtn) {
  addDemoAmrBtn.addEventListener("click", addDemoAmr);
}

if (clearDemoAmrsBtn) {
  clearDemoAmrsBtn.addEventListener("click", clearDemoAmrs);
}

loadState();
renderAmrs();
connectEvents();