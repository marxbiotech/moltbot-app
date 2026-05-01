FROM ghcr.io/marxbiotech/openclaw:2026.4.26-beta.1

USER root

# Tailscale CLI is provided by the sidecar container via shared volume.
# A symlink ensures OpenClaw can find it in PATH.
RUN ln -s /opt/tailscale/tailscale /usr/local/bin/tailscale

# Extensions that require image-bundling (PATH scripts, SDK dependencies).
# Land outside /app so the new OpenClaw loader does not classify these paths
# as the upstream package's legacy bundled-plugin alias and silently ignore
# them in plugins.load.paths.
COPY image-extensions/ /opt/moltbot/extensions/

# Install per-extension npm dependencies
RUN cd /opt/moltbot/extensions/github-apps && npm install --production --ignore-scripts 2>/dev/null || true

USER node
