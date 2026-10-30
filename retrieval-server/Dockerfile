## Stage 1: compile Python packages that need C extensions
FROM python:3.11-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
# Install from the exact-pin lock (compiled from requirements.txt by
# scripts/compile-python-locks.sh) so a rebuild can never silently
# re-resolve dependencies.
COPY requirements.lock.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.lock.txt

## Stage 2: lean runtime image
FROM python:3.11-slim
WORKDIR /app

COPY --from=builder /install /usr/local
COPY app.py .
COPY content_logging.py .
COPY durable_runtime.py .
COPY run_events.py .
COPY runs.py .
COPY models.py .
COPY streaming.py .
COPY routes/ ./routes/
COPY graph/ ./graph/
COPY graph_tools/ ./graph_tools/
COPY voice/ ./voice/

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')" || exit 1

# python app.py, not the uvicorn CLI: the app builds a dual-stack (v4+v6)
# socket itself — `uvicorn --host ::` is IPv6-only, which breaks Fly's
# IPv4 metrics scrape (see app.py __main__).
CMD ["python", "app.py"]

