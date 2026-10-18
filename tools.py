import os
import re
import shlex
import subprocess
from contextvars import ContextVar

import memory

_QUESTION = re.compile(
    r"^(what|where|who|why|how|does|is|are|should|can|could)\b",
    re.IGNORECASE,
)
_PROBE = re.compile(
    r"^(which|type|whereis|man|apropos|whatis|command\s+-v)\b",
    re.IGNORECASE,
)
_TALK = re.compile(r"^\s*(echo|printf|say)\b", re.IGNORECASE)
_RETURN_TEXT = re.compile(r'^\s*return\s+"[^"]*"\s*$', re.IGNORECASE)
_NOT_AN_ACTION = (
    "That is not an action. Do not use commands to ask questions or to talk. "
    "Do the task with one command, answer in plain text, or call ask_user."
)

console: ContextVar = ContextVar("console", default=None)


class TextConsole:
    """Typed confirm and clarify, used when the agent is run from the keyboard."""

    def ask(self, question: str) -> str:
        return input(f"\n{question}\n> ").strip() or "(no answer)"

    def confirm(self, question: str) -> bool:
        return input(f"\n{question} [y/N] ").strip().lower() in ("y", "yes")


def _console():
    io = console.get()
    return io if io is not None else TextConsole()


def ask_user(question: str) -> str:
    """Ask the user a short spoken question when a detail you need is missing and cannot be guessed. Never use it to chat or to check in."""
    return _console().ask(question)


# --- Confirmation policy ----------------------------------------------------
# Everything runs straight away (opening apps and pages, searching, clicking,
# volume, brightness, media) EXCEPT actions that match the patterns below.
# Messages and email are never sent from free-form commands; send_message is
# the only way to send, and it always reads the message back first.

_SEND_BLOCK = [
    re.compile(
        r'tell\s+application\s+(?:id\s+)?"(?:Messages|Mail|Microsoft Outlook|Outlook|Spark|Airmail|WhatsApp|'
        r'Signal|Telegram|Slack|Discord|com\.apple\.MobileSMS|com\.apple\.mail)"[\s\S]*?\bsend\b',
        re.IGNORECASE,
    ),
    re.compile(r"\bmake\s+new\s+outgoing\s+message\b", re.IGNORECASE),
    re.compile(r"(?:^|[\s;&|(`'\"])(?:mail|mailx|sendmail|msmtp|mutt)(?=[\s;&|)'\"]|$)", re.IGNORECASE),
]
_SEND_BLOCKED = (
    "failed: messages and email can't be sent with commands. "
    "Use send_message for text messages. There is no way to send email."
)
_SHELL_DANGER = re.compile(
    r"(?:^|[\s;&|(`'\"])"
    r"(?:sudo|rm|rmdir|unlink|shred|srm|mv|trash|dd|mkfs|truncate|"
    r"shutdown|reboot|halt|poweroff|kill|killall|pkill|diskutil|launchctl)"
    r"(?=[\s;&|)'\"]|$)",
    re.IGNORECASE,
)
_SHELL_EXTRA = [
    re.compile(r"\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b", re.IGNORECASE),
    re.compile(r"\s-delete\b", re.IGNORECASE),
    re.compile(r"\bsed\b[^|;&]*\s-i", re.IGNORECASE),
    re.compile(r"\bgit\s+push\b", re.IGNORECASE),
    re.compile(
        r"\bcurl\b.*\s(?:-X\s*(?:POST|PUT|DELETE|PATCH)|-d\b|--data|-F\b|--form|-T\b|--upload-file)",
        re.IGNORECASE,
    ),
]
_SCRIPT_DANGER = [
    re.compile(r"\bquit\b", re.IGNORECASE),
    re.compile(r"\bdelete\b", re.IGNORECASE),
    re.compile(r"\bempty\s+(?:the\s+)?trash\b", re.IGNORECASE),
    re.compile(r"\bmove\b[^\n]*\btrash\b", re.IGNORECASE),
    re.compile(r"\bsend\b", re.IGNORECASE),
    re.compile(r"\b(?:restart|shut\s*down|log\s*out)\b", re.IGNORECASE),
    re.compile(r"with\s+administrator\s+privileges", re.IGNORECASE),
    re.compile(r"\b(?:buy|purchase|checkout|check\s*out|place[\s_-]*order|pay\s+now)\b", re.IGNORECASE),
    # Cmd+Q
    re.compile(r"(?:keystroke\s+\"q\"|key\s+code\s+12)\s+using\s+\{?[^}\n]*command down", re.IGNORECASE),
]
_JS_DANGER = re.compile(
    r"\b(?:send|submit|post|buy|purchase|checkout|check\s*out|place[\s_-]*order|"
    r"subscribe|unsubscribe|pay|delete)\b",
    re.IGNORECASE,
)


