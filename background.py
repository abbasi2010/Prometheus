"""Background (assistant) tools. None of these bring an app to the front.

Calendar and Contacts are read with Apple's frameworks (EventKit, Contacts), web
facts come from a plain HTTP search, and Messages is scripted without activating it.
"""
import html
import json
import re
import subprocess
import threading
import time
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from tools import _console

WEB_LOG = Path(__file__).resolve().parent / "web_answers.log"
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Set by a background tool when there is something it could show on screen
# ("Want me to show it?"). brain.py clears it before each request.
last_show = None


def _osa(script, *args, timeout=20):
    r = subprocess.run(["osascript", "-e", script, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def _is_running(app: str) -> bool:
    return _osa(f'return application "{app}" is running', timeout=5)[1] == "true"


def _launch_hidden(app: str) -> None:
    """Start an app without showing it, so scripting it never pops a window forward."""
    if not _is_running(app):
        subprocess.run(["open", "-g", "-j", "-a", app], capture_output=True, timeout=15)
        for _ in range(20):
            if _is_running(app):
                break
            time.sleep(0.25)
        time.sleep(1.0)


# --- Screen safety net ----------------------------------------------------------------------------

def frontmost():
    """(bundle id of the frontmost app, (window id, tab index) of Safari's front tab or None)."""
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    info = subprocess.run(["lsappinfo", "info", "-only", "bundleid", asn], capture_output=True, text=True).stdout
    match = re.search(r'(?:bundleID|CFBundleIdentifier)"?\s*=\s*"([^"]+)"', info)
    bundle = match.group(1) if match else ""
    tab = None
    if bundle == "com.apple.Safari":
        code, out, _ = _osa(
            'tell application "Safari" to return ((id of front window) as text) & "," & '
            '((index of current tab of front window) as text)',
            timeout=5,
        )
        if code == 0 and "," in out:
            first, second = out.split(",", 1)
            tab = (int(first), int(second))
    return bundle, tab


def restore(before) -> bool:
    """Put the frontmost app and Safari tab back if a background step changed them."""
    after = frontmost()
    if after == before or not before[0]:
        return False
    bundle, tab = before
    if bundle == "com.apple.Safari" and tab:
        _osa(
            "on run argv\n"
            "  tell application \"Safari\" to set current tab of window id ((item 1 of argv) as integer) "
            "to tab ((item 2 of argv) as integer) of window id ((item 1 of argv) as integer)\n"
            "end run",
            str(tab[0]), str(tab[1]), timeout=5,
        )
    if after[0] != bundle:
        subprocess.run(["open", "-b", bundle], capture_output=True, timeout=10)
    print("\n(put your screen back the way it was)")
    return True


# --- Volume and media -------------------------------------------------------------------------------

def set_volume(percent: int, reply: str) -> str:
    """Set the output volume, 0 to 100.

    reply: a few words spoken when done, such as "Volume's at 30." """
    try:
        value = int(round(float(str(percent).strip().rstrip("%"))))
    except (TypeError, ValueError):
        return "failed: volume must be a number from 0 to 100"
    if not 0 <= value <= 100:
        return "failed: volume must be a number from 0 to 100"
    code, _, err = _osa(f"set volume output volume {value}")
    return "done" if code == 0 else f"failed: {err[:120]}"


_MEDIA = {"play": "play", "pause": "pause", "toggle": "playpause", "next": "next track", "previous": "previous track"}


def media(action: str, reply: str, app: str = "") -> str:
    """Play, pause or skip music in Spotify or Music without opening them.

    action: "play", "pause", "toggle", "next" or "previous".
    app: "Spotify" or "Music". Leave empty to use whichever is running.
    reply: a few words spoken when done, such as "Paused." """
    command = _MEDIA.get((action or "").strip().lower())
    if not command:
        return "failed: action must be play, pause, toggle, next or previous"
    wanted = (app or "").strip().lower()
    if "spotify" in wanted:
        target = "Spotify"
    elif "music" in wanted:
        target = "Music"
    else:
        target = next((name for name in ("Spotify", "Music") if _is_running(name)), None)
    if not target or not _is_running(target):
        return "failed: say: Open Spotify or Music first."
    code, _, err = _osa(f'tell application "{target}" to {command}')
    return "done" if code == 0 else f"failed: {err[:120]}"


# --- Calendar ---------------------------------------------------------------------------------------

def _authorized(status_fn, request_fn, ok_statuses):
    status = status_fn()
    if status in ok_statuses:
        return True
    if status != 0:  # denied or restricted; macOS won't ask again
        return False
    done, result = threading.Event(), {}

    def handler(granted, error):
        result["ok"] = bool(granted)
        done.set()

    request_fn(handler)
    done.wait(120)
    return result.get("ok", False)


def _event_store():
    import EventKit

    store = EventKit.EKEventStore.alloc().init()
    if hasattr(store, "requestFullAccessToEventsWithCompletion_"):
        request = store.requestFullAccessToEventsWithCompletion_
    else:
        request = lambda handler: store.requestAccessToEntityType_completion_(EventKit.EKEntityTypeEvent, handler)
    ok = _authorized(
        lambda: EventKit.EKEventStore.authorizationStatusForEntityType_(EventKit.EKEntityTypeEvent),
        request,
        ok_statuses=(3,),
    )
    return store if ok else None


_CALENDAR_SHOW = """on run argv
    set d to current date
    set day of d to 1
    set year of d to (item 1 of argv) as integer
    set month of d to (item 2 of argv) as integer
    set day of d to (item 3 of argv) as integer
    tell application "Calendar"
        activate
        switch view to day view
        view calendar at d
    end tell
end run"""


def _show_calendar(when: datetime):
    _osa(_CALENDAR_SHOW, str(when.year), str(when.month), str(when.day))


# Used when macOS won't give this process calendar or contacts access directly
# (for example when it runs inside an editor). The apps are started hidden.
_CALENDAR_READ = """on run argv
    set n to (item 1 of argv) as integer
    set startD to (current date) - 12 * hours
    set endD to (current date) + n * days
    set out to ""
    tell application "Calendar"
        set total to count of calendars
        repeat with i from 1 to total
            set c to calendar i
            set found to (events of c whose start date is greater than or equal to startD and start date is less than or equal to endD)
            repeat with e in found
                set loc to ""
                try
                    set loc to location of e
                    if loc is missing value then set loc to ""
                end try
                set out to out & (summary of e) & tab & ((start date of e) as «class isot» as string) & tab & ((end date of e) as «class isot» as string) & tab & ((allday event of e) as string) & tab & loc & "||" & linefeed
            end repeat
        end repeat
    end tell
    return out
end run"""
_CONTACTS_READ = """on run argv
    set q to item 1 of argv
    set out to ""
    tell application "Contacts"
        repeat with p in (people whose name contains q)
            set ph to ""
            repeat with x in phones of p
                if ph is "" then set ph to value of x
                set lab to ""
                try
                    set lab to label of x
                end try
                if lab contains "mobile" or lab contains "iPhone" then set ph to value of x
            end repeat
            set em to ""
            try
                set em to value of email 1 of p
            end try
            set out to out & (name of p) & tab & ph & tab & em & linefeed
        end repeat
    end tell
    return out
end run"""


def _read_app(app: str, script: str, *args, timeout=60) -> str:
    """Run a read-only script against an app started hidden, then quit it if Prometheus started it."""
    was_running = _is_running(app)
    _launch_hidden(app)
    try:
        code, out, err = _osa(script, *args, timeout=timeout)
    finally:
        if not was_running:
            _osa(f'tell application "{app}" to quit', timeout=10)
    if code != 0:
        raise PermissionError(err[:200])
    return out


def _events_from_app(days):
    """[(title, start, end, all_day, location)] from the Calendar app. Repeating events show only their first date."""
    events = []
    for line in _read_app("Calendar", _CALENDAR_READ, str(days), timeout=180).split("||"):
        parts = line.strip().split("\t")
        if len(parts) < 4:
            continue
        try:
            start, end = datetime.fromisoformat(parts[1]), datetime.fromisoformat(parts[2])
        except ValueError:
            continue
        events.append((parts[0], start, end, parts[3] == "true", parts[4] if len(parts) > 4 else ""))
    return events


def calendar(reply: str, days: int = 7, query: str = "") -> str:
    """Read upcoming calendar events without opening Calendar. Then answer from them in one short sentence; for "next meeting" use the first event that has a time.

    days: how far ahead to look (default 7). query: optional words that must be in the event title.
    reply: leave empty; the events are returned to you."""
    global last_show
    try:
        days = max(1, min(60, int(float(days or 7))))
    except (TypeError, ValueError):
        days = 7
    now = datetime.now()
    store = _event_store()
    if store is not None:
        from Foundation import NSDate

        predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
            NSDate.dateWithTimeIntervalSinceNow_(-12 * 3600), NSDate.dateWithTimeIntervalSinceNow_(days * 86400), None
        )
        events = [
            (str(e.title() or "Untitled"), datetime.fromtimestamp(e.startDate().timeIntervalSince1970()),
             datetime.fromtimestamp(e.endDate().timeIntervalSince1970()), bool(e.isAllDay()), str(e.location() or ""))
            for e in (store.eventsMatchingPredicate_(predicate) or [])
        ]
    else:
        try:
            events = _events_from_app(days)
        except (PermissionError, subprocess.TimeoutExpired) as exc:
            print(f"\n{exc}\nAllow Calendar access in System Settings > Privacy & Security > Calendars (or Automation).")
            return "failed: say: I don't have access to your calendar yet. Allow it in System Settings, then ask again."
    events = [e for e in events if e[2] > now]
    if query.strip():
        events = [e for e in events if query.strip().lower() in e[0].lower()]
    events.sort(key=lambda e: e[1])
    lines = []
    for title, start, _end, all_day, location in events[:10]:
        text = f"{title} | " + (f"all day {start:%a %b %-d}" if all_day else f"{start:%a %b %-d, %-I:%M %p}")
        if start <= now:
            text += " | happening now"
        if location:
            text += f" | at {location}"
        lines.append(text)
    if not lines:
        return f"no events in the next {days} days"
    first = events[0][1]
    last_show = lambda: _show_calendar(first)
    return "\n".join(lines)


# --- Contacts and Messages ----------------------------------------------------------------------------

def _contact_store():
    import Contacts

    store = Contacts.CNContactStore.alloc().init()
    ok = _authorized(
        lambda: Contacts.CNContactStore.authorizationStatusForEntityType_(Contacts.CNEntityTypeContacts),
        lambda handler: store.requestAccessForEntityType_completionHandler_(Contacts.CNEntityTypeContacts, handler),
        ok_statuses=(3, 4),
    )
    return store if ok else None


def find_contacts(name: str):
    """[(full name, phone or email), ...] for contacts matching name. Mobile numbers first."""
    import Contacts

    store = _contact_store()
    if store is None:
        return _contacts_from_app(name)
    keys = [
        Contacts.CNContactGivenNameKey, Contacts.CNContactFamilyNameKey, Contacts.CNContactNicknameKey,
        Contacts.CNContactPhoneNumbersKey, Contacts.CNContactEmailAddressesKey,
    ]
    predicate = Contacts.CNContact.predicateForContactsMatchingName_(name)
    found, _error = store.unifiedContactsMatchingPredicate_keysToFetch_error_(predicate, keys, None)
    people = []
    for contact in found or []:
        full = " ".join(p for p in (contact.givenName(), contact.familyName()) if p) or str(contact.nickname() or "")
        handles = []
        for item in contact.phoneNumbers() or []:
            label = str(item.label() or "")
            rank = 0 if ("Mobile" in label or "iPhone" in label) else 1
            handles.append((rank, str(item.value().stringValue())))
        for item in contact.emailAddresses() or []:
            handles.append((2, str(item.value())))
        if full and handles:
            people.append((full, sorted(handles)[0][1]))
    return people


def _contacts_from_app(name: str):
    """The same lookup through the Contacts app, started hidden."""
    people = []
    for line in _read_app("Contacts", _CONTACTS_READ, name).splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[0] and (parts[1] or parts[2]):
            people.append((parts[0], parts[1] or parts[2]))
    return people


_ORDINAL_WORDS = (("first", 0), ("second", 1), ("third", 2), ("fourth", 3))
_NUMBER_WORDS = (("1", 0), ("2", 1), ("3", 2), ("4", 3), ("one", 0), ("two", 1), ("three", 2), ("four", 3))


def _choose(answer: str, names):
    """Index of the name the user picked, or None when it isn't clear."""
    text = (answer or "").lower()
    for word, index in _ORDINAL_WORDS:
        if re.search(rf"\b{word}\b", text):
            return index if index < len(names) else None
    if re.search(r"\blast\b", text):
        return len(names) - 1
    for word, index in _NUMBER_WORDS:
        if re.search(rf"\b{word}\b", text) and index < len(names):
            return index
    # Ignore the name they all share ("Brian"); only the part that differs counts.
    shared = set.intersection(*(set(n.lower().split()) for n in names)) if names else set()
    words = [w for w in re.findall(r"[a-z']+", text) if w not in shared]
    scores = []
    for i, name in enumerate(names):
        parts = [p for p in name.lower().split() if p not in shared] or name.lower().split()
        scores.append((max((SequenceMatcher(None, w, p).ratio() for w in words for p in parts), default=0), i))
    scores.sort(reverse=True)
    if not scores or scores[0][0] < 0.8 or (len(scores) > 1 and scores[1][0] == scores[0][0]):
        return None
    return scores[0][1]


# The handle and text are passed as arguments, never pasted into the script.
_SEND = """on run argv
    set theHandle to item 1 of argv
    set theText to item 2 of argv
    tell application "Messages"
        try
            set theService to 1st account whose service type = iMessage
            send theText to participant theHandle of theService
        on error
            set theService to 1st account whose service type = SMS
            send theText to participant theHandle of theService
        end try
    end tell
end run"""


def send_message(to: str, text: str, reply: str) -> str:
    """Send a text message (iMessage, or SMS if needed) without opening Messages. This is the only way to send a message. The app finds the contact, asks which one if several match, and reads the message back for a yes before sending.

    to: the contact's name as the user said it, or a phone number.
    text: the exact message to send, in the user's words.
    reply: a few words spoken after it is sent, such as "Sent." """
    global last_show
    to, text = (to or "").strip(), (text or "").strip()
    if not to or not text:
        return "failed: need both who to send it to and the message"
    io = _console()
    if re.fullmatch(r"\+?[\d\s().-]{7,}", to) or re.fullmatch(r"[^@\s]+@[^@\s]+\.\w+", to):
        name, handle = to, to
    else:
        try:
            people = find_contacts(to)
        except PermissionError:
            print("\nAllow Contacts access in System Settings > Privacy & Security > Contacts.")
            return "failed: say: I don't have access to your contacts yet. Allow it in System Settings, then ask again."
        unique = list(dict.fromkeys(people))
        if not unique:
            return f"failed: say: I couldn't find {to} in your contacts."
        if len({n for n, _ in unique}) > 1:
            names = [n for n, _ in unique][:4]
            listed = ", ".join(names[:-1]) + f" or {names[-1]}"
            pick = _choose(io.ask(f"Which {to}: {listed}?"), names)
            if pick is None:
                return "failed: say: Okay, I didn't send it."
            name, handle = unique[pick]
        else:
            name, handle = unique[0]
    if not io.confirm(f'Send "{text}" to {name}?'):
        return "declined"
    print(f"\nSending to {name} ({handle})")
    _launch_hidden("Messages")
    code, _, err = _osa(_SEND, handle, text)
    if code != 0:
        print(err)
        return "failed: Messages couldn't send it"
    address = re.sub(r"[^\d+]", "", handle) if "@" not in handle else handle
    last_show = lambda: subprocess.run(["open", f"imessage:{address}"], capture_output=True, timeout=10)
    return "done"


# --- Web answers ------------------------------------------------------------------------------------

_STOP = set("the a an and or of to in on for is are was were be what when where who how which next does do did "
            "at by with from this that find out tell me about my".split())
_WEB_RULES = (
    "You answer a question using ONLY the numbered sources below. Do not use anything you already know. "
    "If the sources do not clearly contain the answer, reply exactly NOT_FOUND. "
    "Otherwise reply with one short spoken sentence: no URLs, no source numbers, no markdown. "
    "Use the current date given to decide what is 'next' or 'latest'."
)


def _search_web(query):
    r = httpx.get("https://html.duckduckgo.com/html/", params={"q": query}, headers=_HEADERS, timeout=10)
    r.raise_for_status()
    results = []
    for block in r.text.split('<div class="result ')[1:]:
        if "result--ad" in block[:300]:
            continue
        link = re.search(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not link:
            continue
        href = html.unescape(link.group(1))
        if "uddg=" in href:
            href = unquote(parse_qs(urlparse(href).query).get("uddg", [href])[0])
        snippet = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', block, re.S)
        clean = lambda s: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()
        results.append({"url": href, "title": clean(link.group(2)), "snippet": clean(snippet.group(1) if snippet else "")})
    return results[:6]


def _page_text(url, keywords, limit=2500):
    """The parts of a page that mention the question's words."""
    try:
        r = httpx.get(url, headers=_HEADERS, timeout=8, follow_redirects=True)
    except httpx.HTTPError:
        return ""
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return ""
    body = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)\b.*?</\1>", " ", r.text[:600000])
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body))).strip()
    chunks = [text[i:i + 400] for i in range(0, len(text), 400)]
    ranked = sorted(range(len(chunks)), key=lambda i: -sum(chunks[i].lower().count(k) for k in keywords))
    keep = sorted(i for i in ranked[:6] if any(k in chunks[i].lower() for k in keywords))
    return " ... ".join(chunks[i] for i in keep)[:limit]


