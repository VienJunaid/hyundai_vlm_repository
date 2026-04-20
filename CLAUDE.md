# Hyundai Local VLM Dashboard — Project Reference

## What This Is
A FastAPI web dashboard that analyzes live RTSP video streams using Ollama vision models (llama3.2-vision:11b, gemma3:4b). Designed for Hyundai factory floor monitoring: AMR congestion detection and pallet docking alignment checks. All inference runs locally via Ollama.

---

## How to Run (Windows)

```
cd d:\Documents\GT\Capstone\vlm\hyundai_vlm_repository
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m pip install "uvicorn[standard]" websockets wsproto psutil
```

Start Ollama in a separate terminal:
```
ollama serve
```

Start the dashboard:
```
python -m uvicorn server:app --host 0.0.0.0 --port 8001 --reload
```

Access at: **http://localhost:8001** (never 0.0.0.0:8001 — Chrome blocks it)

Test Ollama is alive: `curl.exe http://localhost:11434/api/tags`

Pull models if not already downloaded:
```
ollama pull llama3.2-vision:11b
ollama pull gemma3:4b
```

### RTSP Test Stream (MediaMTX)
Terminal 1: `mediamtx`
Terminal 2:
```
cd Downloads
ffmpeg -re -stream_loop -1 -i "AMR Test Video.mp4" -c:v libx264 -preset veryfast -tune zerolatency -c:a aac -f rtsp -rtsp_transport tcp rtsp://localhost:8554/mystream
```

---

## Codebase Overview

| File | Purpose |
|------|---------|
| `server.py` | FastAPI app — routes, WebSocket broadcast, MJPEG stream, metrics loop |
| `rtsp_worker.py` | Threaded RTSP capture — frame loop + separate inference thread, live prompt update |
| `pallet_worker.py` | State machine worker for 3 docking station cameras — AMR detection + alignment scanning |
| `ollama_client.py` | Ollama HTTP client — main inference, system analysis, AMR presence check, alignment check |
| `templates/index.html` | Single-page dashboard HTML — 3-column layout, pallet orientation right panel |
| `static/app.js` | All frontend logic — WebSocket, pallet station rendering, timer animation |
| `static/style.css` | Dark theme CSS — variables, animations, pallet station cards, timer bar |
| `requirements.txt` | fastapi, uvicorn, jinja2, python-multipart, opencv-python, requests, psutil |

### Key Architecture
- **Frame loop**: `rtsp_worker.py` runs two threads — (1) frame reading loop calls `on_frame()` at full RTSP speed, (2) inference thread fires every `frame_interval` seconds (only when previous inference is done)
- **Inference thread**: Runs main VLM call + system prompt call sequentially in background; never blocks the frame/video feed
- **Live prompt update**: `worker.update_prompt(prompt)` mutates `WorkerConfig` in place — next inference cycle picks it up without RTSP reconnect
- **Broadcast**: Worker callbacks → `push_broadcast()` → `asyncio.run_coroutine_threadsafe()` → WebSocket to all clients
- **Frontend**: `connectEvents()` opens WebSocket on load, `handleSocketMessage()` routes: `state`, `status`, `response`, `error`, `metrics`, `log`, `video`, `system_analysis`, `pallet_update`
- **Pallet workers**: 3 independent `PalletStationWorker` instances — one per docking camera, each with its own state machine and RTSP thread

---

## Current Status

### Working Features ✅

#### Main RTSP Analysis
- RTSP stream capture + smooth MJPEG live feed (frame loop decoupled from inference)
- Ollama VLM inference per frame interval with background threading
- Frames resized to max 640px wide before inference
- WebSocket real-time updates to dashboard
- CPU/RAM metrics, rolling log, structured JSON output
- **Live prompt update** — "Apply Prompt (live)" button updates the running prompt without restarting the stream

#### System Analysis (center panel)
- Runs after every main VLM inference using a hardcoded system prompt
- Returns: AMR count, congestion status, one-sentence reason
- **AMR counter** — large number displayed prominently in the stat card showing exact AMR count
- Status labels: Offline / Awaiting Detection / AMR Detected / No AMR Seen / No Congestion / Congestion Detected
- Red alert banner when congestion is detected
- Blue glow flash animation on Latest VLM Response when new response arrives
#### Congestion Detection Rules (in `SYSTEM_ANALYSIS_PROMPT`)
The VLM is told to flag congestion as true in any of these cases:
1. Any AMR that has crossed past the **dotted line** into the open travel lane appears stopped or stuck
2. **3 or more AMRs** visible in the open travel lane (past the dotted line) and none appear to be moving

AMRs stationary inside the docking station area (behind the dotted line) = normal docking, NOT congestion.

#### AMR Visual Description (for VLM prompts)
Real AMRs in this simulation are **flat blue rectangular sleds/platforms**, low to the ground, with a **small yellow square marker** on top. They look like blue rectangles from overhead. Do not confuse with pallets.

#### Pallet Orientation Check (right panel) ✅
3 docking station cameras monitored independently. Each station has a full state machine:

