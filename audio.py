import io
import re
import wave
from collections import deque
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280  # 80 ms
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
SILENCE_SECONDS = 0.8
MAX_COMMAND_SECONDS = 8.0
START_TIMEOUT = 1.5
# The microphone is closed while Prometheus speaks. These frames are dropped after
# it reopens so the tail of its own voice is never heard as a command.
SETTLE_FRAMES = 4
MIN_UTTERANCE_SECONDS = 0.3
MAX_WAKE_UTTERANCE_SECONDS = 10.0

WAKE_NAME = "prometheus"
# A small offline model checks each stretch of speech for the name. The prompt
# makes it spell the name correctly. Nothing is sent anywhere while it listens.
WAKE_MODEL = "tiny.en"
WAKE_PROMPT = "Prometheus. Hey Prometheus."
MODELS_DIR = Path(__file__).resolve().parent / "models"

_NAME_VARIANTS = {
    "promethius", "promethious", "prometheous", "prometheas", "promethus",
    "prometeus", "promiseus", "promisus", "prometheusa",
}
_FILLER = {"hey", "hay", "hi", "okay", "ok", "yo"}


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


def _name_score(joined: str, words: int) -> float:
    """How close these words, run together, are to the name. 0 when not close enough."""
    joined = joined.replace("'", "")
    if joined in _NAME_VARIANTS:
        return 1.0
    ratio = SequenceMatcher(None, joined, WAKE_NAME).ratio()
    # One word may be a loose mishearing. A name split across words must be tighter,
    # otherwise "promote the" would count.
    if words == 1 and len(joined) >= 7 and ratio >= 0.75:
        return ratio
    if words >= 2 and len(joined) >= 8 and ratio >= 0.85:
        return ratio
    return 0.0


def find_name(text: str):
    """The (start, end) text span of 'Prometheus' (and a leading 'hey'), or None."""
    tokens = [(m.group().lower(), m.start(), m.end()) for m in re.finditer(r"[A-Za-z']+", text)]
    # Compare every stretch of 1 to 4 words and keep the closest one, so a stray word
    # before the name ("it Prometheus") never wins over the name on its own.
    best = None  # (score, -words, index)
    for i in range(len(tokens)):
        for n in range(1, 5):
            if i + n > len(tokens):
                break
            joined = "".join(token[0] for token in tokens[i:i + n])
            score = _name_score(joined, n)
            if score > 0 and (best is None or (score, -n) > (best[0], best[1])):
                best = (score, -n, i)
    if best is None:
        return None
    _, neg_n, i = best
    n = -neg_n
    start = tokens[i][1]
    if i > 0 and tokens[i - 1][0] in _FILLER:
        start = tokens[i - 1][1]
    return start, tokens[i + n - 1][2]


def _load_whisper():
    from faster_whisper import WhisperModel

    MODELS_DIR.mkdir(exist_ok=True)
    return WhisperModel(
        WAKE_MODEL,
        device="cpu",
        compute_type="int8",
        cpu_threads=2,
        download_root=str(MODELS_DIR),
    )


class Listener:
    """Always-on listener. Speech stays on the Mac until 'Prometheus' is heard."""

    def __init__(self):
        self.whisper = _load_whisper()
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

    def _threshold(self) -> float:
        # Stay above the room noise measured while nobody is speaking.
        return max(self._noise + 150.0, self._noise * 1.8)

    def _local_text(self, pcm: bytes) -> str:
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = self.whisper.transcribe(
            audio,
            language="en",
            beam_size=1,
            initial_prompt=WAKE_PROMPT,
            condition_on_previous_text=False,
            vad_filter=True,
            no_speech_threshold=0.6,
        )
        return " ".join(segment.text for segment in segments).strip()

    def capture_command(self):
        """Block until someone says the name. Returns (wav, local_text) for that speech.

        The whole stretch of speech is kept, so 'Prometheus, open YouTube' said in one
        breath arrives together. The caller confirms the name with a second opinion.
        """
        quiet = deque(maxlen=60)
        recent = deque(maxlen=4)
        frames = []
        speaking = False
        loud_run = 0
        silence = 0.0
        with self._stream() as stream:
            while True:
                frame = self._read(stream)
                loud = rms(frame) >= self._threshold()
                if not speaking:
                    recent.append(frame)
                    if loud:
                        loud_run += 1
                        if loud_run >= 2:
                            speaking = True
                            frames = list(recent)
                            silence = 0.0
                    else:
                        loud_run = 0
                        quiet.append(rms(frame))
                        self._noise = max(80.0, float(np.median(quiet)))
                    continue
                frames.append(frame)
                silence = 0.0 if loud else silence + FRAME_SECONDS
                too_long = len(frames) * FRAME_SECONDS >= MAX_WAKE_UTTERANCE_SECONDS
                if silence < SILENCE_SECONDS and not too_long:
                    continue
                keep = frames[: max(1, len(frames) - int(silence / FRAME_SECONDS) + 2)]
                speaking = False
                frames = []
                loud_run = 0
                recent.clear()
                if len(keep) * FRAME_SECONDS < MIN_UTTERANCE_SECONDS:
                    continue
                pcm = np.concatenate(keep).astype(np.int16).tobytes()
                text = self._local_text(pcm)
                if find_name(text):
                    return pcm_to_wav(pcm), text

    def record_utterance(
        self,
        max_seconds: float = MAX_COMMAND_SECONDS,
        silence_seconds: float = SILENCE_SECONDS,
        start_timeout: float = START_TIMEOUT,
    ) -> bytes:
        """Wait up to start_timeout for speech, then record until it ends. Empty if none."""
        with self._stream() as stream:
            for _ in range(SETTLE_FRAMES):
                self._read(stream)
            return self._record(stream, max_seconds, silence_seconds, start_timeout)

    def _record(
        self,
        stream,
        max_seconds: float,
        silence_seconds: float,
        start_timeout: float,
    ) -> bytes:
        threshold = self._threshold()
        recent = deque(maxlen=2)
        frames = []
        started = False
        loud_run = 0
        waited = 0.0
        spoken = 0.0
        silence = 0.0
        while True:
            frame = self._read(stream)
            loud = rms(frame) >= threshold
            if not started:
                recent.append(frame)
                loud_run = loud_run + 1 if loud else 0
                if loud_run >= 2:
                    started = True
                    frames = list(recent)
                    continue
                waited += FRAME_SECONDS
                if waited >= start_timeout:
                    return b""
                continue
            frames.append(frame)
            spoken += FRAME_SECONDS
            if loud:
                silence = 0.0
            else:
                silence += FRAME_SECONDS
            if silence >= silence_seconds:
                drop = int(silence_seconds / FRAME_SECONDS) - 2
                if 0 < drop < len(frames):
                    frames = frames[:-drop]
                break
            if spoken >= max_seconds:
                break
        pcm = np.concatenate(frames).astype(np.int16).tobytes()
        return pcm_to_wav(pcm)