def _copy_overwrites(cmd: str) -> bool:
    """True when a cp command would replace something that already exists."""
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return True
    for i, token in enumerate(tokens):
        if os.path.basename(token) != "cp":
            continue
        args = []
        for item in tokens[i + 1:]:
            if item in (";", "&&", "||", "|"):
                break
            if not item.startswith("-"):
                args.append(item)
        if len(args) < 2:
            return False
        dest = os.path.expanduser(args[-1])
        if os.path.isdir(dest):
            return any(
                os.path.exists(os.path.join(dest, os.path.basename(src.rstrip("/"))))
                for src in args[:-1]
            )
        return os.path.exists(dest)
    return False


def _has_redirect(cmd: str) -> bool:
    quoted = re.sub(r"\"(?:\\.|[^\"\\])*\"|'[^']*'", '""', cmd)
    harmless = re.sub(r"\d*>+&\d+|&?\d*>>?\s*/dev/null", "", quoted)
    return ">" in harmless


def _shell_danger(cmd: str) -> bool:
    return (
        bool(_SHELL_DANGER.search(cmd))
        or any(p.search(cmd) for p in _SHELL_EXTRA)
        or _has_redirect(cmd)
        or _copy_overwrites(cmd)
    )


def _script_danger(script: str) -> bool:
    if any(p.search(script) for p in _SCRIPT_DANGER):
        return True
    lowered = script.lower()
    if "do javascript" in lowered and _JS_DANGER.search(script):
        return True
    if "do shell script" in lowered and _shell_danger(script):
        return True
    return False


def sends_message(text: str) -> bool:
    """A command that would send a message or email."""
    return any(p.search(text) for p in _SEND_BLOCK)


def needs_confirmation(kind: str, text: str) -> bool:
    """Destructive or outward-facing: quitting, deleting or overwriting, restarting, buying."""
    if kind == "applescript":
        return _script_danger(text)
    if _shell_danger(text):
        return True
    return "osascript" in text.lower() and _script_danger(text)


def _needs_user(kind: str, text: str) -> bool:
    """A command used to ask a question or to talk, rather than to act."""
    s = text.strip()
    if kind == "applescript" and _RETURN_TEXT.match(s):
        return True
    if re.search(r"[|&;<>`$(){}]", s):
        return False
    if kind == "shell" and _TALK.match(s):
        return True
    return bool(_QUESTION.match(s) or _PROBE.match(s))


# --- Brightness ---------------------------------------------------------------

def _brightness_fraction(text: str):
    """The model asks for `brightness 1` to mean 100%, and `brightness 40` to mean 40%."""
    match = re.fullmatch(r"brightness\s+(\d+(?:\.\d+)?)", text, flags=re.IGNORECASE)
    if not match:
        return None
    value = float(match.group(1))
    if 0 <= value <= 1:
        return value
    if 1 < value <= 100:
        return value / 100
    return None


