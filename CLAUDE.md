# Hyundai Local VLM Dashboard — Project Reference

## What This Is
A FastAPI web dashboard that analyzes live RTSP video streams using Ollama vision models (llama3.2-vision:11b, gemma3:4b). Designed for Hyundai factory floor monitoring: AMR fleet tracking, congestion detection, and pallet docking safety checks. All inference runs locally via Ollama.

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
| `rtsp_worker.py` | Threaded RTSP capture — frame loop + separate inference thread |
| `ollama_client.py` | HTTP client for Ollama `/api/chat` — main inference + system prompt analysis |
| `templates/index.html` | Single-page dashboard HTML — 3-column layout |
| `static/app.js` | All frontend logic — WebSocket, API calls, AMR fleet, system analysis UI |
| `static/style.css` | Dark theme CSS — variables, animations, responsive grid |
| `requirements.txt` | fastapi, uvicorn, jinja2, python-multipart, opencv-python, requests, psutil |

### Key Architecture
- **Frame loop**: `rtsp_worker.py` runs two threads — (1) frame reading loop calls `on_frame()` continuously at full RTSP speed, (2) inference thread fires every `frame_interval` seconds (only when previous inference is done)
- **Inference thread**: Runs main VLM call + system prompt call sequentially in background; never blocks the frame/video feed
- **Broadcast**: Worker callbacks → `push_broadcast()` → `asyncio.run_coroutine_threadsafe()` → WebSocket to all clients
- **Frontend**: `connectEvents()` opens WebSocket on load, `handleSocketMessage()` routes: `state`, `status`, `response`, `error`, `metrics`, `log`, `amrs`, `video`, `system_analysis`
- **AMR Panel**: Two arrays merged — `backendAmrs` (from server) + `demoAmrs` (local JS demo data, 3 pre-loaded)

---

## Current Status

### Working Features ✅
- RTSP stream capture + smooth MJPEG live feed (frame loop decoupled from inference)
- Ollama VLM inference per frame interval with background threading
- Frames resized to max 640px wide before inference (faster model response)
- WebSocket real-time updates to dashboard
- CPU/RAM metrics, rolling log, structured JSON output
- Demo AMR fleet panel (add/edit/delete/stop)
- **System Prompt (hardcoded analytics)** — fully implemented:
  - Runs after every main VLM inference using a hardcoded prompt
  - Returns: AMR count, congestion status, one-sentence reason
  - Separate "System Analysis" UI section in center panel
  - Status labels: Offline / Awaiting Detection / AMR Detected / No AMR Seen / No Congestion / Congestion Detected
  - Red alert banner appears at top of System Analysis section when congestion is detected
  - Blue glow flash animation on Latest VLM Response box when new response arrives

### Frame Interval Guidance
- Set to **0.3** (minimum) for fastest possible responses — inference time is the real bottleneck, not frame interval
- `llama3.2-vision:11b` — slower, more accurate (~8-15s per cycle)
- `gemma3:4b` — faster, lighter (~3-6s per cycle); must `ollama pull gemma3:4b` first

---

## Next Feature to Implement: Pallet Orientation Check

**Status: NOT YET STARTED**

**What it does:**
Checks if an AMR is safely aligned with its payload before pickup by analyzing yellow alignment markers.

**Physical setup:**
- Yellow marker on the **top front** of the AMR
- Yellow marker on the **bottom middle front** of the payload
- When both markers are vertically aligned → safe to pick up ✅
- When misaligned → unsafe ❌

**How it works:**
- Dedicated camera(s) positioned to capture just the docking zone (not the main RTSP stream)
- When an AMR enters "docking mode", the camera takes a snapshot
- Snapshot sent to VLM with prompt: "Are the two yellow alignment markers visible and vertically aligned? Answer: ALIGNED or MISALIGNED, and briefly explain what you see."
- Result displayed as **green ("SAFE — Aligned")** or **red ("UNSAFE — Misaligned")**

**Implementation plan:**
- New route `POST /api/pallet_check` in `server.py` — accepts image upload (multipart) or snapshot from a secondary RTSP URL
- `ollama_client.py` already supports `analyze_image(bytes)` — reuse with alignment prompt
- New UI section in `index.html`: "Pallet Docking Check" panel with:
  - Input for secondary RTSP URL or manual image upload button
  - Trigger button ("Check Alignment")
  - Result: large green or red status badge + VLM explanation text
- Potentially auto-trigger when main stream detects docking mode (future enhancement)

---

## Notes & Constraints
- All inference is **local** — no cloud API calls, Ollama must be running
- Always access via **http://localhost:8001** — Chrome blocks 0.0.0.0
- WebSocket auto-reconnects every 1.5s on disconnect
- After Python file changes, uvicorn auto-reloads; JS/CSS changes need browser hard refresh (Ctrl+Shift+R)
- `ollama list` to verify which models are downloaded
