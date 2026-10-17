import io
import wave

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280  # 80 ms, the chunk openWakeWord expects
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
WAKE_THRESHOLD = 0.5
WAKE_HITS = 2
SILENCE_SECONDS = 0.8
MAX_COMMAND_SECONDS = 8.0
START_TIMEOUT = 1.5


def pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


def rms(frame: np.ndarray) -> float:
    audio = frame.astype(np.float32)
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio * audio)))


def _wake_score(scores: dict) -> float:
    best = 0.0
    for key, value in scores.items():
        if "jarvis" in str(key).lower():
            best = max(best, float(value))
    return best


def _dbg(hypothesis_id, message, data):
    # #region agent log
    import json
    import time
    try:
        with open("/Users/ibrahimabbasi/Documents/Dev/voice/.cursor/debug-b1d764.log", "a") as handle:
            handle.write(json.dumps({
                "sessionId": "b1d764",
                "hypothesisId": hypothesis_id,
                "location": "audio.py:_load_model",
                "message": message,
                "data": data,
                "timestamp": int(time.time() * 1000),
            }) + "\n")
    except Exception:
        pass
    # #endregion


def _load_model():
    import os
    import openwakeword
    from openwakeword.model import Model

    requested = "hey_jarvis"
    official = list(openwakeword.MODELS)
    model_dir = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    # #region agent log
    _dbg("A", "official models before download", {"requested": requested, "official": official, "modelDir": model_dir})
    # #endregion
    try:
        openwakeword.utils.download_models(model_names=[requested])
        download_error = None
    except Exception as exc:
        download_error = f"{type(exc).__name__}: {exc}"
    files = sorted(os.listdir(model_dir)) if os.path.isdir(model_dir) else []
    paths = openwakeword.get_pretrained_model_paths("onnx")
    matches = [path for path in paths if requested in os.path.basename(path)]
    # #region agent log
    _dbg("A", "download result", {"downloadError": download_error, "files": files, "matchedUrls": requested in " ".join(official)})
    _dbg("B", "pretrained lookup", {"query": "hey jarvis", "paths": paths, "matches": matches})
    _dbg("D", "model directory contents", {"jarvisFiles": [name for name in files if "jarvis" in name.lower()]})
    # #endregion
    model = Model(wakeword_models=["hey jarvis"], inference_framework="onnx")
    # #region agent log
    _dbg("B", "model loaded", {"models": list(getattr(model, "models", {}))})
    # #endregion
    return model


class Listener:
    """Local wake-word listener. Audio leaves the Mac only after 'hey jarvis'."""

    def __init__(self):
        self.model = _load_model()
        self._noise = 120.0

    def _stream(self):
        import sounddevice as sd

        return sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
        )

    def _read(self, stream) -> np.ndarray:
        data, _ = stream.read(FRAME_SAMPLES)
        frame = np.ascontiguousarray(np.squeeze(data), dtype=np.int16)
        if frame.size < FRAME_SAMPLES:
            frame = np.pad(frame, (0, FRAME_SAMPLES - frame.size))
        return frame[:FRAME_SAMPLES]

    def _arm(self):
        if hasattr(self.model, "reset"):
            self.model.reset()
            return
        silence = np.zeros(FRAME_SAMPLES, dtype=np.int16)
        for _ in range(12):
            self.model.predict(silence)

    def capture_command(self) -> bytes:
        """Block until the wake phrase, then record the command that follows."""
        self._arm()
        hits = 0
        quiet = []
        with self._stream() as stream:
            while True:
                frame = self._read(stream)
                scores = self.model.predict(frame)
                score = _wake_score(scores)
                if score >= WAKE_THRESHOLD:
                    hits += 1
                    if hits >= WAKE_HITS:
                        if quiet:
                            self._noise = max(80.0, float(np.median(quiet)))
                        return self._record(stream)
                else:
                    hits = 0
                    if score < 0.1:
                        quiet.append(rms(frame))
                        if len(quiet) > 40:
                            quiet.pop(0)

    def record_utterance(
        self,
        max_seconds: float = 4.0,
        silence_seconds: float = 0.7,
        start_timeout: float = 2.5,
    ) -> bytes:
        """Record one reply, used for yes/no and clarifying answers."""
        with self._stream() as stream:
            return self._record(stream, max_seconds, silence_seconds, start_timeout)

    def _record(
        self,
        stream,
        max_seconds: float = MAX_COMMAND_SECONDS,
        silence_seconds: float = SILENCE_SECONDS,
        start_timeout: float = START_TIMEOUT,
    ) -> bytes:
        # Stay above the room noise measured while waiting for the wake phrase.
        threshold = max(self._noise + 150.0, self._noise * 1.8)
        frames = []
        started = False
        silence = 0.0
        elapsed = 0.0
        while elapsed < max_seconds:
            frame = self._read(stream)
            elapsed += FRAME_SECONDS
            loud = rms(frame) >= threshold
            if not started:
                if loud:
                    started = True
                    frames.append(frame)
                elif elapsed >= start_timeout:
                    break
                continue
            frames.append(frame)
            if loud:
                silence = 0.0
            else:
                silence += FRAME_SECONDS
                if silence >= silence_seconds:
                    drop = int(silence_seconds / FRAME_SECONDS)
                    if 0 < drop < len(frames):
                        frames = frames[:-drop]
                    break
        if not frames:
            return b""
        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        return pcm_to_wav(pcm)
