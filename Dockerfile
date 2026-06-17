FROM python:3.11-slim

# Install system deps for pyarrow/pandas (avoids compilation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for layer caching
COPY requirements.txt .

# Upgrade pip and install — pre-built wheels from PyPI, no source compilation
RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy app files
COPY server.py .
COPY index.html .
COPY style.css .
COPY script.js .
COPY logo.png .

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
