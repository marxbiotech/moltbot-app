FROM ghcr.io/openclaw/openclaw:2026.3.23

USER root

# Install Tailscale (pinned to stable version matching sidecar image)
ENV TAILSCALE_VERSION=1.94.2
RUN curl -fsSL https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_$(dpkg --print-architecture).tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 \
      tailscale_${TAILSCALE_VERSION}_$(dpkg --print-architecture)/tailscale

# Copy custom extensions into the app extensions directory
COPY extensions/ /app/extensions/

USER node