def _log_sources(question, answer, sources):
    print("\nSources:\n" + "\n".join(f"  {s['url']}" for s in sources))
    entry = {"t": datetime.now().isoformat(timespec="seconds"), "question": question, "answer": answer,
             "sources": [s["url"] for s in sources]}
    try:
        with WEB_LOG.open("a") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def web_answer(question: str, reply: str) -> str:
    """Look up a fact on the web without opening a browser: scores, schedules, news, weather, prices, opening hours. The answer comes only from pages it reads, and it is spoken as is.

    question: the full question, with names spelled out (e.g. "next Florida Gators football game").
    reply: leave empty."""
    global last_show
    import brain
    from google.genai import types

    question = (question or "").strip()
    if not question:
        return "failed: what should I look up"
    try:
        results = _search_web(question)
    except httpx.HTTPError as exc:
        print(f"\nWeb search failed: {exc}")
        return "failed: say: I couldn't look that up right now."
    if not results:
        return "failed: say: I couldn't find that online."
    keywords = [w for w in re.findall(r"[a-z0-9]+", question.lower()) if w not in _STOP and len(w) > 2]
    sources = []
    for result in results:
        page = ""
        if len([s for s in sources if s["page"]]) < 3 and "youtube.com" not in result["url"]:
            page = _page_text(result["url"], keywords)
        sources.append({**result, "page": page})
    material = "\n\n".join(
        f"[{i}] {s['title']} ({s['url']})\nSnippet: {s['snippet']}" + (f"\nPage text: {s['page']}" if s["page"] else "")
        for i, s in enumerate(sources, 1)
    )
    config = types.GenerateContentConfig(  # no tools: it can only read the sources
        temperature=0,
        max_output_tokens=200,
        system_instruction=_WEB_RULES + f" Current date and time: {datetime.now():%A, %B %-d, %Y, %-I:%M %p}.",
    )
    response = brain._generate(f"Question: {question}\n\nSources:\n{material}", config=config)
    answer = (response.text or "").strip() if response else ""
    used = [s for s in sources if s["page"]] or sources[:3]
    _log_sources(question, answer or "(no answer)", used)
    if not answer:
        return "failed: say: I couldn't look that up right now."
    if "NOT_FOUND" in answer:
        return "failed: say: I couldn't find that online."
    top = used[0]["url"]
    from youtube import open_in_safari

    last_show = lambda: open_in_safari(top)
    return "answer: " + answer


def needs_screen(reason: str) -> str:
    """Call this, and nothing else, when no background tool can do the request because it needs an app or web page on screen.

    reason: a few words, such as "needs a web page"."""
    return "needs screen"
