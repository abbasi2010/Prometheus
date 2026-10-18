"""YouTube in Safari, the Safari YouTube web app, or the default browser.

Videos are found from YouTube's search page fetched over HTTP, then the chosen
video is opened directly. That works the same in every target app and does not
depend on clicking around a page.
"""
import json
import plistlib
import re
import subprocess
import time
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse

import httpx

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_SITE = "https://www.youtube.com"

_last_results = []  # videos from the last search, for "play the second one"
_our_tab = None  # (window id, tab index) of the Safari tab Prometheus opened

_SAFARI_SHOW = """on run argv
    set theURL to item 1 of argv
    set reuseWindow to (item 2 of argv) as integer
    set reuseIndex to (item 3 of argv) as integer
    tell application "Safari"
        if (count of windows) = 0 then
            make new document with properties {URL:theURL}
        else
            set w to front window
            set t to missing value
            if reuseWindow is not 0 and (id of w) = reuseWindow then
                try
                    if (index of current tab of w) = reuseIndex and (URL of current tab of w) contains "youtube.com" then set t to current tab of w
                end try
            end if
            if t is missing value then
                set t to make new tab at end of tabs of w with properties {URL:theURL}
                set current tab of w to t
            else
                set URL of t to theURL
            end if
        end if
        activate
        return ((id of front window) as text) & "," & ((index of current tab of front window) as text)
    end tell
end run"""
_SAFARI_JS = """on run argv
    tell application "Safari" to return (do JavaScript (item 1 of argv) in current tab of front window)
end run"""
# Reads the video links on a YouTube results page in Safari, skipping ads, Shorts,
# mixes, duration badges and the "Watch" buttons.
_YT_RESULTS_JS = """(function(){
  var items = [], seen = {};
  document.querySelectorAll('a[href*="/watch?v="]').forEach(function(a){
    var href = a.getAttribute('href') || '';
    if (href.indexOf('list=') !== -1) return;
    if (a.closest('ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-display-ad-renderer')) return;
    var m = href.match(/[?&]v=([\\w-]{11})/); if (!m || seen[m[1]]) return;
    var title = (a.textContent || '').replace(/\\b\\d{1,2}(:\\d{2}){1,2}\\b/g, ' ').replace(/now playing/ig, ' ').replace(/\\s+/g, ' ').trim();
    var half = (title.length - 1) / 2;
    if (title.length % 2 === 1 && title.slice(0, half) === title.slice(half + 1)) title = title.slice(0, half);
    if (title.length < 2 || !/[A-Za-z\\u00C0-\\uFFFF]/.test(title) || /^(watch|mix|live|new)$/i.test(title)) return;
    seen[m[1]] = 1; items.push({id: m[1], t: title});
  });
  return JSON.stringify({url: location.href, items: items.slice(0, 25)});
})()"""
_SETUP_HELP = (
    "In Safari, turn on Settings > Advanced > 'Show features for web developers', then "
    "Settings > Developer > 'Allow JavaScript from Apple Events'."
)


class _SafariSetup(Exception):
    pass


