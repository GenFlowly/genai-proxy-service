"""Markdown -> JSON token tree: the contract the Typst PDF template consumes.

Pure Python (markdown-it-py + mdit-py-plugins + linkify-it-py); no rendering
here. `parse(markdown)` returns a JSON-serializable dict that a renderer walks.
The parser follows CommonMark plus the GFM pieces LLM output relies on, so a
document lays out the way the chat UI (react-markdown + remark-gfm) shows it:

- markdown-it-py 'commonmark' preset, plus the core `table` and
  `strikethrough` rules the preset leaves off, plus `linkify` for bare URLs
  with an explicit scheme (no fuzzy domains: 'setup.py' is not a link);
- mdit-py-plugins: tasklists, texmath with delimiters='brackets' (TeX math in
  \\( \\) and \\[ \\]; '$' and '$$' stay literal, as the chat UI contract
  requires), footnote and deflist;
- every soft line break becomes a hard break (letters and address blocks keep
  their lines; markdown-it's `breaks` option only affects its HTML renderer);
- raw HTML is parsed, but only <br>, <sub>, <sup> and <u> become structure.
  Every other html_inline / html_block token is kept as literal text, so
  'Dear <Candidate Name>,' prints verbatim and nothing is ever fetched;
- a pre-pass moves a \\[...\\] that starts in the middle of a paragraph into
  its own block (markdown-it's math block rule cannot interrupt a paragraph,
  and a mid-line \\[ would otherwise turn into a plain '[').

Token tree contract, TREE_VERSION = 1
=====================================

Every node is a dict with a "type" key. Containers carry "children" (a list
of nodes). Strings are exactly the source text after Markdown escapes are
resolved (no HTML entities, no Typst or HTML escaping).

Document::

    {"type": "doc", "version": 1, "children": [block...], "footnotes": [footnote...]}

Block nodes::

    {"type": "heading", "level": 1-6, "id": "slug", "children": [inline...]}
        id: GitHub-style slug, unique within the document ("section-two",
        "section-two-1", ...). Link targets "#slug" refer to it.
    {"type": "paragraph", "children": [inline...]}
    {"type": "code_block", "lang": str | None, "value": str}
        lang: first word of the fence info string; value has no trailing newline.
    {"type": "math_block", "tex": str, "eqno": str | None}
        tex: the source between \\[ and \\], byte-exact (not stripped).
    {"type": "bullet_list", "tight": bool, "children": [list_item...]}
    {"type": "ordered_list", "start": int, "delimiter": "." | ")", "tight": bool,
     "children": [list_item...]}
    {"type": "list_item", "task": None | True | False, "children": [block...]}
        task: None for an ordinary item, True for '[x]'/'[X]', False for '[ ]'.
        The checkbox itself is not kept as text.
    {"type": "blockquote", "children": [block...]}
    {"type": "hr"}
    {"type": "table", "align": ["left" | "center" | "right" | None, ...],
     "header": [cell...], "rows": [[cell...], ...]}
        cell: a list of inline nodes. Every row has exactly len(align) cells.
    {"type": "deflist", "children": [deflist_item...]}
    {"type": "deflist_item", "term": [inline...], "definitions": [[block...], ...]}

Inline nodes::

    {"type": "text", "value": str}
    {"type": "hardbreak"}                      (also every soft break and <br>)
    {"type": "strong" | "em" | "strike" | "sub" | "sup" | "underline",
     "children": [inline...]}
    {"type": "code_inline", "value": str}
    {"type": "math_inline", "tex": str}        (source between \\( and \\), byte-exact)
    {"type": "link", "href": str, "title": str | None, "children": [inline...]}
    {"type": "autolink", "href": str, "value": str}   (<https://...> and bare URLs)
    {"type": "image", "src": str, "alt": str, "title": str | None}
    {"type": "footnote_ref", "id": int, "label": str | None}
        id indexes doc["footnotes"]; the displayed number is id + 1.

Footnote definitions (only referenced ones, in first-reference order)::

    {"type": "footnote", "id": int, "label": str | None, "children": [block...]}

Hrefs and image sources are markdown-it's normalised URLs; markdown-it already
drops javascript:, vbscript:, file: and non-image data: links (they stay
text). The renderer decides which schemes become links (5.1: http, https,
mailto and in-document '#slug' anchors) and which images are drawn.

Version policy: adding an optional key or a new node type that a renderer can
ignore keeps TREE_VERSION; renaming or removing a key, or changing a meaning,
bumps it.
"""
from __future__ import annotations