def _apply_brightness(level: float) -> str:
    import ctypes

    level = max(0.0, min(1.0, float(level)))
    core_graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
    display_services = ctypes.CDLL("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices")
    core_graphics.CGMainDisplayID.restype = ctypes.c_uint32
    display_services.DisplayServicesSetBrightness.argtypes = [ctypes.c_uint32, ctypes.c_float]
    display_services.DisplayServicesSetBrightness.restype = ctypes.c_int
    code = display_services.DisplayServicesSetBrightness(core_graphics.CGMainDisplayID(), level)
    if code != 0:
        return "failed: couldn't change the brightness"
    return "done"


def set_brightness(percent: int, reply: str) -> str:
    """Set the main screen brightness. percent is a number from 0 to 100. Use this for every brightness request instead of a shell command.

    reply is the short phrase spoken when done, such as "Brightness set." """
    try:
        value = float(str(percent).strip().rstrip("%"))
    except (TypeError, ValueError):
        return "failed: brightness must be a number from 0 to 100"
    if not 0 <= value <= 100:
        return "failed: brightness must be a number from 0 to 100"
    return _apply_brightness(value / 100)


# --- Running commands (show mode only) -----------------------------------------------

def _question_for(summary: str) -> str:
    summary = (summary or "").strip().rstrip("?.! ")
    return f"{summary}?" if summary else "Go ahead with that?"


def _run(kind, cmd, shown, summary=""):
    if _needs_user(kind, shown):
        return _NOT_AN_ACTION
    print(f"\n{shown}")
    if sends_message(shown):
        return _SEND_BLOCKED
    if needs_confirmation(kind, shown) and not _console().confirm(_question_for(summary)):
        return "declined"
    if kind == "shell":
        fraction = _brightness_fraction(" ".join(shown.split()))
        if fraction is not None:
            return _apply_brightness(fraction)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return "failed: it took too long"
    if r.returncode != 0:
        detail = (r.stderr or r.stdout).strip()
        print(detail)
        first = detail.splitlines()[0][:160] if detail else "it did not work"
        return f"failed: {first}"
    return r.stdout.strip()[:500] or "done"


def run_applescript(script: str, reply: str, summary: str = "") -> str:
    """Run AppleScript on macOS to control apps on screen (Finder, Notes, Safari pages, System Settings).

    reply is the short phrase spoken when done, such as "Done." Use an empty string only when you need the script's output back to answer.
    summary is a few plain words describing the action, such as "Quit Notes". Required for quitting, deleting or similar actions."""
    return _run("applescript", ["osascript", "-e", script], script, summary)


def run_shell(command: str, reply: str, summary: str = "") -> str:
    """Run a zsh command. For files, `open -a "App"`, and system info. Do not use this to ask or to talk.

    reply is the short phrase spoken when done, such as "Opening Notes." Use an empty string only when you need the command's output back to answer.
    summary is a few plain words describing the action, such as "Delete report.pdf". Required for deleting, overwriting, quitting, restarting or similar actions."""
    return _run("shell", ["zsh", "-c", command], command, summary)


def open_url(url: str, reply: str, app: str = "safari") -> str:
    """Open a web page on screen, such as Netflix or a news site. For YouTube use the youtube tool.

    url: the full address starting with https://.
    app: "safari" (a new tab, keeping the current one) or "default" (the default browser).
    reply: a few words spoken when done, such as "Here's Netflix." """
    from youtube import open_page

    url = (url or "").strip()
    if not re.match(r"https?://", url):
        url = "https://" + url.lstrip("/")
    print(f"\nOpen {url}")
    try:
        open_page(url, "default" if "default" in (app or "").lower() or "browser" in (app or "").lower() else "safari")
    except Exception as exc:
        print(exc)
        return "failed: the page didn't open"
    return "done"


# --- Memory ----------------------------------------------------------------------------

def clear_memory(reply: str) -> str:
    """Forget everything remembered from past conversations. Only call this when the user asks to forget or clear what you remember.

    reply is the short phrase spoken when done, such as "Done. I've forgotten everything." """
    if not _console().confirm("Forget everything I remember?"):
        return "declined"
    memory.clear()
    return "done"
