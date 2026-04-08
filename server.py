import asyncio
from collections import deque
from datetime import datetime
from typing import Deque, Set
from threading import Lock
from fastapi.responses import StreamingResponse
import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import time

from ollama_client import OllamaVisionClient
from rtsp_worker import RTSPAnalysisWorker, WorkerConfig

app = FastAPI(title="Hyundai Local VLM Dashboard")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

connected_clients: Set[WebSocket] = set()
logs: Deque[dict] = deque(maxlen=200)

state = {
    "running": False,
    "status": "idle",
    "status_text": "System idle.",
    "rtsp_url": "",
    "prompt": "Analyze this factory scene. Focus on AMR congestion, pallet blockage, worker presence, and operational hazards. Keep the answer concise.",
    "model": "llama3.2-vision:11b",
    "frame_interval": 2.0,
    "structured_output": False,
    "latest_response": "",
    "latest_structured": None,
    "last_update": None,
    "last_error": None,
    "cpu_percent": 0.0,
    "ram_percent": 0.0,
}

ollama = OllamaVisionClient()
main_loop = None

latest_frame = None
frame_lock = Lock()

def handle_frame(frame_bytes: bytes):
    global latest_frame
    with frame_lock:
        latest_frame = frame_bytes



def iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


async def broadcast(message: dict):
    dead = []
    for ws in connected_clients:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)

    for ws in dead:
        connected_clients.discard(ws)


def push_broadcast(message: dict):
    if main_loop is None:
        return
    asyncio.run_coroutine_threadsafe(broadcast(message), main_loop)


def add_log(message: str, level: str = "info"):
    entry = {
        "timestamp": iso_now(),
        "level": level,
        "message": message,
    }
    logs.append(entry)
    push_broadcast({
        "type": "log",
        "entry": entry,
    })


def handle_result(payload: dict):
    state["latest_response"] = payload["summary"]
    state["latest_structured"] = payload.get("structured")
    state["last_update"] = iso_now()

    push_broadcast({
        "type": "response",
        "latest_response": state["latest_response"],
        "latest_structured": state["latest_structured"],
        "last_update": state["last_update"],
    })


def handle_status(payload: dict):
    state["status"] = payload.get("state", "unknown")
    state["status_text"] = payload.get("text", "")
    state["running"] = state["status"] == "running"

    push_broadcast({
        "type": "status",
        "status": state["status"],
        "status_text": state["status_text"],
        "running": state["running"],
    })


def handle_error(message: str):
    state["last_error"] = message
    state["status"] = "error"
    state["status_text"] = message
    state["running"] = False
    add_log(message, level="error")

    push_broadcast({
        "type": "error",
        "message": message,
    })

    push_broadcast({
        "type": "status",
        "status": state["status"],
        "status_text": state["status_text"],
        "running": state["running"],
    })


worker = RTSPAnalysisWorker(
    ollama_client=ollama,
    on_result=handle_result,
    on_status=handle_status,
    on_error=handle_error,
    on_log=add_log,
    on_frame=handle_frame,
)


@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()
    add_log("Hyundai Local VLM Dashboard started.")
    asyncio.create_task(metrics_loop())


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/health")
async def health():
    ollama_ok = ollama.health_check() is not None
    return {
        "ok": True,
        "timestamp": iso_now(),
        "service": "hyundai-local-vlm-dashboard",
        "ollama_reachable": ollama_ok,
        "running": state["running"],
        "status": state["status"],
    }


@app.get("/api/state")
async def get_state():
    return {
        **state,
        "logs": list(logs),
    }


@app.post("/api/start")
async def start_analysis(request: Request):
    body = await request.json()

    rtsp_url = body.get("rtsp_url", "").strip()
    prompt = body.get("prompt", "").strip()
    model = body.get("model", "").strip() or "llama3.2-vision:11b"
    frame_interval = float(body.get("frame_interval", 2.0))
    structured_output = bool(body.get("structured_output", False))

    if not rtsp_url:
        return JSONResponse({"ok": False, "error": "Missing RTSP URL"}, status_code=400)

    if not prompt:
        return JSONResponse({"ok": False, "error": "Missing prompt"}, status_code=400)

    state["rtsp_url"] = rtsp_url
    state["prompt"] = prompt
    state["model"] = model
    state["frame_interval"] = frame_interval
    state["structured_output"] = structured_output
    state["last_error"] = None
    state["status"] = "starting"
    state["status_text"] = "Starting analysis..."
    state["running"] = True
    state["latest_structured"] = None

    add_log(f"Start analysis requested. Model={model}, interval={frame_interval}s, structured={structured_output}")

    worker.start(
        WorkerConfig(
            rtsp_url=rtsp_url,
            prompt=prompt,
            model=model,
            frame_interval=frame_interval,
            structured_output=structured_output,
        )
    )

    await broadcast({
        "type": "status",
        "status": state["status"],
        "status_text": state["status_text"],
        "running": state["running"],
    })

    return {"ok": True}


@app.post("/api/stop")
async def stop_analysis():
    worker.stop()
    state["running"] = False
    state["status"] = "stopped"
    state["status_text"] = "Analysis stopped."
    add_log("Stop analysis requested.")

    await broadcast({
        "type": "status",
        "status": state["status"],
        "status_text": state["status_text"],
        "running": state["running"],
    })

    return {"ok": True}


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    await websocket.send_json({
        "type": "state",
        **state,
        "logs": list(logs),
    })

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        connected_clients.discard(websocket)


async def metrics_loop():
    psutil.cpu_percent(interval=None)
    while True:
        state["cpu_percent"] = psutil.cpu_percent(interval=None)
        state["ram_percent"] = psutil.virtual_memory().percent

        await broadcast({
            "type": "metrics",
            "cpu_percent": state["cpu_percent"],
            "ram_percent": state["ram_percent"],
            "timestamp": iso_now(),
        })
        await asyncio.sleep(2)



@app.get("/api/video_feed")
async def video_feed():
    with frame_lock:
        has_frame = latest_frame is not None

    if not has_frame:
        return JSONResponse(
            {"ok": False, "error": "No video frame available yet. Start RTSP analysis first."},
            status_code=503,
        )

    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


def mjpeg_generator():
    while True:
        with frame_lock:
            frame = latest_frame

        if frame is not None:
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            )

        time.sleep(0.08)

