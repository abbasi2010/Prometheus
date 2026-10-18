import os
import re
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

from google import genai
from google.genai import errors, types

import background
import memory
import tools
import youtube
from tools import _NOT_AN_ACTION, console

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

# One attempt per model. The default client retries a 503 for about a minute.
_client = None


def _api():
    global _client
    if _client is None:
        if not os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
            raise SystemExit(
                "Set GEMINI_API_KEY in .env. A free key is at https://aistudio.google.com/apikey"
            )
        _client = genai.Client(
            http_options=types.HttpOptions(
                timeout=45000,
                retry_options=types.HttpRetryOptions(attempts=1),
            )
        )
    return _client


# Lite models answer on the free tier. 3.8 Flash is often out of quota, and
# 2.5 Flash is unavailable to new keys, so those are not the starting point.
MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.8-flash",
]

MAX_ROUNDS = 3
MAX_HISTORY = 40

# Background requests only ever see these. None of them can bring an app forward.
BACKGROUND_TOOLS = [
    background.calendar, background.send_message, background.web_answer, background.set_volume,
    tools.set_brightness, background.media, tools.ask_user, tools.clear_memory, background.needs_screen,
]
SHOW_TOOLS = [
    tools.run_shell, tools.run_applescript, youtube.youtube, tools.open_url,
    background.calendar, background.send_message, background.web_answer, background.set_volume,
    tools.set_brightness, background.media, tools.ask_user, tools.clear_memory,
]
TOOLS = {fn.__name__: fn for fn in BACKGROUND_TOOLS + SHOW_TOOLS}

SYSTEM_PROMPT = """You are Prometheus, a voice assistant on the user's Mac.
Everything you say is spoken aloud, so answer in one short, natural sentence (two at most). Never use lists, markdown, code, file paths, URLs, commands, tool names or technical details in what you say, and never repeat the user's request back to them.

Each request runs in one of two modes, chosen by the app before you see it:
- BACKGROUND: work without touching the screen. You only have background tools. If none of them can do the request, call needs_screen and nothing else. Never pretend or explain instead.
- SHOW: the user wants to see it. You may open apps and pages.

Acting:
- Do the task right away with as few calls as possible, and never narrate steps. Fill `reply` with a few fresh words such as "Done.", "Here you go." or "Playing it.", never a restatement of the request. Leave `reply` empty only when you need a command's output to answer.
- Never use echo, printf, say, or a script that only returns text, to talk. Use ask_user only for a missing detail you can't guess.
- Facts from the internet (scores, schedules, news, weather, prices): web_answer with the full question. Never open a browser to look something up unless the user asked to see it.
- Calendar questions: calendar, then answer from the events in one sentence.
- Text messages: send_message only. The app finds the contact, asks which one if needed, and reads the message back. Never send messages or email any other way. Email can't be sent.
- Volume: set_volume. Brightness: set_brightness. Play, pause or skip music: media.
- YouTube (SHOW only): one youtube call does every step. "Open X on YouTube" is action "open" (a channel name opens the channel, anything else plays the best match). "Play X" is "play". "Latest or newest video from X" is "latest". "Search YouTube for X" is "search". "Play the first one" or "the second one" is "play" with no query and that index. Use app "youtube_app" when the user says the YouTube app, "default" for "my browser", otherwise "safari".
- Other web pages (SHOW): open_url. Other apps (SHOW): run_shell `open -a "App"`, or run_applescript.

Confirmation:
- Deleting or overwriting files, quitting apps, shutting down or restarting, and purchases are checked by the app. Just make the call and put the action in `summary` as a few plain words, like "Delete report.pdf". Do not ask the user yourself.
- Results are plain. "declined" means the user said no, so reply "Okay." "done" means it worked. "failed: ..." means it did not work. Never mention permission, approval or that anyone allowed anything.

Chatting and memory:
- Answer plain questions in text without a tool.
- Below you may be given your memory of past conversations. Use it when asked things like "what did I ask you earlier?" and answer briefly. Never repeat secrets. Call clear_memory only when the user asks you to forget or clear your memory."""