def _osa(script, *args, timeout=20):
    r = subprocess.run(["osascript", "-e", script, *args], capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


# --- Reading YouTube over HTTP ------------------------------------------------------------

def _initial_data(url, params=None):
    r = httpx.get(url, params=params, headers=_HEADERS, cookies={"CONSENT": "YES+1"}, timeout=10, follow_redirects=True)
    r.raise_for_status()
    match = re.search(r"var ytInitialData = (\{.*?\});</script>", r.text)
    if not match:
        raise RuntimeError("YouTube sent a page without results")
    return json.loads(match.group(1))


def _find(obj, key, out):
    if isinstance(obj, dict):
        if key in obj:
            out.append(obj[key])
        for value in obj.values():
            _find(value, key, out)
    elif isinstance(obj, list):
        for value in obj:
            _find(value, key, out)
    return out


def _text(node) -> str:
    node = node or {}
    return node.get("simpleText") or "".join(run.get("text", "") for run in node.get("runs", []))


def _seconds(text):
    if not text or not re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", text.strip()):
        return None
    total = 0
    for part in text.strip().split(":"):
        total = total * 60 + int(part)
    return total


def _from_renderer(v):
    runs = (v.get("ownerText") or {}).get("runs") or [{}]
    badges = " ".join(b.get("metadataBadgeRenderer", {}).get("label", "") for b in v.get("badges", [])).upper()
    return {
        "id": v.get("videoId"),
        "title": _text(v.get("title")),
        "channel": _text(v.get("ownerText")),
        "channel_url": runs[0].get("navigationEndpoint", {}).get("browseEndpoint", {}).get("canonicalBaseUrl", ""),
        "seconds": _seconds(_text(v.get("lengthText"))),
        "live": "LIVE" in badges or bool(v.get("upcomingEventData")),
    }


def _from_lockup(lockup):
    if "VIDEO" not in str(lockup.get("contentType", "")):
        return None
    meta = _find(lockup, "lockupMetadataViewModel", [])
    badges = _find(lockup, "thumbnailBadgeViewModel", [])
    texts = [str(b.get("text", "")) for b in badges]
    styles = " ".join(str(b.get("badgeStyle", "")) for b in badges).upper()
    return {
        "id": lockup.get("contentId"),
        "title": (meta[0].get("title", {}).get("content", "") if meta else ""),
        "channel": "",
        "channel_url": "",
        "seconds": next((_seconds(t) for t in texts if _seconds(t)), None),
        "live": "LIVE" in styles or any(t.strip().upper() in ("LIVE", "UPCOMING", "PREMIERE") for t in texts),
    }


def _walk_videos(obj, out):
    """Videos in page order. Shorts use other renderers, so they never appear here."""
    if isinstance(obj, dict):
        if "videoRenderer" in obj:
            out.append(_from_renderer(obj["videoRenderer"]))
            return out
        if "lockupViewModel" in obj:
            video = _from_lockup(obj["lockupViewModel"])
            if video:
                out.append(video)
            return out
        for value in obj.values():
            _walk_videos(value, out)
    elif isinstance(obj, list):
        for value in obj:
            _walk_videos(value, out)
    return out


def _full_videos(data):
    """Full uploads only: no live streams, premieres, or anything a minute or shorter."""
    seen, videos = set(), []
    for v in _walk_videos(data, []):
        if v["id"] and v["id"] not in seen and not v["live"] and (v["seconds"] or 0) > 60:
            seen.add(v["id"])
            videos.append(v)
    return videos


def _search(query):
    data = _initial_data(f"{_SITE}/results", {"search_query": query})
    return data, _full_videos(data)


def _norm(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _channel_for(data, videos, query):
    """(name, url) when the query names a channel, else None."""
    wanted = _norm(query)
    if not wanted:
        return None
    for channel in _find(data, "channelRenderer", []):
        name = _text(channel.get("title"))
        if _norm(name) and SequenceMatcher(None, _norm(name), wanted).ratio() >= 0.88:
            path = channel.get("navigationEndpoint", {}).get("browseEndpoint", {}).get("canonicalBaseUrl")
            return name, _SITE + (path or f"/channel/{channel.get('channelId')}")
    owners = [v for v in videos[:6] if v["channel_url"] and _norm(v["channel"]) == wanted]
    if len(owners) >= 2:
        return owners[0]["channel"], _SITE + owners[0]["channel_url"]
    return None


def _words(text):
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _score(wanted, video):
    title = f"{video['title']} {video['channel']}"
    wanted_words = _words(wanted)
    overlap = len(wanted_words & _words(title)) / len(wanted_words) if wanted_words else 0.0
    return max(overlap, SequenceMatcher(None, wanted.lower(), video["title"].lower()).ratio())


def _best(videos, query):
    """YouTube's own ranking, unless the top hit clearly isn't what was asked for."""
    if not videos:
        return None
    top = videos[0]
    if _score(query, top) >= 0.3:
        return top
    best = max(videos[:8], key=lambda v: _score(query, v))
    return best if _score(query, best) >= 0.6 else top


def _latest(channel_url):
    """The channel's newest full upload. The Videos tab is newest first and has no Shorts."""
    videos = _full_videos(_initial_data(channel_url.rstrip("/") + "/videos"))
    return videos[0] if videos else None


def _watch(video):
    return f"{_SITE}/watch?v={video['id']}"


# --- Opening ----------------------------------------------------------------------------------

def youtube_app_path():
    """The Safari YouTube web app (Safari's "Add to Dock"), if installed."""
    for base in (Path.home() / "Applications", Path("/Applications")):
        for app in sorted(base.glob("*.app")):
            try:
                info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
            except (OSError, plistlib.InvalidFileException, ValueError):
                continue
            start = str((info.get("Manifest") or {}).get("start_url", ""))
            if str(info.get("CFBundleIdentifier", "")).startswith("com.apple.Safari.WebApp") and "youtube.com" in start:
                return str(app)
    return None


def open_in_safari(url, reuse_youtube_tab=False):
    """Open url in a new Safari tab, or in the YouTube tab Prometheus opened earlier."""
    global _our_tab
    window, index = (_our_tab or (0, 0)) if reuse_youtube_tab else (0, 0)
    code, out, err = _osa(_SAFARI_SHOW, url, str(window), str(index))
    if code != 0:
        raise RuntimeError(err or "Safari didn't open it")
    try:
        first, second = out.split(",")
        _our_tab = (int(first), int(second)) if "youtube.com" in url else _our_tab
    except ValueError:
        pass


def open_page(url, app="safari"):
    """Open url in the chosen app, falling back to Safari. Returns where it opened."""
    if app == "youtube_app":
        path = youtube_app_path()
        if path:
            r = subprocess.run(["open", "-a", path, url], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return "youtube_app"
            print(f"\nThe YouTube app didn't open it ({r.stderr.strip()}). Using Safari.")
        else:
            print("\nNo YouTube app is installed. Using Safari.")
    elif app == "default":
        r = subprocess.run(["open", url], capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            return "default"
        print(f"\nThe default browser didn't open it ({r.stderr.strip()}). Using Safari.")
    open_in_safari(url, reuse_youtube_tab="youtube.com" in url)
    return "safari"


# --- The Safari page, as a fallback ----------------------------------------------------------

def _page_videos():
    """(url, [(video_id, title), ...]) for the current Safari tab."""
    code, out, err = _osa(_SAFARI_JS, _YT_RESULTS_JS)
    if code != 0:
        if "JavaScript from Apple Events" in err or "Allow JavaScript" in err:
            raise _SafariSetup(err)
        raise RuntimeError(err)
    data = json.loads(out or "{}")
    return data.get("url", ""), [(i["id"], i["t"]) for i in data.get("items", [])]


def _wait_for_page_results(query, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        url, items = _page_videos()
        found = (parse_qs(urlparse(url).query).get("search_query") or [""])[0]
        if items and "/results" in url and found.lower() == query.lower():
            return items
        time.sleep(0.4)
    return []


def _play_from_page(query):
    """Search in Safari and play the top result, reading the page itself."""
    open_in_safari(f"{_SITE}/results?search_query={quote_plus(query)}", reuse_youtube_tab=True)
    items = _wait_for_page_results(query)
    if not items:
        return "failed: no videos showed up"
    open_in_safari(f"{_SITE}/watch?v={items[0][0]}", reuse_youtube_tab=True)
    return "done"


def _play_index(index, app):
    """Play result number `index` from the results on screen, or from the last search."""
    position = max(1, index) - 1
    if app == "safari":
        try:
            url, items = _page_videos()
            if "youtube.com/results" in url and position < len(items):
                open_in_safari(f"{_SITE}/watch?v={items[position][0]}", reuse_youtube_tab=True)
                return "done"
        except (_SafariSetup, RuntimeError, ValueError):
            pass
    if position < len(_last_results):
        open_page(_watch(_last_results[position]), app)
        return "done"
    return "failed: say: There's no list of videos to pick from."


# --- The tool ------------------------------------------------------------------------------------

def _target(app):
    key = (app or "").strip().lower().replace("_", " ").replace("-", " ")
    if "youtube" in key or key == "app":
        return "youtube_app"
    if "default" in key or "browser" in key:
        return "default"
    return "safari"


def youtube(action: str, reply: str, query: str = "", app: str = "safari", index: int = 0) -> str:
    """Do a whole YouTube request in one call: pick the app, search, choose the video and open it.

    action:
      "open": a channel name opens that channel's page; anything else plays the best match.
      "play": search for query and play the best match. With no query, play result number `index` (1 is the first) of the results already showing.
      "latest": play the newest full upload (no Shorts or live streams) of the channel named in query.
      "search": show the results page for query.
    app: "safari" (a new tab), "youtube_app" (the YouTube app), or "default" (the default browser).
    reply: a few words spoken when done, such as "Here it is." """
    global _last_results
    action = (action or "").strip().lower()
    app = _target(app)
    query = (query or "").strip()
    try:
        index = int(float(index or 0))
    except (TypeError, ValueError):
        index = 0
    print(f"\nYouTube {action}: {query or f'result {index}'} ({app})")
    try:
        if action == "search":
            if not query:
                return "failed: what should I search for"
            open_page(f"{_SITE}/results?search_query={quote_plus(query)}", app)
            try:
                _last_results = _search(query)[1]
            except Exception:
                _last_results = []
            return "done"
        if action not in ("open", "play", "latest"):
            return "failed: action must be open, play, latest or search"
        if not query:
            if action == "play":
                return _play_index(index or 1, app)
            return "failed: what should I open"
        try:
            data, videos = _search(query)
        except Exception as exc:
            print(f"\nCouldn't read YouTube over the web ({exc}). Using the Safari page instead.")
            return _play_from_page(query)
        if action == "latest":
            channel = _channel_for(data, videos, query)
            if not channel:
                return "failed: say: I couldn't find that channel."
            video = _latest(channel[1])
            if not video:
                return "failed: say: I couldn't find a recent full video on that channel."
            open_page(_watch(video), app)
            return "done"
        if action == "open":
            channel = _channel_for(data, videos, query)
            if channel:
                open_page(channel[1], app)
                return "done"
        _last_results = videos
        video = _best(videos, query)
        if not video:
            return _play_from_page(query)
        open_page(_watch(video), app)
        return "done"
    except _SafariSetup:
        print("\n" + _SETUP_HELP)
        return "failed: setup needed for Safari"
    except subprocess.TimeoutExpired:
        return "failed: it took too long"
    except Exception as exc:
        print(f"\n{exc}")
        return f"failed: {str(exc)[:120]}"
