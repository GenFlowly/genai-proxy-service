# Bundled PDF fonts

The Typst PDF renderer (`graph_tools/tools/pdf_typst.py`) draws text only with
the fonts in this directory: it compiles with `ignore_system_fonts=True`, so the
output does not depend on what the host or image happens to have installed.

The font binaries are **not committed** (see `.gitignore`). They are fetched,
verified and extracted by `scripts/fetch_fonts.py` from the npm tarballs pinned
in `fonts.lock.json`. Committed here: the lock file, `OFL.txt` (the SIL Open
Font License 1.1 with every family's copyright notice), `coverage.json` and
this README.

`coverage.json` is the merged list of code point ranges the bundled fonts map
to a glyph (read from each font's `cmap` table), written by `fetch_fonts.py`
and checked by `fetch_fonts.py --check`. `pdf_typst.fonts_cover(chars)` and
`pdf_typst.uncovered_characters(text)` read it, so the server can decide
whether every script in a document has a bundled font without importing typst
or loading a font file. Regenerate it whenever the lock changes.

## Fetch

From `retrieval-server/`:

```sh
python scripts/fetch_fonts.py                 # download what is missing, verify everything
python scripts/fetch_fonts.py --check         # verify only (no network); exit 1 on a mismatch
python scripts/fetch_fonts.py --cache-dir ~/.cache/genflowly-fonts   # keep verified tarballs
```

The script is stdlib-only. For every package it downloads
`https://registry.npmjs.org/<name>/-/<name>-<version>.tgz`, checks the
tarball against the pinned npm `integrity` (sha512), reads only the listed TTF
members (no `extractall`), checks each against its pinned `sha256`, and writes
it here atomically. A re-run with every file present is a no-op. About 160 MB
of tarballs are downloaded on a cold run (the CJK packages carry every weight);
56 MB of fonts are kept.

Docker and CI must run it before the image is built or the render tests run
(the tests that need fonts skip with a message when they are missing):

```sh
cd retrieval-server && python scripts/fetch_fonts.py && python scripts/fetch_fonts.py --check
```

## What is bundled

| Family | Styles | Covers |
|---|---|---|
| Noto Sans | Regular, Bold, Italic, Bold Italic | Latin incl. Extended and Vietnamese, Greek, Cyrillic |
| Noto Sans Mono | Regular, Bold | code |
| Noto Sans Symbols 2 | Regular | arrows, ballot boxes (☐ ☑), dingbats, misc. symbols |
| Noto Sans Math | Regular | math operators and letterlike symbols in prose |
| Noto Color Emoji | Regular (COLRv1) | emoji, in colour |
| Noto Sans Arabic, Hebrew, Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Thai | Regular, Bold | RTL and every major Indic script, Thai |
| Noto Sans SC, JP, KR | Regular, Bold | Chinese, Japanese, Korean |

Math is typeset with Typst's built-in New Computer Modern Math (embedded in the
typst wheel); the renderer orders the CJK fonts per document (Hangul: KR first,
kana: JP first, otherwise SC) so Japanese is not drawn with Chinese glyph forms.

The source packages are `@expo-google-fonts/*` (MIT packaging, fonts under
OFL 1.1), which republish Google Fonts' static TTF instances; GitHub and
fonts.google.com downloads are not needed. The plan called for CFF OTF; these
are TrueType-outline TTFs, which Typst handles the same way.

### Noto Color Emoji

The Google Fonts build of Noto Color Emoji carries both a COLRv1 table and a
20 MB `SVG ` table. Typst 0.15 draws the COLRv1 glyphs (verified: the emoji
render in colour and the PDF is byte-identical with or without the SVG table),
and when only the SVG table is present it needs about 4.6 CPU-s for one line of
emoji. The lock entry therefore sets `drop_tables: ["SVG "]`: `fetch_fonts.py`
rewrites the sfnt table directory without that table (no glyph changes) and
checks the result against `output_sha256`. The file is named
`NotoColorEmoji_400Regular-COLRv1.ttf` to mark it as a modified version; Noto
Color Emoji declares no Reserved Font Name, so OFL 1.1 permits this.

## Bumping a package

1. Pick a version that has been published for at least two weeks and get its
   integrity: `npm view @expo-google-fonts/<pkg>@<version> dist.integrity`.
2. Set `version` and `integrity` in `fonts.lock.json`.
3. Download the tarball, compute the sha256 of each listed member (and of the
   rewritten emoji font for `output_sha256`), and update the lock.
4. Run `python scripts/fetch_fonts.py` and the PDF tests
   (`python -m unittest tests.test_pdf_typst`), which check glyph coverage.
