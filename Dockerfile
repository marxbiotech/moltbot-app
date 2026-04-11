FROM ghcr.io/marxbiotech/openclaw:2026.3.28-beta.1

USER root

# Tailscale CLI is provided by the sidecar container via shared volume.
# A symlink ensures OpenClaw can find it in PATH.
RUN ln -s /opt/tailscale/tailscale /usr/local/bin/tailscale

# Extensions that require image-bundling (PATH scripts, SDK dependencies)
COPY image-extensions/ /app/extensions/

# Install per-extension npm dependencies
RUN cd /app/extensions/github-apps && npm install --production --ignore-scripts 2>/dev/null || true

USER node
