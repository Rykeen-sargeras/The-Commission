FROM node:22-bookworm-slim AS python-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential git pkg-config libopenblas-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/neutts-venv
ENV PATH="/opt/neutts-venv/bin:${PATH}"
ENV CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS"
ENV FORCE_CMAKE=1
COPY requirements-tts.txt /tmp/requirements-tts.txt
RUN pip install --no-cache-dir --upgrade pip setuptools wheel "cmake>=3.26" ninja \
    && pip install --no-cache-dir -r /tmp/requirements-tts.txt \
    && python -c "from neutts import NeuTTS2E; print('NeuTTS import check passed')"

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ffmpeg libopenblas0-pthread libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10

COPY --from=python-build /opt/neutts-venv /opt/neutts-venv
ENV PATH="/opt/neutts-venv/bin:${PATH}"
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY . .

CMD ["node", "railway_start.js"]
