# Vendored Typst packages

`pdf_typst.py` compiles with `package_path` set to this directory and
`package_cache_path` set to an empty read-only directory, so Typst resolves
`@preview/<name>:<version>` only from here and never downloads anything.
Typst looks packages up as `<package_path>/<namespace>/<name>/<version>/`.

## mitex 0.2.7

LaTeX math to Typst math, used for `\( \)` and `\[ \]` in generated PDFs.

- Source: `https://packages.typst.org/preview/mitex-0.2.7.tar.gz` (the Typst
  Universe registry; upstream repository https://github.com/mitex-rs/mitex).
  Downloaded on 2026-10-14 and copied byte-for-byte into
  `preview/mitex/0.2.7/`; nothing was added to or removed from that directory.
- License: Apache-2.0 (`typst.toml`). The registry tarball carries no license
  file, so the license text is kept next to it as `LICENSE-mitex-Apache-2.0.txt`.
- `mitex.wasm` runs inside Typst's WebAssembly plugin sandbox (no file system,
  no network). The package evaluates the converted math with `eval`
  (`mitex.typ:27` and `:34`; `\raisebox`, `\hspace` and `\vspace` in
  `specs/latex/standard.typ` evaluate their argument as Typst code). Measured
  on 0.2.7: the converter escapes `#`, quotes and brackets in `\text`,
  `\mathrm`, `\operatorname` and plain math, and a `read()` reached through an
  evaluated argument resolves inside this package directory, not the render
  root. The renderer still keeps those paths closed: `\raisebox`, `\hspace` and
  `\vspace` are passed to mitex only with a plain TeX length, `\includegraphics`
  never, equations are capped in size, each distinct equation is checked in a
  small separate compile (raw TeX is printed on failure), and the per-render
  root holds nothing but the document's own images. `tests/test_pdf_typst.py`
  has the escaping test.

| File | sha256 |
|---|---|
| `lib.typ` | `b83008d32114fa6f0b81df7684fc15ad9a0718e952b566564b2b56ae0fc7cd89` |
| `mitex.typ` | `da42e95fd8e19c734069379f8890ccebf0c48ff3a1a3469b6ec2f01e7fc36871` |
| `mitex.wasm` | `f30000cbc2b18a6cdc72c3ce539d3ac443faa9109b4e0272cd274b37c6c1cff7` |
| `specs/latex/standard.typ` | `6fab6c35ede2e87d090c4ad7d9223d9544f6a3e0815ecf1788a7a0b3393af060` |
| `specs/mod.typ` | `2304c350546cef345a6130db236b5359836cfde11f4337636e13ad60a006ebf4` |
| `specs/prelude.typ` | `3a6de0070bf294167d43d09b4c633029512d9cfdb4eaf7a729ce5fe75e58515d` |
| `typst.toml` | `8c30fad1454efbfe72aaf241f5ced8c8103fec7e2790f9b1ebef0e01e335503c` |

Verify (from `retrieval-server/`):

```sh
python scripts/verify_mitex.py              # pinned hashes, then the upstream tarball when reachable
python scripts/verify_mitex.py --offline    # pinned hashes only
```

When packages.typst.org cannot be reached the upstream comparison is reported
as skipped and the script still exits 0 (`--require-upstream` makes it fail).
To upgrade, replace the directory with the new version's tarball contents,
update the import in `graph_tools/tools/pdf_template.typ`, and update the pins
here and in `scripts/verify_mitex.py`.
