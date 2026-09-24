# The image includes Linux dependencies and Chromium required by Playwright.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

WORKDIR /app

# better-sqlite3 builds from source when a Node ABI-specific prebuilt binary is
# unavailable in the Playwright image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV NODE_ENV=production \
    PORT=3000 \
    SEARXNG_URL=http://searxng:8080

# Configure non-root pwuser UID 10001 and ensure all runtime writeable directories exist
# (data for profiles/cache, public/media for media cache, logs for file logging, .backup for dumps)
RUN (usermod -u 10001 pwuser 2>/dev/null && groupmod -g 10001 pwuser 2>/dev/null || true) \
    && mkdir -p /app/data /app/public/media /app/logs /app/.backup \
    && chown -R pwuser:pwuser /app

# Switch to non-root user
USER pwuser

EXPOSE 3000

# Container liveness probe verifying Node.js event loop and server response
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/livez', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "server.js"]
