"""What the bridge renderer (xhtml2pdf, "x2p_v1") can and cannot draw.

xhtml2pdf draws text only with the standard-14 PDF fonts: Helvetica for body
text and Courier for code (generate_pdf.py _CSS). reportlab gives those two
fonts two fallback fonts, Symbol and ZapfDingbats (reportlab
pdfmetrics.standardT1SubstitutionFonts). A character that none of WinAnsi
(cp1252, minus DEL), Symbol and ZapfDingbats encodes becomes a ZapfDingbats
box, and the PDF still renders "successfully".

So:
- Unaccented Greek letters, arrows, <= >= minus, sums, infinity, check marks,
  crosses, stars and circled digits are drawn, through Symbol or ZapfDingbats
  (in a different face).
- Accented Greek (U+03AC...), Cyrillic, Latin Extended (e.g. U+0141), Arabic,
  Hebrew, every Indic script, CJK, Thai, U+2011, zero-width characters and
  most emoji are boxes.

The tables below are the encodable code points of reportlab 5.0.1's
'winansi', 'symbol' and 'zapfdingbats' codecs, as ranges, so this check runs
in the server process without importing reportlab (rendering happens in a
worker child). tests/test_generate_pdf.py compares them against reportlab's
codecs.

`find_undrawable(text)` drives plan item 1.14 (the honest-limits note) and
the 2.1 script route (documents whose letters x2p_v1 cannot draw go to
Typst). Stdlib only, like the rest of graph_tools.
"""
import bisect
import unicodedata
from dataclasses import dataclass, field

_WINANSI_RANGES = (
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x0152, 0x0153), (0x0160, 0x0161), (0x0178, 0x0178),
    (0x017D, 0x017E), (0x0192, 0x0192), (0x02C6, 0x02C6), (0x02DC, 0x02DC), (0x2013, 0x2014),
    (0x2018, 0x201A), (0x201C, 0x201E), (0x2020, 0x2022), (0x2026, 0x2026), (0x2030, 0x2030),
    (0x2039, 0x203A), (0x20AC, 0x20AC), (0x2122, 0x2122),
)

_SYMBOL_RANGES = (
    (0x0020, 0x0021), (0x0023, 0x0023), (0x0025, 0x0026), (0x0028, 0x0029), (0x002B, 0x002C),
    (0x002E, 0x003F), (0x005B, 0x005B), (0x005D, 0x005D), (0x005F, 0x005F), (0x007B, 0x007D),
    (0x00AC, 0x00AC), (0x00B0, 0x00B1), (0x00B5, 0x00B5), (0x00D7, 0x00D7), (0x00F7, 0x00F7),
    (0x0192, 0x0192), (0x0391, 0x03A1), (0x03A3, 0x03A9), (0x03B1, 0x03C9), (0x03D1, 0x03D2),
    (0x03D5, 0x03D6), (0x2022, 0x2022), (0x2026, 0x2026), (0x2032, 0x2033), (0x2044, 0x2044),
    (0x20AC, 0x20AC), (0x2111, 0x2111), (0x2118, 0x2118), (0x211C, 0x211C), (0x2126, 0x2126),
    (0x2135, 0x2135), (0x2190, 0x2194), (0x21B5, 0x21B5), (0x21D0, 0x21D4), (0x2200, 0x2200),
    (0x2202, 0x2203), (0x2205, 0x2209), (0x220B, 0x220B), (0x220F, 0x220F), (0x2211, 0x2212),
    (0x2217, 0x2217), (0x221A, 0x221A), (0x221D, 0x221E), (0x2220, 0x2220), (0x2227, 0x222B),
    (0x2234, 0x2234), (0x223C, 0x223C), (0x2245, 0x2245), (0x2248, 0x2248), (0x2260, 0x2261),
    (0x2264, 0x2265), (0x2282, 0x2284), (0x2286, 0x2287), (0x2295, 0x2295), (0x2297, 0x2297),
    (0x22A5, 0x22A5), (0x22C5, 0x22C5), (0x2320, 0x2321), (0x2329, 0x232A), (0x25CA, 0x25CA),
    (0x2660, 0x2660), (0x2663, 0x2663), (0x2665, 0x2666), (0xF6D9, 0xF6DB), (0xF8E5, 0xF8FE),
)

_ZAPFDINGBATS_RANGES = (
    (0x0020, 0x0020), (0x2192, 0x2192), (0x2194, 0x2195), (0x2460, 0x2469), (0x25A0, 0x25A0),
    (0x25B2, 0x25B2), (0x25BC, 0x25BC), (0x25C6, 0x25C6), (0x25CF, 0x25CF), (0x25D7, 0x25D7),
    (0x2605, 0x2605), (0x260E, 0x260E), (0x261B, 0x261B), (0x261E, 0x261E), (0x2660, 0x2660),
    (0x2663, 0x2663), (0x2665, 0x2666), (0x2701, 0x2704), (0x2706, 0x2709), (0x270C, 0x2727),
    (0x2729, 0x274B), (0x274D, 0x274D), (0x274F, 0x2752), (0x2756, 0x2756), (0x2758, 0x275E),
    (0x2761, 0x2794), (0x2798, 0x27AF), (0x27B1, 0x27BE),
)


def _flatten(*groups):
    merged = sorted(r for g in groups for r in g)
    out: list[tuple[int, int]] = []
    for lo, hi in merged:
        if out and lo <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


