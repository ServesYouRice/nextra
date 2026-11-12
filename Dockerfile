# syntax=docker/dockerfile:1
# Server image for Nextra: the same app the desktop package runs, for a Linux
# server. One process, no database; every setting comes from the environment
# at start (config.js), so one image serves any host.
#
# The base is pinned by digest. Raise the tag and the digest together.
ARG NODE_IMAGE=node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# mediasoup fetches its prebuilt media worker for this platform during install.
# Optional build-only CA for TLS-inspecting proxies; mounted, never stored.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm_config_cafile=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
# Build the client, then drop everything only the build and the tests needed.
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
# ffmpeg carries the video-over-HTTP relay; tini is PID 1 so signals reach node
# and finished ffmpeg children are reaped. Pending security updates of the
# base image's own packages are applied in the same step. apt downloads as its
# own user, so the optional build-only CA is mounted world-readable here.
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources; \
      APT_CA="-o Acquire::https::CAInfo=/run/secrets/build_ca"; \
    fi; \
    apt-get ${APT_CA:-} update \
    && apt-get ${APT_CA:-} upgrade -y \
    && apt-get ${APT_CA:-} install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
# The app runs only `node`. The package managers the base image bundles are
# never used here and carry their own dependencies, so they are removed.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# A server has no desktop to open and is restarted by its supervisor: when the
# media worker dies the process exits non-zero instead of respawning itself.
ENV NODE_ENV=production \
    PORT=3000 \
    OPEN_BROWSER=false \
    AUTO_PUBLIC_TUNNEL=false \
    EXTERNAL_SUPERVISOR=true
WORKDIR /app
# The same files the desktop package ships (scripts/package-app.js), owned by
# root and read-only to the runtime user.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json server.js config.js LICENSE README.md SOURCE.md THIRD_PARTY_NOTICES.md ./
COPY lib ./lib
COPY licenses ./licenses
ARG REVISION=unknown
LABEL org.opencontainers.image.title="nextra" \
      org.opencontainers.image.source="https://github.com/ServesYouRice/nextra" \
      org.opencontainers.image.revision="${REVISION}"
USER 1000:1000
# 3000: the page, the signalling socket and the video-over-HTTP relay.
# 40000-40001: WebRTC media, UDP and TCP. They must be reachable from viewers,
# so run with host networking or publish them on the same numbers.
EXPOSE 3000 40000-40001/udp 40000-40001/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