_TRANSCRIBE = types.GenerateContentConfig(
    temperature=0,
    max_output_tokens=256,
    system_instruction=(
        "Transcribe the speech exactly. Reply with only the words spoken. "
        "The speaker may say the name Prometheus, the name of an assistant. "
        "If there is no speech, reply with nothing."
    ),
)

_SUMMARIZE = types.GenerateContentConfig(
    temperature=0,
    max_output_tokens=400,
    system_instruction=(
        "You keep a short memory of what a user asked a voice assistant. Merge the summary and "
        "the new lines into one summary of at most 1200 characters. Keep what was discussed and "
        "which actions were requested, newest details last. Never include passwords, keys, "
        "tokens or personal secrets. Reply with only the summary."
    ),
)

history = []
model_i = 0
model_problem = ""
_missing_models = set()


def _config(mode="show"):
    """Rebuilt for each call so the model sees the right tools, the time, and the latest memory."""
    context = memory.context()
    instruction = (
        SYSTEM_PROMPT
        + f"\n\nCurrent date and time: {datetime.now():%A, %B %-d, %Y, %-I:%M %p}."
        + f"\nThis request runs in {mode.upper()} mode."
        + ("\n\n" + context if context else "")
    )
    return types.GenerateContentConfig(
        tools=list(BACKGROUND_TOOLS if mode == "background" else SHOW_TOOLS),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        max_output_tokens=512,
        temperature=0,
        system_instruction=instruction,
    )


def _switch_reason(exc):
    """Why this model should be skipped, or None if the error should surface."""
    status = (getattr(exc, "status", None) or "").upper()
    code = getattr(exc, "code", None)
    if code in (429, 503, 504) or status in {
        "UNAVAILABLE",
        "RESOURCE_EXHAUSTED",
        "DEADLINE_EXCEEDED",
    }:
        return "busy"
    if code == 404 or status == "NOT_FOUND":
        return "missing"
    return None


def _generate(contents, config=None, fallback_on_invalid=False):
    """Try the models in order. Stay on the first one that answers."""
    global model_i, model_problem
    config = config or _config()
    saw_demand = False
    order = [model_i] + [i for i in range(len(MODELS)) if i != model_i]
    for index in order:
        if MODELS[index] in _missing_models:
            continue
        try:
            response = _api().models.generate_content(
                model=MODELS[index],
                contents=contents,
                config=config,
            )
        except errors.APIError as exc:
            reason = _switch_reason(exc)
            if reason is None and fallback_on_invalid and getattr(exc, "code", None) == 400:
                reason = "unsupported"
            if reason is None:
                raise
            saw_demand = saw_demand or reason == "busy"
            if reason == "missing":
                _missing_models.add(MODELS[index])
            continue
        model_i = index
        model_problem = ""
        return response
    model_problem = (
        "I'm a bit busy right now. Try again in a moment."
        if saw_demand
        else "I can't reach my brain right now. Try again in a moment."
    )
    print(f"\n{model_problem}")
    return None


def _calls(response):
    candidates = response.candidates or []
    content = candidates[0].content if candidates else None
    parts = content.parts if content else None
    if not parts:
        return []
    return [part.function_call for part in parts if part.function_call]


# --- Show or background --------------------------------------------------------------------------
# Decided in code from the user's own words. The model has no way to change it.

screen_mode = "auto"  # "auto", "background" (locked) or "show" (locked)
_last_mode = None
_offer = None  # ("show", callable) or ("rerun", request) after "Want me to show it?"