import re
import threading
import unicodedata
from typing import Any

TREE_VERSION = 1

__all__ = [
    "TREE_VERSION",
    "count_table_rows",
    "first_h1_text",
    "parse",
    "plain_text",
]

_local = threading.local()


def _parser():
    """One markdown-it instance per thread (linkify-it keeps per-call state)."""
    md = getattr(_local, "md", None)
    if md is None:
        from markdown_it import MarkdownIt
        from mdit_py_plugins.deflist import deflist_plugin
        from mdit_py_plugins.footnote import footnote_plugin
        from mdit_py_plugins.tasklists import tasklists_plugin
        from mdit_py_plugins.texmath import texmath_plugin

        md = MarkdownIt("commonmark", {"html": True, "linkify": True, "typographer": False})
        md.enable(["table", "strikethrough", "linkify"])
        # Only links with an explicit scheme (http://, https://, mailto: ...):
        # fuzzy matching would turn 'setup.py' into http://setup.py.
        md.linkify.set({"fuzzy_link": False, "fuzzy_email": True, "fuzzy_ip": False})
        md.use(tasklists_plugin)
        md.use(texmath_plugin, delimiters="brackets")
        md.use(footnote_plugin)
        md.use(deflist_plugin)
        _local.md = md
    return md


# ---------------------------------------------------------------------------
# Pre-pass: give a mid-paragraph \[...\] its own block
# ---------------------------------------------------------------------------

_LIST_MARKER_RE = re.compile(r"^( {0,3})([-+*]|\d{1,9}[.)])( +|$)")
_BQ_PREFIX_RE = re.compile(r"^(?: {0,3}> ?)+")


def _continuation_prefix(line: str) -> str:
    """Prefix that keeps an inserted line inside the same container as `line`."""
    bq = _BQ_PREFIX_RE.match(line)
    prefix = bq.group(0) if bq else ""
    rest = line[len(prefix):]
    m = _LIST_MARKER_RE.match(rest)
    if m:
        width = len(m.group(0)) if m.group(3) else len(m.group(0)) + 1
        return prefix + " " * width
    indent = len(rest) - len(rest.lstrip(" "))
    return prefix + " " * indent


def _line_content(line: str) -> str:
    """`line` without blockquote markers, a leading list marker and indentation."""
    bq = _BQ_PREFIX_RE.match(line)
    rest = line[len(bq.group(0)):] if bq else line
    m = _LIST_MARKER_RE.match(rest)
    if m:
        rest = rest[len(m.group(0)):]
    return rest.strip()


def _scan_openers(text: str) -> list[int]:
    """Offsets of \\[ openers outside backtick code spans (not escaped)."""
    out = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "`":
            run = len(text[i:]) - len(text[i:].lstrip("`"))
            close = text.find("`" * run, i + run)
            while close != -1 and close + run < n and text[close + run] == "`":
                close = text.find("`" * run, close + run + 1)
            if close == -1:
                i += run
                continue
            i = close + run
            continue
        if ch == "\\" and i + 1 < n:
            if text[i + 1] == "[":
                out.append(i)
            i += 2  # an escaped character ('\\\\[' is an escaped backslash, then '[')
            continue
        i += 1
    return out


def _find_closer(text: str, start: int) -> int:
    """Offset of the first unescaped \\] at or after `start`, or -1."""
    i, n = start, len(text)
    while i < n - 1:
        if text[i] == "\\":
            if text[i + 1] == "]":
                return i
            i += 2
            continue
        i += 1
    return -1


