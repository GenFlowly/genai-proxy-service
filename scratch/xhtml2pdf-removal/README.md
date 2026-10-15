# xhtml2pdf removal (PDF plan 5.2, last stage)

Four commits, held back until the Typst canary has run its course. They
remove the x2p_v1 renderer and its dependency closure (xhtml2pdf, reportlab,
svglib, pyHanko, Markdown and friends), so every PDF renders with Typst, and a
durable run pinned to `x2p_v1` before the deploy renders with Typst too.

1. `0001` builds the PDF test fixtures without reportlab
2. `0002` renders every PDF with Typst and removes x2p_v1 (charset tables,
   the HTML path, the x2p baseline fixtures)
3. `0003` drops xhtml2pdf, reportlab, Markdown and their closure from
   requirements.txt and constraints.txt
4. `0004` updates the docs

## When

Typst is already the default renderer; xhtml2pdf stays only as the
`PDF_RENDERER=x2p_v1` rollback. Apply this once production has rendered with
Typst for a week or two without needing that rollback (check the
`pdf_render_*` metrics), since afterwards a rollback means reverting.

## Applying

The baseline fixtures the series deletes have CRLF line endings, so keep them:

```bash
git am --keep-cr scratch/xhtml2pdf-removal/*.patch
```

Then bump `DBOS_APP_VERSION` for the retrieval-server deploy (the tool's step
outputs change), rebuild the image (the Dockerfile's `--selftest` checks Typst
and PDFium only), and delete this directory in the same change.

## Verified

Applied with `git am --keep-cr` onto fb46096, the series gives a
retrieval-server tree identical to the one tested: 994 tests, 0 failures
(17 skipped), with xhtml2pdf, reportlab, Markdown, svglib, pyHanko and their
helpers made unimportable during the run, so nothing still depends on them.
It also applies cleanly onto a41b23c; run the suite again after applying it.
