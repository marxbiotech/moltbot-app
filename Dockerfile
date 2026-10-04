FROM ghcr.io/marxbiotech/openclaw:mb2026.9.5

USER root

# Official CLI artifacts pinned by version AND checksum for both published arches.
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sha=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
      arm64) sha=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tar.gz; \
    echo "$sha  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_2.102.0_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_2.102.0_linux_${TARGETARCH}"

# Tailscale CLI is provided by the sidecar container via shared volume.
# A symlink ensures OpenClaw can find it in PATH.
RUN ln -s /opt/tailscale/tailscale /usr/local/bin/tailscale

# Extensions that require image-bundling (PATH scripts, SDK dependencies).
# Land outside /app so the new OpenClaw loader does not classify these paths
# as the upstream package's legacy bundled-plugin alias and silently ignore
# them in plugins.load.paths.
COPY image-extensions/ /opt/moltbot/extensions/

RUN chmod 0755 /opt/moltbot/extensions/gateway-projects/*.mjs \
    && ln -s /opt/moltbot/extensions/gateway-projects/project.mjs /usr/local/bin/gateway-project \
    && ln -s /opt/moltbot/extensions/gateway-projects/credential.mjs /usr/local/bin/git-credential-gateway-project

# Install per-extension npm dependencies.
# Each image-baked plugin lives outside /app so Node module resolution does not
# walk into /app/node_modules; per-plugin installs make their deps resolvable
# from the plugin directory itself.
RUN set -eu; \
    for ext in github-apps remote-acpx manage-secrets runtime-config-convergence; do \
      cd "/opt/moltbot/extensions/$ext"; \
      npm install --production --ignore-scripts; \
    done

USER node

RUN gh --version && command -v flock \
    && node --test /opt/moltbot/extensions/gateway-projects/*.test.mjs \
    && node /opt/moltbot/extensions/gateway-projects/image-smoke.mjs

# Exercise the installed host loader and production worker dependencies on each
# target architecture before publishing an application image.
RUN node /opt/moltbot/extensions/remote-acpx/test/image-smoke.mjs
