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

After the canary stages in retrieval-server/development.md ("Choosing the
renderer"): internal tenants on `PDF_RENDERER_CANARY=typst` for at least 7
days, `PDF_RENDERER_SCRIPT_ROUTE=typst` for everyone for at least 14 days, then
`PDF_RENDERER=typst` in production. Compare the `pdf_render_*` metrics by
renderer at each stage first.

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
