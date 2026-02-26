FROM docker.io/cloudflare/sandbox:0.7.0

# Install Node.js 22 (required by OpenClaw) and rclone (for R2 persistence)
# The base image has Node 20, we need to replace it with Node 22
# Using direct binary download for reliability
ENV NODE_VERSION=22.13.1
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && apt-get update && apt-get install -y xz-utils ca-certificates rclone openssh-client git \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install AWS CLI v2 (required for Bedrock MFA auth via aws_auth skill)
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) AWS_ARCH="x86_64" ;; \
         arm64) AWS_ARCH="aarch64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws \
    && aws --version

# Install OpenClaw (formerly clawdbot/moltbot)
RUN npm install -g openclaw@2026.2.24 \
    && openclaw --version

# Create OpenClaw directories
# Legacy .clawdbot paths are kept for R2 backup migration
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd

# Copy startup script
# Build cache bust: 2026-02-21-subscription-auth-plugin
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
RUN chmod +x /usr/local/bin/start-openclaw.sh

# Copy skills to staging area (currently only cloudflare_browser).
# start-openclaw.sh installs them to ~/.openclaw/skills/ on every boot.
COPY skills/ /opt/openclaw-skills/

# Copy all plugins to staging area.
# start-openclaw.sh installs them to ~/.openclaw/extensions/ on every boot.
COPY extensions/ /opt/openclaw-extensions/

# Set working directory
WORKDIR /root/clawd

# Expose the gateway port
EXPOSE 18789
