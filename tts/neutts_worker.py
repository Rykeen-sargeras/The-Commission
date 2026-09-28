"""Persistent JSON-lines worker for local NeuTTS-2E speech generation."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf


PROTOCOL_OUT = sys.stdout
# NeuTTS and its dependencies print model progress to stdout. Keep stdout reserved
# for the JSON protocol consumed by the Node process.
sys.stdout = sys.stderr

_ENGINE = None
MAX_CHARS = 280
SAMPLE_RATE = 24_000


def chunks(text: str) -> list[str]:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return []
    sentences = re.split(r"(?<=[.!?])\s+", text)
    result: list[str] = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > MAX_CHARS:
            words = sentence.split()
            for word in words:
                candidate = f"{current} {word}".strip()
                if current and len(candidate) > MAX_CHARS:
                    result.append(current)
                    current = word
                else:
                    current = candidate
            continue
        candidate = f"{current} {sentence}".strip()
        if current and len(candidate) > MAX_CHARS:
            result.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        result.append(current)
    return result


def engine():
    global _ENGINE
    if _ENGINE is None:
        from neutts import NeuTTS2E

        backbone = os.environ.get("TTS_BACKBONE_REPO", "neuphonic/neutts-2e-q4-gguf")
        codec = os.environ.get(
            "TTS_CODEC_REPO", "neuphonic/neucodec-onnx-decoder-int8"
        )
        print(f"Loading local voice model {backbone}; the first playback can take a few minutes.")
        _ENGINE = NeuTTS2E(
            backbone_repo=backbone,
            backbone_device="cpu",
            codec_repo=codec,
            codec_device="cpu",
            seed=42,
        )
        print("Local NeuTTS-2E voice model is ready.")
    return _ENGINE


def synthesize(text: str, speaker: str, emotion: str) -> str:
    pieces = chunks(text)
    if not pieces:
        raise ValueError("There is no readable text to synthesize.")
    tts = engine()
    audio: list[np.ndarray] = []
    silence = np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32)
    for index, piece in enumerate(pieces):
        if index:
            audio.append(silence)
        audio.append(np.asarray(tts.infer(piece, speaker=speaker, emotion=emotion), dtype=np.float32))
    handle, output_path = tempfile.mkstemp(prefix="commission-neutts-", suffix=".wav")
    os.close(handle)
    sf.write(output_path, np.concatenate(audio), SAMPLE_RATE, subtype="PCM_16")
    return output_path


def respond(payload: dict) -> None:
    PROTOCOL_OUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    PROTOCOL_OUT.flush()


def main() -> None:
    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            if request.get("action") != "synthesize":
                raise ValueError("Unknown NeuTTS worker action.")
            output_path = synthesize(
                request.get("text", ""),
                request.get("speaker", "emily"),
                request.get("emotion", "neutral"),
            )
            respond({"id": request_id, "ok": True, "audioPath": output_path})
        except Exception as error:  # Keep the worker alive for later requests.
            traceback.print_exc(file=sys.stderr)
            respond({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