**States:**
- `no_amr` — Camera idle, no processing (power saving)
- `amr_detected` — AMR seen, streaming low-quality feed, 5-second confirmation timer running
- `scanning` — Alignment scans running every 3 seconds
- `aligned` — ✅ Yellow markers aligned, AMR cleared for loading
- `misaligned_alert` — ❌ 5 consecutive misaligned scans, manual inspection required

**How it works:**
- AMR detection poll every 3 seconds (640px, quality 80) — only when state is `no_amr`
- After AMR confirmed for 5 seconds → begins alignment scan sequence
- Alignment scans every 3 seconds (640px, quality 75), up to 5 scans
- First ALIGNED scan → success state immediately
- 5 consecutive MISALIGNED scans → alert state
- Departure check every 6 seconds in terminal states — resets to `no_amr` when AMR leaves
- Each station streams its own low-latency MJPEG feed when active (320px, quality 25, ~15 FPS)
- `CAP_PROP_BUFFERSIZE=1` set on capture to drop stale RTSP buffer frames and minimize lag
- VLM inference frames are unaffected — still encoded at 640px / quality 75-80

**Alignment markers:**
- One yellow square on the bottom of the payload (grey structure above)
- One yellow square on the top of the blue AMR (below)
- ALIGNED = both squares at the same horizontal left-right position
- MISALIGNED = one square is offset left or right from the other

**UI per station card:**
- State badge with color + pulse animation (orange = AMR detected, blue pulse = scanning, green = aligned, red pulse = misaligned alert)
- Mini live MJPEG video feed (hidden when idle)
- Scan progress bar (0 → 5 scans)
- Explanation text from VLM
- Green success banner / Red alert banner

**Configuration:**
- Enter up to 3 RTSP URLs in the right panel → click "Configure & Start Monitoring"
- Each station runs independently; unconfigured stations stay idle

### Frame Interval Guidance
- Set to **0.3** (minimum) for fastest possible responses — inference time is the real bottleneck
- `llama3.2-vision:11b` — slower, more accurate (~8-15s per cycle)
- `gemma3:4b` — faster, lighter (~3-6s per cycle); must `ollama pull gemma3:4b` first

---

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/` | Serves dashboard HTML |
| GET | `/health` | Service health + Ollama connectivity |
| GET | `/api/state` | Full server state + logs |
| POST | `/api/start` | Start main RTSP analysis worker |
| POST | `/api/stop` | Stop main RTSP analysis worker |
| POST | `/api/update_prompt` | Live-update the VLM prompt without restarting |
| GET | `/api/video_feed` | MJPEG stream for main RTSP camera |
| GET | `/api/pallet/state` | Current state of all 3 pallet stations |
| POST | `/api/pallet/configure` | Set RTSP URLs + model for the 3 stations |
| GET | `/api/pallet/stream/{0-2}` | MJPEG stream for a specific docking station |
| WS | `/ws/events` | WebSocket event stream |

## WebSocket Message Types

| Type | Direction | Payload |
|------|-----------|---------|
| `state` | server→client | Full state on connect (includes `pallet_stations`) |
| `status` | server→client | `{status, status_text, running}` |
| `response` | server→client | `{latest_response, latest_structured, last_update}` |
| `system_analysis` | server→client | `{data: {amr_count, congestion, reason, single_amr_timer_start, single_amr_threshold}}` |
| `pallet_update` | server→client | `{station: {id, state, rtsp_url, scan_count, misaligned_count, explanation, streaming}}` |
| `metrics` | server→client | `{cpu_percent, ram_percent, timestamp}` |
| `log` | server→client | `{entry: {timestamp, level, message}}` |
| `error` | server→client | `{message}` |
| `video` | server→client | `{rtsp_url}` |

---

## Key Constants (tunable)

| Constant | File | Value | Purpose |
|----------|------|-------|---------|
| `DETECTION_INTERVAL` | `pallet_worker.py` | `3.0s` | Seconds between AMR presence polls |
| `AMR_CONFIRM_SECONDS` | `pallet_worker.py` | `5.0s` | Seconds AMR must be seen before scanning starts |
| `SCAN_INTERVAL` | `pallet_worker.py` | `3.0s` | Seconds between alignment scans |
| `MISALIGNED_THRESHOLD` | `pallet_worker.py` | `5` | Consecutive misaligned scans before alert |
| `DEPART_CHECK_INTERVAL` | `pallet_worker.py` | `6.0s` | Seconds between departure checks in terminal states |

---

## Notes & Constraints
- All inference is **local** — no cloud API calls, Ollama must be running
- Always access via **http://localhost:8001** — Chrome blocks 0.0.0.0
- WebSocket auto-reconnects every 1.5s on disconnect
- After Python file changes, uvicorn auto-reloads; JS/CSS changes need browser hard refresh (Ctrl+Shift+R)
- `ollama list` to verify which models are downloaded
- Pallet workers use the same shared `OllamaVisionClient` instance as the main worker — heavy concurrent inference may slow response times
