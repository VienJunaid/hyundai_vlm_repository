const rtspUrl = document.getElementById("rtspUrl");
const promptInput = document.getElementById("promptInput");
const modelSelect = document.getElementById("modelSelect");
const frameInterval = document.getElementById("frameInterval");
const structuredOutput = document.getElementById("structuredOutput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const responseBox = document.getElementById("responseBox");
const structuredBox = document.getElementById("structuredBox");
const lastUpdate = document.getElementById("lastUpdate");
const lastError = document.getElementById("lastError");
const cpuStat = document.getElementById("cpuStat");
const ramStat = document.getElementById("ramStat");
const logBox = document.getElementById("logBox");

function setStatus(status, text) {
  statusBadge.textContent = status;
  statusBadge.className = `badge ${status || "idle"}`;
  statusText.textContent = text || status || "idle";
}

function appendLog(entry) {
  const line = `[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`;
  const existing = logBox.textContent.trim();
  logBox.textContent = existing ? `${existing}\n${line}` : line;
  logBox.scrollTop = logBox.scrollHeight;
}

function renderLogs(logs) {
  logBox.textContent = "";
  (logs || []).forEach(appendLog);
}

async function loadState() {
  const res = await fetch("/api/state");
  const data = await res.json();

  rtspUrl.value = data.rtsp_url || "";
  promptInput.value = data.prompt || "";
  modelSelect.value = data.model || "llama3.2-vision:11b";
  frameInterval.value = data.frame_interval || 2.0;
  structuredOutput.checked = !!data.structured_output;
  responseBox.textContent = data.latest_response || "Waiting for analysis...";
  structuredBox.textContent = data.latest_structured ? JSON.stringify(data.latest_structured, null, 2) : "No structured output yet.";
  lastUpdate.textContent = data.last_update || "—";
  lastError.textContent = data.last_error || "—";
  cpuStat.textContent = `${data.cpu_percent || 0}%`;
  ramStat.textContent = `${data.ram_percent || 0}%`;
  setStatus(data.status || "idle", data.status_text || "System idle.");
  renderLogs(data.logs || []);
}

async function startAnalysis() {
  const payload = {
    rtsp_url: rtspUrl.value.trim(),
    prompt: promptInput.value.trim(),
    model: modelSelect.value,
    frame_interval: parseFloat(frameInterval.value || "2.0"),
    structured_output: structuredOutput.checked,
  };

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
  }
}

async function stopAnalysis() {
  await fetch("/api/stop", {
    method: "POST"
  });
}

function connectEvents() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws/events`);

  ws.onopen = () => {
    ws.send("hello");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "state") {
      responseBox.textContent = msg.latest_response || "Waiting for analysis...";
      structuredBox.textContent = msg.latest_structured ? JSON.stringify(msg.latest_structured, null, 2) : "No structured output yet.";
      lastUpdate.textContent = msg.last_update || "—";
      lastError.textContent = msg.last_error || "—";
      cpuStat.textContent = `${msg.cpu_percent || 0}%`;
      ramStat.textContent = `${msg.ram_percent || 0}%`;
      setStatus(msg.status || "idle", msg.status_text || "System idle.");
      renderLogs(msg.logs || []);
    }

    if (msg.type === "status") {
      setStatus(msg.status || "idle", msg.status_text || "Status update");
    }

    if (msg.type === "response") {
      responseBox.textContent = msg.latest_response || "";
      structuredBox.textContent = msg.latest_structured ? JSON.stringify(msg.latest_structured, null, 2) : "No structured output yet.";
      lastUpdate.textContent = msg.last_update || "—";
    }

    if (msg.type === "error") {
      lastError.textContent = msg.message || "Unknown error";
      setStatus("error", msg.message || "Unknown error");
    }

    if (msg.type === "metrics") {
      cpuStat.textContent = `${msg.cpu_percent || 0}%`;
      ramStat.textContent = `${msg.ram_percent || 0}%`;
    }

    if (msg.type === "log") {
      appendLog(msg.entry);
    }
  };

  ws.onclose = () => {
    setTimeout(connectEvents, 1500);
  };
}

startBtn.addEventListener("click", startAnalysis);
stopBtn.addEventListener("click", stopAnalysis);

loadState();
connectEvents();


