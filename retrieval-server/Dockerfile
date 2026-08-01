## Stage 1: compile Python packages that need C extensions
FROM python:3.11-slim AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
# Install torch in its own layer — heavy and rarely changes, so it stays cached
# even when requirements.txt is updated.
RUN pip install --no-cache-dir --prefix=/install torch --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

## Stage 2: lean runtime image
FROM python:3.11-slim
WORKDIR /app

COPY --from=builder /install /usr/local
COPY app.py .
COPY models.py .
COPY streaming.py .
COPY routes/ ./routes/
COPY graph/ ./graph/

# Model cache lives on a mounted volume so it persists across restarts
# and is never downloaded at build time
ENV HF_HOME=/app/model_cache

RUN mkdir -p /app/model_cache

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5001/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "::", "--port", "5001", "--workers", "1"]

