# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- builder
FROM node:26-bookworm-slim AS builder

WORKDIR /app

# Manifests first so the install layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY e2e/package.json e2e/package.json

RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web

ARG CELLAR_VERSION=0.1.0
ENV CELLAR_VERSION=${CELLAR_VERSION}

RUN npm run build -w shared \
  && npm run build -w server \
  && npm run build -w web

# Drop dev dependencies but keep the workspace symlinks intact.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- tools
# Baseline media tools, every download checksum verified where the publisher
# ships a checksum file. At boot the server copies the binaries into
# /data/bin when absent (server/src/media/tools.ts); the tool updater replaces
# them there, so these are only the floor a fresh install starts from.
FROM node:26-bookworm-slim AS tools

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp: the standalone yt-dlp_linux build (PyInstaller onefile, so no python
# in the image), verified against the release's SHA2-256SUMS. A onefile build
# unpacks itself into $TMPDIR (default /tmp) on every run, so /tmp must stay
# writable and must not be mounted noexec.
RUN set -eux; \
  mkdir -p /opt/cellar/bin /tmp/ytdlp; \
  cd /tmp/ytdlp; \
  base="https://github.com/yt-dlp/yt-dlp/releases/latest/download"; \
  curl -fsSL --retry 3 -o yt-dlp_linux "$base/yt-dlp_linux"; \
  curl -fsSL --retry 3 -o SHA2-256SUMS "$base/SHA2-256SUMS"; \
  grep -E '  yt-dlp_linux$' SHA2-256SUMS | sha256sum -c -; \
  install -m 0755 yt-dlp_linux /opt/cellar/bin/yt-dlp; \
  rm -rf /tmp/ytdlp

# ffmpeg + ffprobe: BtbN master GPL static build (libsvtav1 for the software
# AV1 path, nvenc loaded at runtime when the GPU is passed through), verified
# against the release's checksums.sha256.
RUN set -eux; \
  mkdir -p /tmp/ffmpeg; \
  cd /tmp/ffmpeg; \
  base="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"; \
  name="ffmpeg-master-latest-linux64-gpl.tar.xz"; \
  curl -fsSL --retry 3 -o "$name" "$base/$name"; \
  curl -fsSL --retry 3 -o checksums.sha256 "$base/checksums.sha256"; \
  grep -E "  $name\$" checksums.sha256 | sha256sum -c -; \
  tar -xJf "$name" --strip-components=2 -C /opt/cellar/bin \
    "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg" \
    "ffmpeg-master-latest-linux64-gpl/bin/ffprobe"; \
  chmod 0755 /opt/cellar/bin/ffmpeg /opt/cellar/bin/ffprobe; \
  rm -rf /tmp/ffmpeg

# bgutil PO token provider, yt-dlp side. Facts from the bgutil README and the
# yt-dlp README (Installing Plugins), checked 2026-10-18:
#   - release asset bgutil-ytdlp-pot-provider.zip; its root is the
#     yt_dlp_plugins/ namespace folder. The release ships no checksum file,
#     so this download is TLS-trusted only.
#   - a plugin package lives at <plugin dir>/<package name>/yt_dlp_plugins/.
#     yt-dlp searches a yt-dlp-plugins/ folder next to its executable, but the
#     server runs yt-dlp from /data/bin, so the runner must pass
#     --plugin-dirs /opt/cellar/yt-dlp-plugins explicitly.
#   - extractor args: youtubepot-bgutilhttp:base_url=<POT_PROVIDER_URL>
#     (the sidecar's HTTP server listens on 4416 by default).
#   - needs yt-dlp 2025.05.22 or newer.
#   - verified in the built image: with --plugin-dirs the provider registers
#     as bgutil:http (yt-dlp -v lists it under "PO Token Providers").
#   - yt-dlp finds no JS runtime by default ("JS runtimes: none"); the image's
#     node is picked up with --js-runtimes node, which the runner should pass.
#   - the plugin and the brainicism/bgutil-ytdlp-pot-provider sidecar are a
#     matched pair; both track "latest", so a rebuild of one without the other
#     can drift.
RUN set -eux; \
  mkdir -p /opt/cellar/yt-dlp-plugins/bgutil-ytdlp-pot-provider /tmp/bgutil; \
  cd /tmp/bgutil; \
  curl -fsSL --retry 3 -o bgutil.zip \
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip"; \
  unzip -q bgutil.zip -d /opt/cellar/yt-dlp-plugins/bgutil-ytdlp-pot-provider; \
  test -f /opt/cellar/yt-dlp-plugins/bgutil-ytdlp-pot-provider/yt_dlp_plugins/extractor/getpot_bgutil_http.py; \
  rm -rf /tmp/bgutil

# Readable and executable by any uid: the container runs as whatever uid the
# compose file picks (3100 on the NAS) and that uid has no passwd entry.
RUN chmod -R a+rX /opt/cellar

# ---------------------------------------------------------------- runtime
FROM node:26-bookworm-slim AS runtime

# curl is the healthcheck; xz-utils lets the tool updater unpack ffmpeg builds.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tools /opt/cellar /opt/cellar

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./web/dist

ARG CELLAR_VERSION=0.1.0

# HOME and the cache live on the data volume: the runtime uid has no passwd
# entry and the image filesystem may be read only. /data/bin comes first so an
# updated tool shadows the baseline copy.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    HOME=/data \
    XDG_CACHE_HOME=/data/cache \
    PATH=/data/bin:/opt/cellar/bin:$PATH \
    CELLAR_VERSION=${CELLAR_VERSION}

# Both volumes are created and owned by the host. Everything under /app (npm
# and tsc output, umask 022) and /opt/cellar is world readable, so the
# container runs fine as any uid the compose file picks.
VOLUME ["/data", "/media"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server/dist/index.js"]
