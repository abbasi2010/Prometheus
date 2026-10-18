"""Persistent memory: what was discussed and which actions were asked for.

Stored in memory.json next to this file. It is bounded: the newest MAX_ENTRIES
entries are kept in full, and anything older is folded into a short summary.
Secrets are removed before anything is written.
"""
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

MEMORY_FILE = Path(__file__).resolve().parent / "memory.json"
MAX_ENTRIES = 60
CONTEXT_ENTRIES = 30
MAX_PENDING = 200
MAX_SUMMARY_CHARS = 1500

_SECRET_PATTERNS = [
    re.compile(r"AIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"),
    re.compile(
        r"\b(?:password|passcode|pass\s?phrase|passphrase|pin|code|secret|token|api[\s_-]?key|key)"
        r"\s*(?:is|was|are|=|:)\s*[^.!?\n]*",
        re.IGNORECASE,
    ),
]

_data = None


def _empty():
    return {"summary": "", "pending": [], "entries": []}


def redact(text) -> str:
    """Replace anything that looks like a key, token, or password."""
    text = str(text or "")
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name)
        if value and len(value) > 8:
            text = text.replace(value, "[hidden]")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[hidden]", text)
    return text


def _load():
    global _data
    if _data is None:
        try:
            loaded = json.loads(MEMORY_FILE.read_text())
            _data = _empty()
            _data["summary"] = str(loaded.get("summary", ""))
            _data["pending"] = [str(item) for item in loaded.get("pending", [])]
            _data["entries"] = [e for e in loaded.get("entries", []) if isinstance(e, dict)]
        except (OSError, ValueError, AttributeError):
            _data = _empty()
    return _data


def _save():
    data = _load()
    fd, tmp = tempfile.mkstemp(dir=str(MEMORY_FILE.parent), prefix=".memory-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, MEMORY_FILE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _line(entry) -> str:
    what = "; ".join(entry.get("actions") or []) or entry.get("reply", "")
    return f'{entry.get("t", "")}: user said "{entry.get("user", "")}" -> {what}'


def add(user, reply, actions) -> None:
    """Remember one exchange."""
    user = redact(user).strip()
    if not user:
        return
    data = _load()
    data["entries"].append({
        "t": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "user": user[:300],
        "reply": redact(reply).strip()[:200],
        "actions": [redact(a).strip()[:120] for a in (actions or []) if str(a).strip()][:5],
    })
    while len(data["entries"]) > MAX_ENTRIES:
        data["pending"].append(_line(data["entries"].pop(0)))
    data["pending"] = data["pending"][-MAX_PENDING:]
    _save()


def compact(summarize) -> None:
    """Fold entries that fell out of the window into the summary. Runs at startup.

    summarize(text) returns a short summary, or None if it can't. Without one the
    old lines are simply appended and the summary is trimmed to its newest part.
    """
    data = _load()
    if not data["pending"]:
        return
    older = "\n".join(data["pending"])
    prompt = (
        "Summary so far:\n" + (data["summary"] or "(none)") +
        "\n\nNewer older-sessions lines to add:\n" + older
    )
    merged = None
    try:
        merged = summarize(prompt)
    except Exception:
        merged = None
    if merged:
        data["summary"] = redact(merged).strip()[:MAX_SUMMARY_CHARS]
    else:
        data["summary"] = redact((data["summary"] + "\n" + older).strip())[-MAX_SUMMARY_CHARS:]
    data["pending"] = []
    _save()


def context() -> str:
    """Text added to the model's instructions so it can recall earlier sessions."""
    data = _load()
    lines = []
    if data["summary"]:
        lines.append("Summary of older conversations: " + data["summary"])
    recent = data["entries"][-CONTEXT_ENTRIES:]
    if recent:
        lines.append("Recent requests, oldest first:")
        lines.extend("- " + _line(entry) for entry in recent)
    if not lines:
        return ""
    return "Your memory of past conversations with the user:\n" + "\n".join(lines)


def clear() -> None:
    """Forget everything."""
    global _data
    _data = _empty()
    _save()