def _split_paragraph(lines: list[str]) -> list[str]:
    """Rewrite one paragraph's source lines so each \\[...\\] starts a block.

    Text before the opener stays a paragraph, a blank line (in the same
    container) separates it from the math, and text after the closing \\]
    moves to its own line, where it starts a new paragraph (markdown-it's math
    block rule would otherwise drop the rest of the closing line).
    """
    text = "\n".join(lines)
    cont = _continuation_prefix(lines[0])
    blank = cont.rstrip()
    out: list[str] = []
    pos = 0
    while True:
        openers = _scan_openers(text[pos:])
        if not openers:
            break
        start = pos + openers[0]
        end = _find_closer(text, start + 2)
        if end == -1:
            break
        before = text[pos:start]
        last_nl = before.rfind("\n")
        head = before[:last_nl] if last_nl != -1 else ""
        line_start = before[last_nl + 1:]
        if _line_content(line_start):
            # mid-line opener: keep the text before it on its own line
            out.extend((head + "\n" + line_start.rstrip() if head else line_start.rstrip()).split("\n"))
            out.append(blank)
            math_prefix = cont
        else:
            if any(_line_content(ln) for ln in head.split("\n")) if head else False:
                out.extend(head.split("\n"))
                out.append(blank)
            math_prefix = line_start
        out.extend((math_prefix + text[start:end + 2]).split("\n"))
        pos = end + 2
        rest = text[pos:]
        nl = rest.find("\n")
        tail = rest if nl == -1 else rest[:nl]
        if tail.strip():
            text = text[:pos] + "\n" + cont + tail.lstrip() + ("" if nl == -1 else rest[nl:])
            pos += 1  # text[pos:] now starts with the moved tail
        else:
            pos += len(tail) + (0 if nl == -1 else 1)
    remainder = text[pos:]
    if remainder:
        out.extend(remainder.split("\n"))
    return out


def _inline_display_math(line: str) -> str:
    """\\[x\\] -> \\(x\\) inside a line that cannot hold a block (table row, heading)."""
    out, pos = [], 0
    for rel in _scan_openers(line):
        start = rel
        if start < pos:
            continue
        end = _find_closer(line, start + 2)
        if end == -1:
            break
        out.append(line[pos:start])
        out.append("\\(" + line[start + 2:end] + "\\)")
        pos = end + 2
    out.append(line[pos:])
    return "".join(out)


def _has_display_opener(inline_token) -> bool:
    """True when the inline source holds a \\[ ... \\] pair outside code spans.

    Inline content is the raw source of a paragraph, heading or table cell, so
    a \\[ found here was parsed as a plain escape (no block rule took it).
    """
    content = inline_token.content or ""
    for start in _scan_openers(content):
        if _find_closer(content, start + 2) != -1:
            return True
    return False


def _prepass_display_math(src: str) -> str:
    """Move every mid-paragraph \\[...\\] into its own block (fence-safe).

    markdown-it itself tells us where a '\\[' was parsed as a plain escape
    (paragraph, heading or table cell), so code spans, fences and indented
    code are never touched.
    """
    if "\\[" not in src:
        return src
    tokens = _parser().parse(src)
    lines = src.split("\n")
    edits: list[tuple[int, int, str]] = []  # (start, end, kind)
    row_map = None  # source line of the current table row (cells carry no map)
    for i, tok in enumerate(tokens):
        if tok.type == "tr_open":
            row_map = tok.map
            continue
        if tok.type != "inline" or not _has_display_opener(tok):
            continue
        parent = tokens[i - 1] if i else None
        if parent is None:
            continue
        if parent.type == "paragraph_open" and parent.map:
            edits.append((parent.map[0], parent.map[1], "split"))
        elif parent.type == "heading_open" and parent.map:
            edits.append((parent.map[0], parent.map[0] + 1, "inline"))
        elif parent.type in ("th_open", "td_open") and row_map:
            edits.append((row_map[0], row_map[0] + 1, "inline"))
    if not edits:
        return src
    seen = set()
    for start, end, kind in sorted(edits, reverse=True):
        if (start, end) in seen:
            continue
        seen.add((start, end))
        if kind == "inline":
            lines[start:end] = [_inline_display_math(ln) for ln in lines[start:end]]
        else:
            lines[start:end] = _split_paragraph(lines[start:end])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tree builder
# ---------------------------------------------------------------------------

_HTML_TAG_RE = re.compile(r"^<\s*(/?)\s*([A-Za-z][A-Za-z0-9]*)\s*(/?)\s*>$")
_HTML_ALLOWED = {"sub": "sub", "sup": "sup", "u": "underline"}
_HTML_SPLIT_RE = re.compile(r"(<\s*/?\s*(?:br|sub|sup|u)\s*/?\s*>)", re.IGNORECASE)
_MD_CONTAINERS = {"strong": "strong", "em": "em", "s": "strike"}


