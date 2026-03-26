FROM ghcr.io/openclaw/openclaw:2026.3.23

USER root

# Install Tailscale
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Copy custom extensions into the app extensions directory
COPY extensions/ /app/extensions/

USER node
