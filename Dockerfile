# The image includes the Linux dependencies and Chromium required by Playwright.
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

# The named volume is initialized from this directory on its first use.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3000

CMD ["node", "server.js"]
