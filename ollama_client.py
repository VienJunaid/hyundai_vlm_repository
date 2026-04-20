import base64
import json
import re
from typing import Optional, Tuple

import requests

AMR_PRESENCE_PROMPT = (
    "Look carefully at this factory floor image. "
    "Is there a large blue rectangular platform or vehicle (an AMR — Autonomous Mobile Robot) visible? "
    "The AMR looks like a solid blue box or sled shape, low to the ground, "
    "and may have small yellow square stickers or markers on its top surface. "
    "It is typically positioned in front of a docking bay with grey walls on the sides. "
    "Answer with ONLY the single word YES or NO."
)

PALLET_ALIGNMENT_PROMPT = (
    "You are checking docking alignment between an AMR and its payload in a factory. "
    "In this front-facing camera image, look for two bright yellow square markers: "
    "one yellow square is on the top surface of the blue AMR (the large blue rectangular platform at the bottom), "
    "and one yellow square is on the bottom surface of the payload or docking structure directly above the AMR. "
    "These two yellow squares must line up at the same horizontal left-right position. "
    "If both yellow squares appear directly above each other with no left or right offset, they are ALIGNED. "
    "If one yellow square is shifted left or right compared to the other, they are MISALIGNED. "
    "Answer using ONLY this exact format — no other text: "
    "ALIGNED: <one sentence describing what you see> "
    "or MISALIGNED: <one sentence describing the offset you see>."
)

SYSTEM_ANALYSIS_PROMPT = (
    "You are a factory floor safety monitor analyzing a Hyundai AMR facility. "
    "Respond ONLY with valid JSON and no other text, using this exact format: "
    "{\"amr_count\": 0, \"congestion\": false, \"reason\": \"brief one-sentence explanation\"}. "
    "ABOUT THE AMRs: AMRs are flat blue rectangular sleds or platforms on the floor, "
    "often with a small yellow square marker on top. Count every blue flat platform as one AMR. "
    "Do NOT call them pallets. "
    "ABOUT THE FLOOR MARKINGS: The factory floor has solid lines that mark zone boundaries "
    "and dotted lines that mark the exit boundary of each AMR docking station. "
    "CONGESTION RULE — flag congestion as true in EITHER of these cases: "
    "1) Any AMR that has clearly crossed past the dotted line into the open travel lane "
    "appears stopped or stuck — AMRs in the open travel lane must ALWAYS be moving. "
    "2) Three or more AMRs are visible in the open travel lane (past the dotted line) "
    "and none of them appear to be moving — this is a multi-AMR travel lane blockage. "
    "An AMR that is stationary inside the docking station area (behind or at the dotted line) "
    "is normal docking behavior — do NOT flag that as congestion."
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

    def check_amr_presence(self, model: str, image_bytes: bytes) -> bool:
        """Returns True if a blue AMR robot is visible in the image."""
        text, _ = self.analyze_image(model, AMR_PRESENCE_PROMPT, image_bytes)
        return text.strip().upper().startswith("YES")

    def check_pallet_alignment(self, model: str, image_bytes: bytes) -> dict:
        """Returns {'aligned': bool, 'explanation': str}."""
        text, _ = self.analyze_image(model, PALLET_ALIGNMENT_PROMPT, image_bytes)
        text = text.strip()
        aligned = text.upper().startswith("ALIGNED")
        explanation = text.split(":", 1)[1].strip() if ":" in text else text
        return {"aligned": aligned, "explanation": explanation}

    def health_check(self) -> Optional[dict]:
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=10)
            response.raise_for_status()
            return response.json()
        except Exception:
            return None