def _classify_html(raw: str):
    """('br', None) | ('open'|'close', node_type) | None for literal text."""
    m = _HTML_TAG_RE.match(raw.strip())
    if not m:
        return None
    closing, name, selfclose = m.group(1), m.group(2).lower(), m.group(3)
    if name == "br" and not closing:
        return ("br", None)
    if name in _HTML_ALLOWED and not selfclose:
        return ("close" if closing else "open", _HTML_ALLOWED[name])
    return None


class _InlineBuilder:
    """Stack-based builder for one inline sequence."""

    def __init__(self) -> None:
        self.root: list[dict] = []
        # stack entries: (node, kind) where kind is 'md:<type>' or 'html:<type>'
        self.stack: list[tuple[dict, str]] = []

    @property
    def cur(self) -> list[dict]:
        return self.stack[-1][0]["children"] if self.stack else self.root

    def text(self, value: str) -> None:
        if not value:
            return
        cur = self.cur
        if cur and cur[-1]["type"] == "text":
            cur[-1]["value"] += value
        else:
            cur.append({"type": "text", "value": value})

    def leaf(self, node: dict) -> None:
        self.cur.append(node)

    def open(self, node: dict, kind: str) -> None:
        self.cur.append(node)
        self.stack.append((node, kind))

    def close_md(self, kind: str) -> None:
        # pop implicitly-closed html containers until the markdown container
        for idx in range(len(self.stack) - 1, -1, -1):
            if self.stack[idx][1] == kind:
                del self.stack[idx:]
                return

    def close_html(self, node_type: str, raw: str) -> None:
        if self.stack and self.stack[-1][1] == "html:" + node_type:
            self.stack.pop()
        else:
            self.text(raw)

    def result(self) -> list[dict]:
        return self.root


def _plain(tokens) -> str:
    out = []
    for t in tokens or ():
        if t.type in ("text", "code_inline", "html_inline", "math_inline"):
            out.append(t.content)
        elif t.type in ("softbreak", "hardbreak"):
            out.append(" ")
        elif t.children:
            out.append(_plain(t.children))
    return "".join(out)


def _build_inlines(children, *, drop_first_checkbox: bool = False) -> list[dict]:
    b = _InlineBuilder()
    skip_leading_space = False
    for idx, t in enumerate(children or ()):
        ttype = t.type
        if drop_first_checkbox and idx == 0 and ttype == "html_inline":
            skip_leading_space = True
            continue
        if ttype == "text":
            value = t.content
            if skip_leading_space:
                value = value[1:] if value.startswith(" ") else value
                skip_leading_space = False
            b.text(value)
            continue
        skip_leading_space = False
        if ttype in ("softbreak", "hardbreak"):
            b.leaf({"type": "hardbreak"})
        elif ttype == "code_inline":
            b.leaf({"type": "code_inline", "value": t.content})
        elif ttype == "math_inline":
            b.leaf({"type": "math_inline", "tex": t.content})
        elif ttype.endswith("_open") and ttype[:-5] in _MD_CONTAINERS:
            b.open({"type": _MD_CONTAINERS[ttype[:-5]], "children": []}, "md:" + ttype[:-5])
        elif ttype.endswith("_close") and ttype[:-6] in _MD_CONTAINERS:
            b.close_md("md:" + ttype[:-6])
        elif ttype == "link_open":
            href = t.attrs.get("href", "") if t.attrs else ""
            if t.markup in ("autolink", "linkify"):
                # visible text is the next text token; consume until link_close
                b.open({"type": "autolink", "href": href, "value": ""}, "md:autolink")
                b.stack[-1][0]["children"] = []
            else:
                title = t.attrs.get("title") if t.attrs else None
                b.open({"type": "link", "href": href, "title": title or None, "children": []}, "md:link")
        elif ttype == "link_close":
            if b.stack and b.stack[-1][1] == "md:autolink":
                node = b.stack[-1][0]
                node["value"] = "".join(_node_plain(c) for c in node.pop("children"))
                b.stack.pop()
            else:
                b.close_md("md:link")
        elif ttype == "image":
            src = t.attrs.get("src", "") if t.attrs else ""
            title = t.attrs.get("title") if t.attrs else None
            b.leaf({"type": "image", "src": src, "alt": _plain(t.children), "title": title or None})
        elif ttype == "footnote_ref":
            meta = t.meta or {}
            b.leaf({"type": "footnote_ref", "id": int(meta.get("id", 0)), "label": meta.get("label")})
        elif ttype == "html_inline":
            kind = _classify_html(t.content)
            if kind is None:
                b.text(t.content)
            elif kind[0] == "br":
                b.leaf({"type": "hardbreak"})
            elif kind[0] == "open":
                b.open({"type": kind[1], "children": []}, "html:" + kind[1])
            else:
                b.close_html(kind[1], t.content)
        elif t.content:
            b.text(t.content)
    return b.result()


