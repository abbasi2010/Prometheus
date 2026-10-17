import os
import re
import sys

from audio import Listener
from tools import _agent_log
import brain
from brain import send, transcribe
from tts import say

_YES = re.compile(
    r"\b(yes|yeah|yep|yup|sure|okay|ok|affirmative|confirm|approved|go ahead|do it)\b",
    re.IGNORECASE,
)
_NO = re.compile(
    r"\b(no|nope|nah|cancel|stop|don't|dont|negative|deny|denied)\b",
    re.IGNORECASE,
)
_WAKE_ONLY = re.compile(r"^(hey[, ]+)?jarvis[.!?, ]*$", re.IGNORECASE)


def is_yes(text: str) -> bool:
    """A clear yes. Silence, 'no', or anything unclear counts as no."""
    if not text or not text.strip():
        return False
    if _NO.search(text):
        return False
    return _YES.search(text) is not None


def command_text(text: str) -> str:
    if _WAKE_ONLY.match(text.strip()):
        return ""
    return re.sub(r"^(hey[, ]+)?jarvis[, ]+", "", text.strip(), count=1, flags=re.IGNORECASE).strip()


class VoiceConsole:
    def __init__(self, listener: Listener):
        self.listener = listener

    def ask(self, question: str) -> str:
        print(f"\n{question}")
        say(question)
        heard = transcribe(self.listener.record_utterance())
        print(f"> {heard or '(no answer)'}")
        # #region agent log
        _agent_log("B", "agent.py:ask", "asked the user", {"question": question[:300], "heard": heard[:300]})
        # #endregion
        return heard.strip() or "(no answer)"

    def confirm(self, shown: str) -> bool:
        print(f"\n{shown}\nAllow? Say yes or no.")
        spoken = shown if len(shown) <= 300 else shown[:300] + ". The rest is in the terminal."
        say(f"{spoken}. Allow?")
        heard = transcribe(self.listener.record_utterance(max_seconds=4, silence_seconds=0.7))
        print(f"> {heard or '(silence)'}")
        allowed = is_yes(heard)
        # #region agent log
        _agent_log("C", "agent.py:confirm", "confirmation prompt", {
            "shown": shown[:300],
            "heard": heard[:300],
            "allowed": allowed,
        })
        # #endregion
        return allowed


def main():
    if not os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
        sys.exit(
            "Set GEMINI_API_KEY in .env. A free key is at https://aistudio.google.com/apikey"
        )
    print("Loading wake word...")
    listener = Listener()
    voice = VoiceConsole(listener)
    print("Listening for 'hey jarvis'. Ctrl+C to stop.")
    while True:
        try:
            wav = listener.capture_command()
        except KeyboardInterrupt:
            print("\nStopped.")
            return
        text = command_text(transcribe(wav))
        print(f"\n> {text or '(silence)'}")
        # #region agent log
        _agent_log("A", "agent.py:main", "heard command", {"text": text[:300], "modelProblem": brain.model_problem})
        # #endregion
        if brain.model_problem and not text:
            say(brain.model_problem)
            continue
        if not text:
            say("I didn't catch that.")
            continue
        try:
            reply = send(text, io=voice)
        except KeyboardInterrupt:
            print("\nStopped.")
            return
        if reply:
            print(reply)
            say(reply)
        elif brain.model_problem:
            say(brain.model_problem)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
