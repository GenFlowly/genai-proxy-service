"""Citations from the model's own knowledge, turned into sources.

A model citing something it remembers (no tool result behind it) marks it
inline as [n] like any other citation and ends its answer with one line per
such citation, `[n]: reference` (the rule in llm_node). The streamed answer
must never show that list: the apps render it from the turn's sources, marked
as training knowledge. ReferenceTail sits on the answer stream, holds back
anything that could be the start of the list, and lets it go again as soon as
ordinary text follows. Whatever is still held when the answer ends is the
list itself.
"""
import re
from typing import Iterable

# `[4]: Madrian & Shea, ...`, `- [4] Madrian ...`, `\[4\] ...` (escaped brackets).
_REFERENCE_LINE = re.compile(r"\s*(?:[-*+]\s+)?\\?\[(\d{1,3})\\?\](:?)[ \t]+(\S.*?)\s*")
_REFERENCE_START = re.compile(r"\s*(?:[-*+]\s+)?\\?\[\d{1,3}\\?\]")
# What an unfinished line looks like before its marker is complete: "", "- ", "[", "\\[1".
_PARTIAL_START = re.compile(r"\s*(?:[-*+]\s*)?\\?(?:\[\d{0,3}\\?)?")
_RULE = re.compile(r"\s*(?:-{3,}|\*{3,}|_{3,})\s*")
_HEADINGS = ("sources", "references", "citations", "bibliography", "works cited")
_MARKER = re.compile(r"\\?\[(\d{1,3})\\?\]")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_EMPHASIS = re.compile(r"\*\*|__|\*|`|(?<!\w)_|_(?!\w)")


def _heading_words(line: str) -> str:
    return line.strip().strip("#*_: \t").lower()


def _is_heading(line: str) -> bool:
    return _heading_words(line) in _HEADINGS


def _is_block_line(line: str) -> bool:
    return (
        not line.strip()
        or _is_heading(line)
        or _RULE.fullmatch(line) is not None
        or _REFERENCE_LINE.fullmatch(line) is not None
    )


def _could_become_block_line(line: str) -> bool:
    if _REFERENCE_START.match(line) or _PARTIAL_START.fullmatch(line):
        return True
    words = _heading_words(line)
    return any(heading.startswith(words) for heading in _HEADINGS)


def _plain(reference: str) -> str:
    return _EMPHASIS.sub("", _LINK.sub(r"\1", reference)).strip()


class ReferenceTail:
    """Holds back a possible reference list at the end of a streamed answer."""

    def __init__(self) -> None:
        self._held = ""
        self._released: list[str] = []

    def feed(self, text: str) -> str:
        """The part of `text` (plus anything held) that can be streamed now."""
        self._held += text
        lines = self._held.split("\n")
        keep = len(lines) - 1
        if not _could_become_block_line(lines[keep]):
            keep = len(lines)
        else:
            while keep > 0 and _is_block_line(lines[keep - 1]):
                keep -= 1
        released = "\n".join(lines[:keep])
        if keep < len(lines) and keep > 0:
            released += "\n"
        self._held = self._held[len(released):]
        if released:
            self._released.append(released)
        return released

    def reset(self) -> None:
        """A tool-call round ended: its text was a preamble, so start over."""
        self._held = ""
        self._released.clear()

    def finish(self, taken: Iterable[int] = ()) -> tuple[str, list[dict]]:
        """At the end of the answer: (text still to stream, training sources).

        The held lines count as a reference list only when they hold at least
        one reference and either all take the asked-for `[n]: reference` form,
        sit under a Sources/References heading, or cite a number the answer's
        text uses. Otherwise they were ordinary text and stream as they are. A number in `taken` already belongs to
        a tool's source, which wins.
        """
        held, self._held = self._held, ""
        lines = held.split("\n")
        references: dict[int, str] = {}
        asked_for_form = True
        for line in lines:
            match = _REFERENCE_LINE.fullmatch(line)
            if not match:
                continue
            asked_for_form = asked_for_form and match.group(2) == ":"
            if int(match.group(1)) not in references:
                references[int(match.group(1))] = _plain(match.group(3))
        cited = {int(n) for n in _MARKER.findall("".join(self._released))}
        is_list = bool(references) and (
            asked_for_form
            or any(_is_heading(line) for line in lines)
            or bool(cited & references.keys())
        )
        if not is_list:
            return held, []
        taken = set(taken)
        return "", [
            {"index": index, "title": title, "url": "", "origin": "training"}
            for index, title in sorted(references.items())
            if index not in taken and title
        ]