def _html_block_inlines(raw: str) -> list[dict]:
    """An html_block printed literally, except the br/sub/sup/u allowlist."""
    b = _InlineBuilder()
    body = raw.rstrip("\n")
    for part in _HTML_SPLIT_RE.split(body):
        if not part:
            continue
        kind = _classify_html(part) if part.startswith("<") else None
        if kind is None:
            lines = part.split("\n")
            for j, line in enumerate(lines):
                if j:
                    b.leaf({"type": "hardbreak"})
                b.text(line)
        elif kind[0] == "br":
            b.leaf({"type": "hardbreak"})
        elif kind[0] == "open":
            b.open({"type": kind[1], "children": []}, "html:" + kind[1])
        else:
            b.close_html(kind[1], part)
    return b.result()


_SLUG_DROP_RE = re.compile(r"[^\w\- ]", re.UNICODE)


def _slugify(text: str, used: dict[str, int]) -> str:
    base = _SLUG_DROP_RE.sub("", unicodedata.normalize("NFC", text).strip().lower())
    base = re.sub(r" +", "-", base) or "section"
    if base not in used:
        used[base] = 0
        return base
    while True:
        used[base] += 1
        cand = f"{base}-{used[base]}"
        if cand not in used:
            used[cand] = 0
            return cand


def _cell_align(tok) -> str | None:
    style = (tok.attrs or {}).get("style", "") or ""
    m = re.search(r"text-align:\s*(left|center|right)", style)
    return m.group(1) if m else None


_BQ_MARK_RE = re.compile(r"^ {0,3}> ?")


def _strip_quote_markers(tex: str, depth: int) -> str:
    """texmath reads multi-line block math from the raw source, so inside a
    blockquote every continuation line still starts with '>' markers."""
    lines = tex.split("\n")
    for k in range(1, len(lines)):
        line = lines[k]
        for _ in range(depth):
            m = _BQ_MARK_RE.match(line)
            if not m:
                break
            line = line[m.end():]
        lines[k] = line
    return "\n".join(lines)


