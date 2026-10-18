import subprocess

_SPOKEN_LIMIT = 240
_CHIME = "/System/Library/Sounds/Pop.aiff"


def say(text: str) -> None:
    """Speak with the built-in macOS voice. No API key."""
    spoken = " ".join(text.split())
    if not spoken:
        return
    if len(spoken) > _SPOKEN_LIMIT:
        cut = spoken[:_SPOKEN_LIMIT]
        end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        spoken = cut[: end + 1] if end > 40 else cut.rsplit(" ", 1)[0] + "."
    subprocess.run(["say", spoken], check=False)


def chime() -> None:
    """A short sound meaning 'I'm listening'. It finishes before the microphone opens."""
    subprocess.run(["afplay", _CHIME], check=False)
