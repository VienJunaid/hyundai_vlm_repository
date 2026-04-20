import threading
import time
import cv2

NO_AMR = "no_amr"
AMR_DETECTED = "amr_detected"
SCANNING = "scanning"
ALIGNED = "aligned"
MISALIGNED_ALERT = "misaligned_alert"

DETECTION_INTERVAL = 3.0       # seconds between AMR presence polls (idle state)
AMR_CONFIRM_SECONDS = 5.0      # seconds AMR must be present before scans start
SCAN_INTERVAL = 3.0            # seconds between alignment scans
MISALIGNED_THRESHOLD = 5       # consecutive misaligned scans before alert
DEPART_CHECK_INTERVAL = 6.0    # seconds between departure checks after final state


class PalletStationWorker:
    def __init__(self, station_id: int, ollama_client, on_update, on_log):
        self.station_id = station_id
        self.rtsp_url = None
        self.model = "llama3.2-vision:11b"

        self._state = NO_AMR
        self._scan_count = 0
        self._misaligned_count = 0
        self._explanation = ""
        self._amr_first_seen = None

        self._running = False
        self._thread = None
        self._stop_event = threading.Event()

        self._latest_frame = None
        self._frame_lock = threading.Lock()

        self._inference_running = False
        self._inference_lock = threading.Lock()

        self._ollama = ollama_client
        self._on_update = on_update
        self._on_log = on_log

    @property
    def state(self):
        return self._state

    def configure(self, rtsp_url: str, model: str = None):
        if model:
            self.model = model
        old_url = self.rtsp_url
        self.rtsp_url = rtsp_url

        if not rtsp_url:
            if self._running:
                self.stop()
            self._state = NO_AMR
            self._explanation = ""
            self._emit()
            return

        if rtsp_url != old_url or not self._running:
            if self._running:
                self.stop()
            self.start()

    def start(self):
        if self._running:
            return
        self._stop_event.clear()
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        self._running = False

    def get_latest_frame(self):
        with self._frame_lock:
            return self._latest_frame

    def get_info(self) -> dict:
        return {
            "id": self.station_id,
            "state": self._state,
            "rtsp_url": self.rtsp_url or "",
            "scan_count": self._scan_count,
            "misaligned_count": self._misaligned_count,
            "explanation": self._explanation,
            "streaming": self._state != NO_AMR and bool(self.rtsp_url),
        }

    def _emit(self):
        self._on_update(self.station_id, self.get_info())

    def _set_state(self, new_state: str, explanation: str = ""):
        self._state = new_state
        if explanation is not None:
            self._explanation = explanation
        self._emit()

    @staticmethod
    def _encode(frame, quality: int = 40) -> bytes:
        _, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes()

    @staticmethod
    def _resize(frame, max_w: int = 480):
        h, w = frame.shape[:2]
        if w > max_w:
            scale = max_w / w
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        return frame

    def _dispatch(self, fn, *args):
        with self._inference_lock:
            if self._inference_running:
                return
            self._inference_running = True

        def _run():
            try:
                fn(*args)
            finally:
                with self._inference_lock:
                    self._inference_running = False

        threading.Thread(target=_run, daemon=True).start()

    def _do_presence_check(self, img_bytes: bytes, departure_mode: bool = False):
        label = f"Station {self.station_id + 1}"
        try:
            present = self._ollama.check_amr_presence(self.model, img_bytes)
            if departure_mode:
                if not present:
                    self._on_log(f"{label}: AMR departed — resetting to idle")
                    self._amr_first_seen = None
                    self._scan_count = 0
                    self._misaligned_count = 0
                    self._set_state(NO_AMR, "")
            else:
                if present:
                    self._on_log(f"{label}: AMR detected in docking zone")
                    self._amr_first_seen = time.time()
                    self._scan_count = 0
                    self._misaligned_count = 0
                    self._set_state(AMR_DETECTED, "AMR entered docking zone — confirming presence...")
        except Exception as e:
            self._on_log(f"{label}: Detection error: {e}")

    def _do_alignment_scan(self, img_bytes: bytes):
        label = f"Station {self.station_id + 1}"
        try:
            result = self._ollama.check_pallet_alignment(self.model, img_bytes)
            aligned = result.get("aligned", False)
            explanation = result.get("explanation", "")
            self._scan_count += 1
            verdict = "ALIGNED" if aligned else "MISALIGNED"
            self._on_log(f"{label}: Scan {self._scan_count} — {verdict}: {explanation}")

            if aligned:
                self._set_state(ALIGNED, explanation)
            else:
                self._misaligned_count += 1
                if self._misaligned_count >= MISALIGNED_THRESHOLD:
                    self._set_state(MISALIGNED_ALERT, explanation)
                else:
                    self._explanation = explanation
                    self._emit()
        except Exception as e:
            self._on_log(f"{label}: Alignment scan error: {e}")

    def _run_loop(self):
        label = f"Station {self.station_id + 1}"
        self._on_log(f"{label}: Worker starting — {self.rtsp_url}")

        while not self._stop_event.is_set():
            if not self.rtsp_url:
                time.sleep(1)
                continue

            cap = cv2.VideoCapture(self.rtsp_url)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                self._on_log(f"{label}: Cannot open stream, retrying in 5s...")
                self._set_state(NO_AMR, "Camera unavailable")
                time.sleep(5)
                continue

            self._on_log(f"{label}: Camera connected")
            self._state = NO_AMR
            self._scan_count = 0
            self._misaligned_count = 0
            self._explanation = ""
            self._amr_first_seen = None
            self._emit()

            last_detection = 0.0
            last_scan = 0.0
            last_depart_check = 0.0

            try:
                while not self._stop_event.is_set():
                    ret, frame = cap.read()
                    if not ret:
                        break

                    small = self._resize(frame.copy(), 320)
                    with self._frame_lock:
                        self._latest_frame = self._encode(small, 25)

                    now = time.time()

                    if self._state == NO_AMR:
                        if now - last_detection >= DETECTION_INTERVAL:
                            last_detection = now
                            img = self._encode(self._resize(frame.copy(), 640), 80)
                            self._dispatch(self._do_presence_check, img, False)

                    elif self._state == AMR_DETECTED:
                        if self._amr_first_seen and (now - self._amr_first_seen >= AMR_CONFIRM_SECONDS):
                            self._on_log(f"{label}: AMR confirmed — beginning alignment scan sequence")
                            self._set_state(SCANNING, "Verifying alignment...")
                            last_scan = 0.0

                    elif self._state == SCANNING:
                        if now - last_scan >= SCAN_INTERVAL:
                            last_scan = now
                            img = self._encode(self._resize(frame.copy(), 640), 75)
                            self._dispatch(self._do_alignment_scan, img)

                    elif self._state in (ALIGNED, MISALIGNED_ALERT):
                        if now - last_depart_check >= DEPART_CHECK_INTERVAL:
                            last_depart_check = now
                            img = self._encode(self._resize(frame.copy(), 640), 80)
                            self._dispatch(self._do_presence_check, img, True)

                    time.sleep(0.05)

            finally:
                cap.release()
                if not self._stop_event.is_set():
                    self._on_log(f"{label}: Stream lost — reconnecting in 5s...")
                    self._set_state(NO_AMR, "Reconnecting...")
                    time.sleep(5)

        self._running = False
        self._on_log(f"{label}: Worker stopped")