_LEAD = r"^(?:(?:hey|ok|okay|so|now|please|and|then|can you|could you|would you|will you|go ahead and|i want you to|i'd like you to)[\s,]+)*"
_SHOW_VERB = re.compile(
    _LEAD + r"(?:open|show|go to|goto|play|watch|pull up|bring up|launch|navigate to|visit|take me to)\b",
    re.IGNORECASE,
)
_MODE_PHRASES = [
    ("auto", re.compile(
        r"\b(?:(?:get out of|exit|leave|stop|turn off|end|quit) show mode|(?:back to |go back to )?(?:normal|auto|automatic) mode)\b",
        re.IGNORECASE)),
    ("background", re.compile(
        r"\b(?:stop controlling (?:my|the) screen|don'?t (?:use|touch|take over|control) (?:my|the) screen|"
        r"leave (?:my|the) screen alone|stay in (?:the )?background|work in (?:the )?background|"
        r"(?:switch to |go to |go into |enter |use )?background mode)\b",
        re.IGNORECASE)),
    ("show", re.compile(
        r"\b(?:(?:switch to |go to |go into |enter |turn on |use )?show mode|(?:you can )?(?:use|control) (?:my|the) screen|"
        r"show me what you'?re doing)\b",
        re.IGNORECASE)),
]
_MODE_ACK = {
    "background": "Okay, I'll stay in the background.",
    "show": "Okay, I'll show you what I'm doing.",
    "auto": "Okay, back to normal.",
}
_ACCEPT = re.compile(
    r"^(?:yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|go for it|show me|show it|show|yes please|"
    r"yes show me|sure show me|yeah show me|ok show me|okay show me)(?:[\s,.!]+(?:please|it))?[\s.!]*$",
    re.IGNORECASE,
)
_STAYING = "I'm staying in the background. Say show mode if you want me to use the screen."
_OFFER_SHOW = " Want me to show it?"
_CANT_QUIETLY = "I can't do that quietly. Want me to show it?"


def mode_command(text):
    """(new mode, rest of the sentence) when the user changes the mode, else None."""
    for mode, pattern in _MODE_PHRASES:
        match = pattern.search(text or "")
        if match:
            rest = (text[: match.start()] + " " + text[match.end():]).strip(" ,.!?")
            rest = re.sub(r"^(?:and|then|also|please)\b[\s,]*", "", rest, flags=re.IGNORECASE)
            return mode, rest
    return None


def classify(message, follow_up=False):
    """Show for show verbs, background for everything else. Locked modes win."""
    if screen_mode == "background":
        return "background"
    if _SHOW_VERB.search(message.strip()):
        return "show"
    if screen_mode == "show":
        return "show"
    if follow_up and _last_mode == "show":
        return "show"  # "search for lo-fi" right after "open YouTube"
    return "background"


# --- Reply handling ------------------------------------------------------------------------------

