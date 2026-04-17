import base64
import json
import re
from typing import Optional, Tuple

import requests

SYSTEM_ANALYSIS_PROMPT = (
    "You are a factory floor safety monitor. Analyze this image carefully. "
    "Respond ONLY with valid JSON and no other text, using this exact format: "
    "{\"amr_count\": 0, \"congestion\": false, \"reason\": \"brief one-sentence explanation\"}. "
    "Count all AMRs, forklifts, or automated vehicles visible. "
    "Set congestion to true if any vehicles appear blocked, clustered together, or unable to move freely."
)


class OllamaVisionClient:
    def __init__(self, base_url: str = "http://localhost:11434", timeout: int = 120):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def analyze_image(
        self,
        model: str,
        prompt: str,
        image_bytes: bytes,
        structured_output: bool = False,
    ) -> Tuple[str, Optional[dict]]:
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")

        final_prompt = prompt.strip()
        if structured_output:
            final_prompt += (
                "\n\nReturn JSON only with the following keys: "
                "scene_status, amr_count, worker_present, pallet_detected, "
                "blocked_path, hazard_level, summary."
            )

        payload = {
            "model": model,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": final_prompt,
                    "images": [image_b64],
                }
            ],
        }

        response = requests.post(
            f"{self.base_url}/api/chat",
            json=payload,
            timeout=self.timeout,
        )

        if not response.ok:
            raise Exception(f"Ollama error {response.status_code}: {response.text}")

        data = response.json()
        message = data.get("message", {})
        content = (message.get("content") or "").strip()

        if not content:
            return "No response returned from Ollama.", None

        if structured_output:
            try:
                parsed = json.loads(content)
                summary = parsed.get("summary") or json.dumps(parsed, indent=2)
                return summary, parsed
            except Exception:
                return content, None

        return content, None

    def analyze_system_prompt(self, model: str, image_bytes: bytes) -> dict:
        """Runs the hardcoded system analysis prompt and returns a parsed dict."""
        text, _ = self.analyze_image(model, SYSTEM_ANALYSIS_PROMPT, image_bytes)
        try:
            return json.loads(text)
        except Exception:
            pass
        match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except Exception:
                pass
        return {"amr_count": 0, "congestion": False, "reason": text}

    def health_check(self) -> Optional[dict]:
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception:
            return None