_DRAWABLE = _flatten(_WINANSI_RANGES, _SYMBOL_RANGES, _ZAPFDINGBATS_RANGES)
_DRAWABLE_STARTS = [lo for lo, _ in _DRAWABLE]


def x2p_can_draw(ch: str) -> bool:
    """Whether x2p_v1 draws `ch` with a real glyph (any of the three fonts)."""
    cp = ord(ch)
    i = bisect.bisect_right(_DRAWABLE_STARTS, cp) - 1
    return i >= 0 and _DRAWABLE[i][0] <= cp <= _DRAWABLE[i][1]


# Emoji parts that ride along with a symbol rather than being letters of a
# script: variation selectors (U+FE0F turns '⚠' into '⚠️'; category Mn),
# the combining keycap U+20E3 (Me), skin-tone modifiers (Sk) and the zero
# width joiner. They count with the symbols, never as a script.
def _emoji_component(cp: int) -> bool:
    return (
        0xFE00 <= cp <= 0xFE0F
        or 0xE0100 <= cp <= 0xE01EF
        or cp == 0x20E3
        or 0x1F3FB <= cp <= 0x1F3FF
        or cp == 0x200D
        or 0xE0020 <= cp <= 0xE007F  # tag characters (flag sequences)
    )


# First word(s) of a Unicode character name -> the script name we tell the
# user. Order matters only for the multi-word prefixes listed first.
_SCRIPT_PREFIXES = (
    ("CJK", "Chinese/Japanese (Han)"),
    ("HIRAGANA", "Japanese"),
    ("KATAKANA", "Japanese"),
    ("HALFWIDTH KATAKANA", "Japanese"),
    ("HANGUL", "Korean"),
    ("BOPOMOFO", "Chinese (Bopomofo)"),
    ("ARABIC", "Arabic"),
    ("HEBREW", "Hebrew"),
    ("SYRIAC", "Syriac"),
    ("THAANA", "Thaana"),
    ("DEVANAGARI", "Devanagari (Hindi, Marathi, Nepali)"),
    ("BENGALI", "Bengali"),
    ("GURMUKHI", "Gurmukhi (Punjabi)"),
    ("GUJARATI", "Gujarati"),
    ("ORIYA", "Odia"),
    ("TAMIL", "Tamil"),
    ("TELUGU", "Telugu"),
    ("KANNADA", "Kannada"),
    ("MALAYALAM", "Malayalam"),
    ("SINHALA", "Sinhala"),
    ("THAI", "Thai"),
    ("LAO", "Lao"),
    ("KHMER", "Khmer"),
    ("MYANMAR", "Myanmar"),
    ("TIBETAN", "Tibetan"),
    ("GEORGIAN", "Georgian"),
    ("ARMENIAN", "Armenian"),
    ("ETHIOPIC", "Ethiopic"),
    ("GREEK", "Greek"),
    ("COPTIC", "Coptic"),
    ("CYRILLIC", "Cyrillic"),
    ("LATIN", "Latin (accented)"),
    ("FULLWIDTH LATIN", "Latin (accented)"),
)


def script_of(ch: str) -> str:
    """A user-facing script name for a letter/mark/digit, 'other' if unknown."""
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "other"
    for prefix, script in _SCRIPT_PREFIXES:
        if name.startswith(prefix + " ") or name == prefix:
            return script
    return "other"


@dataclass
class Undrawable:
    """What x2p_v1 would draw as boxes. Counts only; never the text itself."""

    # Letters, marks and digits by script name -> count. These trigger the
    # 1.14 note and the 2.1 script route.
    scripts: dict = field(default_factory=dict)
    # Undrawable symbols, punctuation and format characters (category S, P,
    # Cf, emoji parts): counted, no note.
    symbols: int = 0
    # The undrawable letters/marks/digits themselves, for font-coverage
    # checks by the Typst route (never logged).
    letters: set = field(default_factory=set)

    @property
    def has_unsupported_letters(self) -> bool:
        return bool(self.scripts)


def find_undrawable(text: str) -> Undrawable:
    """Classify every character x2p_v1 cannot draw.

    Spaces of any kind render as spaces and controls are not drawn, so both
    are ignored. A combining mark counts with the script of the letter it
    follows."""
    result = Undrawable()
    last_script = "other"
    for ch in text:
        cp = ord(ch)
        if cp < 0x20 or cp == 0x7F:
            continue
        category = unicodedata.category(ch)
        if category.startswith("Z"):
            continue
        if category[0] in "LN":
            last_script = script_of(ch)
        if x2p_can_draw(ch):
            continue
        if _emoji_component(cp):
            result.symbols += 1
            continue
        if category[0] in "LMN":
            script = last_script if category[0] == "M" else script_of(ch)
            result.scripts[script] = result.scripts.get(script, 0) + 1
            result.letters.add(ch)
        else:
            result.symbols += 1
    return result


def unsupported_script_note(undrawable: Undrawable) -> str | None:
    """The 1.14 sentence appended to the tool result, or None."""
    if not undrawable.has_unsupported_letters:
        return None
    names = sorted(undrawable.scripts, key=lambda s: (-undrawable.scripts[s], s))
    listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    return (
        f"Note: this PDF contains {listed} text that the current PDF renderer "
        "cannot display correctly (it will show as boxes). Tell the user, and "
        "offer to give the text in the chat instead."
    )