class _TreeBuilder:
    def __init__(self, tokens) -> None:
        self.t = tokens
        self.n = len(tokens)
        self.slugs: dict[str, int] = {}
        self.footnotes: list[dict] = []
        self.quote_depth = 0

    def blocks(self, i: int, close: str | None) -> tuple[list[dict], int]:
        t = self.t
        out: list[dict] = []
        while i < self.n:
            tok = t[i]
            ttype = tok.type
            if close is not None and ttype == close:
                return out, i + 1
            if ttype == "heading_open":
                inl = _build_inlines(t[i + 1].children)
                out.append({"type": "heading", "level": int(tok.tag[1]),
                            "id": _slugify(_plain(t[i + 1].children), self.slugs),
                            "children": inl})
                i += 3
            elif ttype == "paragraph_open":
                out.append({"type": "paragraph", "children": _build_inlines(t[i + 1].children)})
                i += 3
            elif ttype in ("fence", "code_block"):
                info = (tok.info or "").strip()
                lang = info.split()[0] if info else None
                value = tok.content[:-1] if tok.content.endswith("\n") else tok.content
                out.append({"type": "code_block", "lang": lang, "value": value})
                i += 1
            elif ttype in ("math_block", "math_block_eqno"):
                eqno = tok.info if ttype == "math_block_eqno" else None
                tex = tok.content
                if self.quote_depth and "\n" in tex:
                    tex = _strip_quote_markers(tex, self.quote_depth)
                out.append({"type": "math_block", "tex": tex, "eqno": eqno or None})
                i += 1
            elif ttype == "html_block":
                out.append({"type": "paragraph", "children": _html_block_inlines(tok.content)})
                i += 1
            elif ttype == "hr":
                out.append({"type": "hr"})
                i += 1
            elif ttype == "blockquote_open":
                self.quote_depth += 1
                children, i = self.blocks(i + 1, "blockquote_close")
                self.quote_depth -= 1
                out.append({"type": "blockquote", "children": children})
            elif ttype in ("bullet_list_open", "ordered_list_open"):
                node, i = self.list(i)
                out.append(node)
            elif ttype == "table_open":
                node, i = self.table(i)
                out.append(node)
            elif ttype == "dl_open":
                node, i = self.deflist(i)
                out.append(node)
            elif ttype == "footnote_block_open":
                i = self.footnote_block(i + 1)
            else:
                i += 1  # unknown or closing token of an outer construct
        return out, i

    def list(self, i: int) -> tuple[dict, int]:
        t = self.t
        open_tok = t[i]
        ordered = open_tok.type == "ordered_list_open"
        close = "ordered_list_close" if ordered else "bullet_list_close"
        items: list[dict] = []
        tight = True
        i += 1
        while i < self.n and t[i].type != close:
            if t[i].type != "list_item_open":
                i += 1
                continue
            item_tok = t[i]
            is_task = "task-list-item" in str((item_tok.attrs or {}).get("class", ""))
            task = None
            # Tasklist checkbox: html_inline first child of the item's first paragraph.
            j = i + 1
            if (is_task and j + 1 < self.n and t[j].type == "paragraph_open"
                    and t[j + 1].type == "inline" and t[j + 1].children
                    and t[j + 1].children[0].type == "html_inline"
                    and "task-list-item-checkbox" in t[j + 1].children[0].content):
                task = 'checked="checked"' in t[j + 1].children[0].content
            if j < self.n and t[j].type == "paragraph_open" and not t[j].hidden:
                tight = False
            if task is not None:
                first_inl = _build_inlines(t[j + 1].children, drop_first_checkbox=True)
                rest, i = self.blocks(j + 3, "list_item_close")
                children = [{"type": "paragraph", "children": first_inl}] + rest
            else:
                children, i = self.blocks(i + 1, "list_item_close")
            items.append({"type": "list_item", "task": task, "children": children})
        node: dict[str, Any]
        if ordered:
            start = 1
            if open_tok.attrs and open_tok.attrs.get("start") is not None:
                try:
                    start = int(open_tok.attrs["start"])
                except (TypeError, ValueError):
                    start = 1
            node = {"type": "ordered_list", "start": start,
                    "delimiter": ")" if open_tok.markup == ")" else ".",
                    "tight": tight, "children": items}
        else:
            node = {"type": "bullet_list", "tight": tight, "children": items}
        return node, i + 1

    def table(self, i: int) -> tuple[dict, int]:
        t = self.t
        header: list[list[dict]] = []
        rows: list[list[list[dict]]] = []
        align: list[str | None] = []
        row: list[list[dict]] | None = None
        in_head = False
        i += 1
        while i < self.n and t[i].type != "table_close":
            tok = t[i]
            if tok.type == "thead_open":
                in_head = True
            elif tok.type == "thead_close":
                in_head = False
            elif tok.type == "tr_open":
                row = []
            elif tok.type in ("th_open", "td_open"):
                inl = t[i + 1] if i + 1 < self.n and t[i + 1].type == "inline" else None
                if row is not None:
                    row.append(_build_inlines(inl.children) if inl is not None else [])
                if in_head:
                    align.append(_cell_align(tok))
            elif tok.type == "tr_close" and row is not None:
                if in_head:
                    header = row
                else:
                    rows.append(row)
                row = None
            i += 1
        ncol = len(header)
        rows = [(r + [[] for _ in range(ncol)])[:ncol] for r in rows]
        return {"type": "table", "align": align[:ncol], "header": header, "rows": rows}, i + 1

    def deflist(self, i: int) -> tuple[dict, int]:
        t = self.t
        items: list[dict] = []
        i += 1
        while i < self.n and t[i].type != "dl_close":
            tok = t[i]
            if tok.type == "dt_open":
                inl = t[i + 1] if t[i + 1].type == "inline" else None
                items.append({"type": "deflist_item",
                              "term": _build_inlines(inl.children) if inl is not None else [],
                              "definitions": []})
                while i < self.n and t[i].type != "dt_close":
                    i += 1
                i += 1
            elif tok.type == "dd_open":
                children, i = self.blocks(i + 1, "dd_close")
                if not items:
                    items.append({"type": "deflist_item", "term": [], "definitions": []})
                items[-1]["definitions"].append(children)
            else:
                i += 1
        return {"type": "deflist", "children": items}, i + 1

    def footnote_block(self, i: int) -> int:
        t = self.t
        while i < self.n and t[i].type != "footnote_block_close":
            tok = t[i]
            if tok.type == "footnote_open":
                meta = tok.meta or {}
                children, i = self.blocks(i + 1, "footnote_close")
                self.footnotes.append({"type": "footnote", "id": int(meta.get("id", len(self.footnotes))),
                                       "label": meta.get("label"), "children": children})
            else:
                i += 1
        return i + 1


