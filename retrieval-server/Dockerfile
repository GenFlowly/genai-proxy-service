FROM python:3.11-slim

WORKDIR /app

# Install dependencies needed by pymilvus, sentence-transformers
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY app.py .

# Expose port (default 5001)
EXPOSE 5001

CMD ["gunicorn", "--bind", "0.0.0.0:5001", "app:app", "--workers", "1", "--threads", "2", "--timeout", "120"]