def _clean(text: str) -> str:
    """Plain speech: no markdown, links, code or line breaks."""
    text = re.sub(r"```.*?```", " ", text or "", flags=re.DOTALL)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = text.replace("`", "")
    text = re.sub(r"(?m)^\s*(?:#+\s*|[-*•]\s+|\d+[.)]\s+|>\s*)", "", text)
    text = re.sub(r"[*_~]{1,3}", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _repeats(reply: str, request: str) -> bool:
    """True when the reply just says the request back."""
    a = re.sub(r"[^a-z0-9 ]", "", reply.lower()).strip()
    b = re.sub(r"[^a-z0-9 ]", "", request.lower()).strip()
    if not a or not b:
        return False
    return a == b or SequenceMatcher(None, a, b).ratio() >= 0.85


def _failed(result) -> bool:
    return str(result).startswith("failed")


def _describe(name, args) -> str:
    """A few plain words for memory about what was asked."""
    summary = str(args.get("summary") or "").strip()
    if name == "set_brightness":
        return f"set brightness to {args.get('percent')}%"
    if name == "set_volume":
        return f"set volume to {args.get('percent')}%"
    if name == "youtube":
        what = args.get("query") or f"result {args.get('index') or 1}"
        return f"youtube {args.get('action', '')}: {what}"
    if name == "send_message":
        return f"message to {args.get('to', '')}"
    if name == "web_answer":
        return f"looked up: {args.get('question', '')}"
    if name == "calendar":
        return "checked calendar"
    if name == "media":
        return f"music {args.get('action', '')}"
    if name == "open_url":
        return f"opened {args.get('url', '')}"
    if summary:
        return summary
    if name == "run_shell":
        return "ran: " + " ".join(str(args.get("command", "")).split())[:80]
    if name == "run_applescript":
        return "ran AppleScript: " + " ".join(str(args.get("script", "")).split())[:80]
    return name


def _run_calls(calls, mode):
    """Run the tool calls. Returns response parts and a list of (name, args, result)."""
    allowed = {fn.__name__ for fn in (BACKGROUND_TOOLS if mode == "background" else SHOW_TOOLS)}
    parts = []
    outcomes = []
    for call in calls:
        name = call.name or ""
        fn = TOOLS.get(name) if name in allowed else None
        args = dict(call.args or {})
        if fn and name not in ("ask_user", "needs_screen"):
            args.setdefault("reply", "")
        before = background.frontmost() if mode == "background" else None
        try:
            if fn:
                result = fn(**args)
            elif name in TOOLS:
                result = "needs screen"  # a show tool asked for in background mode
            else:
                result = f"failed: unknown tool {name}"
        except Exception as exc:
            result = f"failed: {exc}"
        finally:
            if before is not None:
                background.restore(before)
        parts.append(types.Part.from_function_response(name=name, response={"result": result}))
        outcomes.append((name, args, str(result)))
    return parts, outcomes


def _needs_another_round(outcomes, round_no) -> bool:
    """Let the model look at the result when it asked a question, got no usable action, or needs the output."""
    last = round_no >= MAX_ROUNDS - 1
    for name, args, result in outcomes:
        if result == "needs screen" or result.startswith("answer: "):
            return False
        if name == "ask_user" or result == _NOT_AN_ACTION or name not in TOOLS:
            return True
        if last or result == "declined" or result.startswith(("failed: setup", "failed: say: ")):
            continue
        if _failed(result):
            return True
        if name == "calendar":
            return True  # answer from the events
        if not str(args.get("reply") or "").strip() and result != "done":
            return True  # an info lookup: answer from the output
    return False


def _speech(outcomes) -> str:
    """What to say after the tools ran."""
    outcomes = [o for o in outcomes if o[0] != "ask_user" and o[2] != _NOT_AN_ACTION]
    if not outcomes:
        return ""
    if any(r == "needs screen" for _, _, r in outcomes):
        return _STAYING if screen_mode == "background" else _CANT_QUIETLY
    if any(r.startswith("failed: setup") for _, _, r in outcomes):
        return "I can't control Safari yet. The setup steps are in the terminal."
    for _, _, r in outcomes:
        if r.startswith("failed: say: "):
            return r[len("failed: say: "):]
    if any(_failed(r) for _, _, r in outcomes):
        return "That didn't work."
    if any(r == "declined" for _, _, r in outcomes):
        return "Okay."
    for _, _, r in outcomes:
        if r.startswith("answer: "):
            return _clean(r[len("answer: "):])
    replies = [_clean(str(a.get("reply") or "")) for _, a, _ in outcomes]
    replies = [r for r in replies if r]
    if replies:
        return replies[-1]
    last = outcomes[-1][2] if outcomes else ""
    return _clean(last) if last and last != "done" else "Done."


def send(message, io=None, follow_up=False):
    """Handle one request. Returns the short sentence to speak, or None if the model was unavailable."""
    token = console.set(io) if io is not None else None
    try:
        return _send(message, follow_up)
    finally:
        if token is not None:
            console.reset(token)


def _is_user_text(content) -> bool:
    if content.role != "user" or not content.parts:
        return False
    return any(p.text for p in content.parts) and not any(p.function_response for p in content.parts)


def _trim(items):
    """Keep the session history short, starting at a user turn so tool calls stay paired."""
    if len(items) <= MAX_HISTORY:
        return items
    items = items[-MAX_HISTORY:]
    for i, content in enumerate(items):
        if _is_user_text(content):
            return items[i:]
    return []


def reset_history():
    global history
    history = []


def _send(message, follow_up=False):
    global screen_mode, _last_mode, _offer
    change = mode_command(message)
    if change:
        screen_mode, rest = change
        print(f"\n[mode: {screen_mode}]")
        if len(rest.split()) < 2:
            _offer = None
            return _MODE_ACK[screen_mode]
        message = rest

    offer, _offer = _offer, None
    forced = None
    if offer and _ACCEPT.match(message.strip()):
        kind, payload = offer
        if screen_mode == "background":
            return _STAYING
        if kind == "show":
            try:
                payload()
            except Exception as exc:
                print(f"\n{exc}")
                return "That didn't work."
            _last_mode = "show"
            return "Here it is."
        message, forced = payload, "show"

    mode = forced or classify(message, follow_up)
    print(f"\n[{mode}]")
    return _converse(message, mode)


def _converse(message, mode):
    global history, _last_mode, _offer
    background.last_show = None
    work = history + [types.UserContent(message)]
    reply = ""
    actions = []
    forgot = False
    ran_tools = False
    needed_screen = False
    for round_no in range(MAX_ROUNDS):
        response = _generate(work, config=_config(mode))
        if response is None:
            if round_no == 0:
                return None
            break
        if not response.candidates or not response.candidates[0].content:
            break
        model_content = response.candidates[0].content
        calls = _calls(response)
        if not calls:
            work.append(model_content)
            reply = _clean(response.text or "") or reply
            break
        parts, outcomes = _run_calls(calls, mode)
        ran_tools = True
        work.extend([model_content, types.Content(role="user", parts=parts)])
        for name, args, result in outcomes:
            if result == "needs screen":
                needed_screen = True
            elif name == "clear_memory" and result == "done":
                forgot = True
            elif name not in ("ask_user", "clear_memory", "needs_screen") and name in TOOLS:
                status = " (declined)" if result == "declined" else " (failed)" if _failed(result) else ""
                actions.append(_describe(name, args) + status)
        reply = _speech(outcomes)
        if not _needs_another_round(outcomes, round_no):
            break
    if not reply:
        reply = "That didn't work." if ran_tools else "Sorry, I didn't get that."
    if _repeats(reply, message):
        reply = "Okay." if not ran_tools or any("declined" in a for a in actions) else "Done."

    if needed_screen:
        if screen_mode != "background":
            _offer = ("rerun", message)
    elif mode == "background" and background.last_show and not reply.endswith("?"):
        reply = reply.rstrip() + _OFFER_SHOW
        _offer = ("show", background.last_show)
    _last_mode = mode

    if work and work[-1].role != "model":
        work.append(types.ModelContent(reply))
    if forgot:
        history = []
        return reply
    history = _trim(work)
    memory.add(message, reply, actions)
    return reply


# --- Startup helpers --------------------------------------------------------------------

def prepare_memory():
    """Fold old entries into the memory summary. Called once at startup."""
    def summarize(prompt):
        response = _generate(prompt, config=_SUMMARIZE)
        return (response.text or "").strip() if response else None

    memory.compact(summarize)


def transcribe(wav: bytes) -> str:
    """Turn a short wav clip into text with the same free Gemini models."""
    if not wav:
        return ""
    contents = [
        "Transcribe this clip.",
        types.Part.from_bytes(data=wav, mime_type="audio/wav"),
    ]
    response = _generate(contents, config=_TRANSCRIBE, fallback_on_invalid=True)
    if response is None:
        return ""
    text = (response.text or "").strip().strip('"')
    if re.fullmatch(
        r"(no speech( detected)?|silence|\(silence\)|\[silence\]|empty|n/?a)\.?",
        text,
        re.IGNORECASE,
    ):
        return ""
    return text
