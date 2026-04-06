import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import cv2

from ollama_client import OllamaVisionClient


@dataclass
class WorkerConfig:
    rtsp_url: str
    prompt: str
    model: str
    frame_interval: float = 2.0
    structured_output: bool = False


class RTSPAnalysisWorker:
    def __init__(
        self,
        ollama_client: OllamaVisionClient,
        on_result: Callable[[dict], None],
        on_status: Callable[[dict], None],
        on_error: Callable[[str], None],
        on_log: Callable[[str], None],
    ):
        self.ollama_client = ollama_client
        self.on_result = on_result
        self.on_status = on_status
        self.on_error = on_error
        self.on_log = on_log

        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._running = False
        self._config: Optional[WorkerConfig] = None

    @property
    def running(self) -> bool:
        return self._running

    def start(self, config: WorkerConfig):
        if self._running:
            self.on_log("Existing analysis running. Stopping previous worker.")
            self.stop()
            time.sleep(0.2)

        self._config = config
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._running = True
        self.on_log("Starting RTSP analysis worker.")
        self._thread.start()

    def stop(self):
        self.on_log("Stop requested for RTSP analysis worker.")
        self._stop_event.set()
        self._running = False

    def _run_loop(self):
        assert self._config is not None
        cfg = self._config

        self.on_status({
            "state": "connecting",
            "text": "Connecting to RTSP stream..."
        })
        self.on_log(f"Connecting to RTSP source: {cfg.rtsp_url}")

        cap = cv2.VideoCapture(cfg.rtsp_url)

        if not cap.isOpened():
            self._running = False
            self.on_error("Could not open RTSP stream.")
            self.on_status({
                "state": "error",
                "text": "Failed to open RTSP stream."
            })
            self.on_log("RTSP connection failed.")
            return

        self.on_status({
            "state": "running",
            "text": "RTSP stream connected. Analysis started."
        })
        self.on_log("RTSP stream connected successfully.")

        last_sent_time = 0.0

        try:
            while not self._stop_event.is_set():
                ret, frame = cap.read()

                if not ret or frame is None:
                    self.on_error("Failed to read frame from RTSP stream.")
                    self.on_log("Frame read failed. Retrying.")
                    time.sleep(1.0)
                    continue

                now = time.time()
                if now - last_sent_time < cfg.frame_interval:
                    time.sleep(0.05)
                    continue

                last_sent_time = now
                self.on_log("Sampled frame for analysis.")

                ok, encoded = cv2.imencode(".jpg", frame)
                if not ok:
                    self.on_error("Failed to encode frame to JPEG.")
                    self.on_log("JPEG encoding failed.")
                    continue

                image_bytes = encoded.tobytes()

                try:
                    self.on_log(f"Sending frame to Ollama model: {cfg.model}")
                    summary, structured = self.ollama_client.analyze_image(
                        model=cfg.model,
                        prompt=cfg.prompt,
                        image_bytes=image_bytes,
                        structured_output=cfg.structured_output,
                    )
                    self.on_log("Received inference response from Ollama.")
                    self.on_result({
                        "summary": summary,
                        "structured": structured,
                        "timestamp": time.time(),
                    })
                except Exception as e:
                    self.on_error(f"Ollama inference failed: {str(e)}")
                    self.on_log(f"Ollama inference error: {str(e)}")

        finally:
            cap.release()
            self._running = False
            self.on_status({
                "state": "stopped",
                "text": "Analysis stopped."
            })
            self.on_log("RTSP worker stopped and camera released.")


