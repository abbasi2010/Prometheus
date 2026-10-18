import os
import re
import sys
import time
from difflib import SequenceMatcher

import brain
from audio import Listener, find_name
from brain import send, transcribe
from tts import chime, say

# After each reply, keep listening this long without needing the wake word.
FOLLOW_UP_SECONDS = 30
ANSWER_WAIT_SECONDS = 5

_STANDALONE_YES = re.compile(
    r"^(?:yes|yeah|yep|yup|sure|ok|okay|correct|confirm|confirmed|do it|go ahead|send it|"
    r"yes send it|yes do it|yes please|yeah send it|yeah do it)$"
)

_last_spoken = ""


def is_standalone_yes(text: str) -> bool:
    """Only a yes on its own counts, so a longer sentence that happens to contain "yes" never confirms."""
    return bool(_STANDALONE_YES.match(_norm(text)))


def strip_wake_name(text: str) -> str:
    """The text with 'Prometheus' (and a leading 'hey') taken out."""
    text = (text or "").strip()
    span = find_name(text)
    if span is None:
        return text
    before = text[: span[0]].strip(" ,.!?:;-")
    after = text[span[1]:].strip(" ,.!?:;-")
    return f"{before} {after}".strip()


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (text or "").lower()).strip()


def speak(text: str) -> None:
    """Speak and remember it, so the follow-up listener can tell its own voice."""
    global _last_spoken
    _last_spoken = text
    say(text)


def is_echo(heard: str) -> bool:
    """True when what was 'heard' is just Prometheus's own last sentence."""
    a, b = _norm(heard), _norm(_last_spoken)
    if not a or not b:
        return False
    if len(a.split()) >= 2 and (a in b or b in a):
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.75


class VoiceConsole:
    """Short spoken questions. The microphone opens only after the question is spoken."""

    def __init__(self, listener: Listener):
        self.listener = listener

    def ask(self, question: str) -> str:
        print(f"\n{question}")
        speak(question)
        heard = transcribe(self.listener.record_utterance(start_timeout=ANSWER_WAIT_SECONDS))
        print(f"> {heard or '(no answer)'}")
        return heard.strip() or "(no answer)"

    def confirm(self, question: str) -> bool:
        # say() returns only after the question is fully spoken, and the
        # microphone opens after that, dropping its first frames.
        print(f"\n{question} (say yes or no)")
        speak(question)
        heard = transcribe(
            self.listener.record_utterance(max_seconds=4, silence_seconds=0.7, start_timeout=ANSWER_WAIT_SECONDS)
        )
        print(f"> {heard or '(silence)'}")
        return is_standalone_yes(heard)


def converse(text: str, voice: VoiceConsole, follow_up: bool = False) -> None:
    """Send one request to the brain and speak the short reply."""
    reply = send(text, io=voice, follow_up=follow_up)
    if reply:
        print(f"Prometheus: {reply}")
        speak(reply)
    elif brain.model_problem:
        speak(brain.model_problem)


def wake_command(listener: Listener):
    """Wait for the name. Returns the command (may be '') or None for a false alarm."""
    wav, local = listener.capture_command()
    heard = transcribe(wav)
    if not heard and brain.model_problem:
        heard = local  # Gemini is unavailable, so use the on-device transcript
    if find_name(heard) is None:
        return None
    command = strip_wake_name(heard)
    if command:
        return command
    chime()
    return strip_wake_name(transcribe(listener.record_utterance(start_timeout=ANSWER_WAIT_SECONDS)))


def follow_up(listener: Listener, voice: VoiceConsole) -> None:
    """Keep taking commands without the wake word until FOLLOW_UP_SECONDS pass in silence."""
    deadline = time.monotonic() + FOLLOW_UP_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        wav = listener.record_utterance(start_timeout=remaining)
        if not wav:
            return
        heard = transcribe(wav)
        if not heard:
            if brain.model_problem:
                speak(brain.model_problem)
                return
            continue
        if is_echo(heard):
            continue
        text = strip_wake_name(heard)
        if not text:
            continue
        print(f"\n> {text}")
        converse(text, voice, follow_up=True)
        deadline = time.monotonic() + FOLLOW_UP_SECONDS


def main():
    if not os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
        sys.exit(
            "Set GEMINI_API_KEY in .env. A free key is at https://aistudio.google.com/apikey"
        )
    print("Loading...")
    listener = Listener()
    voice = VoiceConsole(listener)
    brain.prepare_memory()
    print("Listening for 'Prometheus'. Ctrl+C to stop.")
    while True:
        try:
            command = wake_command(listener)
            if command is None:
                continue
            if not command:
                speak("I didn't catch that.")
                continue
            print(f"\n> {command}")
            converse(command, voice)
            follow_up(listener, voice)
        except KeyboardInterrupt:
            print("\nStopped.")
            return


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
