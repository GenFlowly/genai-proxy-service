## Stage 1: compile Python packages that need C extensions
FROM python:3.11-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt constraints.txt ./
# constraints.txt pins the PDF-only dependency closure; CI installs with the
# same command so tests and the image resolve the same renderer.
RUN pip install --no-cache-dir --prefix=/install -c constraints.txt -r requirements.txt

## Stage 1b: the Typst renderer's fonts (plan 5.1): npm tarballs pinned by
## integrity hash in fonts.lock.json, each extracted font checked against its
## sha256. Keyed only on the lock file and the script, so code changes reuse
## this layer. Needs network access to registry.npmjs.org.
FROM python:3.11-slim AS fonts
WORKDIR /fonts
COPY scripts/fetch_fonts.py scripts/
COPY graph_tools/fonts/fonts.lock.json graph_tools/fonts/
RUN python scripts/fetch_fonts.py

## Stage 2: lean runtime image
FROM python:3.11-slim
WORKDIR /app

COPY --from=builder /install /usr/local
COPY app.py .
COPY content_logging.py .
COPY durable_runtime.py .
COPY run_events.py .
COPY runs.py .
COPY tool_ledger.py .
COPY durable_metrics.py .
COPY models.py .
COPY streaming.py .
COPY routes/ ./routes/
COPY graph/ ./graph/
COPY graph_tools/ ./graph_tools/
COPY --from=fonts /fonts/graph_tools/fonts/*.ttf ./graph_tools/fonts/
COPY voice/ ./voice/

# Smoke render (plan 1.1): the PDF worker child must start, lock itself down
# (rlimits, seccomp), render with every renderer this image ships (x2p_v1,
# and Typst with the bundled fonts and vendored mitex: a mixed-script page
# with no missing glyph) and parse a PDF with PDFium, or the build fails here
# instead of every generate_pdf call failing in production.
RUN python -E -s -m graph.pdf_render_child --selftest

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')" || exit 1

# python app.py, not the uvicorn CLI: the app builds a dual-stack (v4+v6)
# socket itself — `uvicorn --host ::` is IPv6-only, which breaks Fly's
# IPv4 metrics scrape (see app.py __main__).
CMD ["python", "app.py"]