def parse(markdown: str) -> dict:
    """Parse Markdown into the TREE_VERSION token tree (see module docstring)."""
    src = (markdown or "").replace("\r\n", "\n").replace("\r", "\n")
    src = _prepass_display_math(src)
    tokens = _parser().parse(src)
    builder = _TreeBuilder(tokens)
    children, _ = builder.blocks(0, None)
    footnotes = sorted(builder.footnotes, key=lambda f: f["id"])
    return {"type": "doc", "version": TREE_VERSION, "children": children, "footnotes": footnotes}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BLOCK_TYPES = {"heading", "paragraph", "code_block", "math_block", "bullet_list", "ordered_list",
                "list_item", "blockquote", "hr", "table", "deflist", "deflist_item", "footnote", "doc"}


def _node_plain(node: Any) -> str:
    if isinstance(node, list):
        return "".join(_node_plain(n) for n in node)
    if not isinstance(node, dict):
        return ""
    ntype = node.get("type")
    if ntype == "text":
        return node.get("value", "")
    if ntype == "hardbreak":
        return "\n"
    if ntype in ("code_inline", "code_block"):
        return node.get("value", "")
    if ntype in ("math_inline", "math_block"):
        return node.get("tex", "")
    if ntype == "autolink":
        return node.get("value", "")
    if ntype == "image":
        return node.get("alt", "")
    if ntype == "table":
        rows = [node.get("header", [])] + node.get("rows", [])
        return "\n".join("\t".join(_node_plain(c) for c in r) for r in rows)
    if ntype == "deflist_item":
        parts = [_node_plain(node.get("term", []))]
        parts += [_blocks_plain(d) for d in node.get("definitions", [])]
        return "\n".join(parts)
    if ntype in _BLOCK_TYPES and ntype not in ("paragraph", "heading"):
        return _blocks_plain(node.get("children", []))
    return _node_plain(node.get("children", []))


def _blocks_plain(nodes: list) -> str:
    return "\n".join(_node_plain(n) for n in nodes)


def plain_text(tree: Any) -> str:
    """Plain text of a tree, a node or a node list (blocks separated by newlines).

    Footnote definitions of a doc are appended after its body.
    """
    if isinstance(tree, dict) and tree.get("type") == "doc":
        parts = [_blocks_plain(tree.get("children", []))]
        if tree.get("footnotes"):
            parts.append(_blocks_plain(tree["footnotes"]))
        return "\n".join(p for p in parts if p)
    return _node_plain(tree)


def first_h1_text(tree: dict) -> str | None:
    """Text of the first level-1 heading in document order, whitespace-normalised."""
    def walk(nodes):
        for n in nodes:
            if not isinstance(n, dict):
                continue
            if n.get("type") == "heading" and n.get("level") == 1:
                return n
            for key in ("children",):
                sub = n.get(key)
                if isinstance(sub, list) and n.get("type") not in ("paragraph", "heading"):
                    found = walk(sub)
                    if found is not None:
                        return found
        return None

    node = walk(tree.get("children", []) if isinstance(tree, dict) else [])
    if node is None:
        return None
    text = " ".join(_node_plain(node.get("children", [])).split())
    return text or None


def count_table_rows(tree: dict) -> int:
    """Total body rows of every table (header rows excluded).

    Tables inside code blocks do not exist in the tree, so pipe lines in
    fenced or indented code are never counted.
    """
    total = 0
    stack = [tree]
    while stack:
        n = stack.pop()
        if isinstance(n, list):
            stack.extend(n)
            continue
        if not isinstance(n, dict):
            continue
        if n.get("type") == "table":
            total += len(n.get("rows", []))
            continue
        for key in ("children", "footnotes", "definitions"):
            sub = n.get(key)
            if isinstance(sub, list):
                stack.append(sub)
    return total
