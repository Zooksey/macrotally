# MacroTally AI helper: Node 22 + the Claude Code CLI, run as a non-root user.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# The base image already has user "node" (uid 1000), so "app" gets uid/gid 1001.
RUN useradd --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
  && mkdir -p /data && chown app:app /data
ENV HOME=/home/app

WORKDIR /app
COPY ai-server.mjs off-pack.mjs schema.json system.txt ./

ENV DISABLE_AUTOUPDATER=1 PORT=8787 DATA_DIR=/data
EXPOSE 8787
USER app
CMD ["node", "ai-server.mjs"]
