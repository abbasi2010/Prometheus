# test_gemini.py
import re
import subprocess
from google import genai
from google.genai import errors, types

client = genai.Client()
# First model is preferred. Later ones are used when a model returns a demand error.
MODELS = [
    "gemini-3.8-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]

_QUESTION = re.compile(
    r"^(which|what|where|who|why|how|do|does|did|is|are|should|can|could)\b",
    re.IGNORECASE,
)

def ask_user(question: str) -> str:
    """Ask the user a clarification and return their reply. Use this when the request is ambiguous. Do not use the shell or AppleScript to ask questions."""
    return input(f"\n{question}\n> ").strip() or "(no answer)"

def _is_question(text: str) -> bool:
    s = text.strip()
    if "?" in s:
        return True
    # `which brightness` is the model asking, not a command the user requested.
    return bool(_QUESTION.match(s)) and not re.search(r"[|&;<>`$(){}]", s)

def _run(cmd, shown):
    if _is_question(shown):
        return ask_user(shown)
    if input(f"\n{shown}\nAllow? [y/N] ").lower() != "y":
        return "User denied this action."
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return (r.stdout + r.stderr).strip() or "OK"

def run_applescript(script: str) -> str:
    """Run AppleScript on macOS. For controlling apps (Safari, Finder, Notes, Music) and system settings like volume."""
    return _run(["osascript", "-e", script], script)

def run_shell(command: str) -> str:
    """Run a zsh command. For files, `open -a`, and system info. Do not use this to ask the user a question."""
    return _run(["zsh", "-c", command], command)

CONFIG = types.GenerateContentConfig(
    tools=[ask_user, run_applescript, run_shell],
    system_instruction=(
        "You control a Mac. If the request is ambiguous, call ask_user and wait for the reply "
        "before any other tool. Never use run_shell or run_applescript to ask questions or to "
        "search for a command. When you know the command, run one short one, check the result, "
        "then reply in a sentence."
    ),
)

def _open_chat(model, history=None):
    return client.chats.create(model=model, config=CONFIG, history=history or [])

def _switch_reason(exc):
    """Why this model should be skipped, or None if the error should surface."""
    status = (getattr(exc, "status", None) or "").upper()
    if getattr(exc, "code", None) in (429, 503) or status in {
        "UNAVAILABLE",
        "RESOURCE_EXHAUSTED",
    }:
        return "busy"
    if getattr(exc, "code", None) == 404 or status == "NOT_FOUND":
        return "missing"
    return None

model_i = 0
chat = _open_chat(MODELS[model_i])

def send(message):
    """Send one turn, moving to the next model when the current one is busy."""
    global chat, model_i
    saw_demand = False
    for attempt in range(len(MODELS)):
        before = len(chat.get_history())
        try:
            return chat.send_message(message)
        except errors.APIError as exc:
            reason = _switch_reason(exc)
            if reason is None:
                raise
            saw_demand = saw_demand or reason == "busy"
            # A tool may already have run. Resending would run it again.
            if len(chat.get_history()) != before:
                print("\nThe model got busy after it had already started. Try that request again.")
                return None
            failed = MODELS[model_i]
            if attempt == len(MODELS) - 1:
                break
            model_i = (model_i + 1) % len(MODELS)
            why = "is busy" if reason == "busy" else "is unavailable"
            print(f"\n{failed} {why}, trying {MODELS[model_i]}.")
            chat = _open_chat(MODELS[model_i], chat.get_history(curated=True))
    model_i = 0
    chat = _open_chat(MODELS[model_i], chat.get_history(curated=True))
    if saw_demand:
        print("\nEvery model is busy right now. Try again in a moment.")
    else:
        print("\nNo model is available right now. Try again in a moment.")
    return None

while True:
    reply = send(input("\n> "))
    if reply is not None:
        print(reply.text)
