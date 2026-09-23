'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function parseDockerignore(content) {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

test('Feature 16 & 17: .dockerignore, Dockerfile hardening, and docker-compose media persistence', async (t) => {

  await t.test('1. .dockerignore matches all sensitive and volatile paths', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
    const patterns = parseDockerignore(content);

    const sensitivePaths = [
      '.env',
      '.env.production',
      '.env.local',
      '.env.backup',
      'proxies.txt',
      '.backup/2026-09-23/manifest.json',
      '.backup/dump.sql',
      'docs/DATA_PACKETS/prod.db',
      'public/media/abc12345.jpg',
      'public/media/subdir/image.png',
      'logs/server.log',
      'data/collector.db',
      '.git/config',
      '.agents/worker/plan.md',
      'test/dockerignore.test.js',
      'debug/run.log',
      'codemaps/map.md',
    ];

    for (const sPath of sensitivePaths) {
      const isIgnored = patterns.some(p => {
        const normPath = sPath.replace(/\\/g, '/');
        const normP = p.replace(/\\/g, '/');
        if (normP === normPath || normP === path.basename(normPath)) return true;
        if (normP.endsWith('/') && normPath.startsWith(normP)) return true;
        if (normP.startsWith('.env*') && path.basename(normPath).startsWith('.env')) return true;
        if (normP.includes('proxies.txt') && normPath.includes('proxies.txt')) return true;
        if (normP.startsWith('public/media') && normPath.startsWith('public/media')) return true;
        if (normP.startsWith('.backup') && normPath.startsWith('.backup')) return true;
        if (normP.startsWith('docs/DATA_PACKETS') && normPath.startsWith('docs/DATA_PACKETS')) return true;
        if (normP.startsWith('data/') && normPath.startsWith('data/')) return true;
        if (normP.startsWith('logs/') && normPath.startsWith('logs/')) return true;
        if (normP.startsWith('debug/') && normPath.startsWith('debug/')) return true;
        if (normP.startsWith('codemaps/') && normPath.startsWith('codemaps/')) return true;
        if (normP.startsWith('test/') && normPath.startsWith('test/')) return true;
        if (normP.startsWith('.git/') && normPath.startsWith('.git/')) return true;
        if (normP.startsWith('.agents/') && normPath.startsWith('.agents/')) return true;
        if (normP === '*.log' && normPath.endsWith('.log')) return true;
        if (normP === '*.db' && normPath.endsWith('.db')) return true;
        return false;
      });
      assert.ok(isIgnored, `Expected ${sPath} to be ignored by .dockerignore`);
    }

    // Verify critical build files are NOT ignored
    const criticalBuildFiles = [
      'package.json',
      'package-lock.json',
      'server.js',
      'src/media-cache.js',
      'public/index.html',
      'public/app.js',
    ];

    for (const cPath of criticalBuildFiles) {
      const isIgnored = patterns.some(p => p === cPath || (p.endsWith('/') && cPath.startsWith(p)));
      assert.ok(!isIgnored, `Critical build file ${cPath} must NOT be ignored`);
    }
  });

  await t.test('2. Dockerfile satisfies non-root pwuser, writeable directories, and /livez HEALTHCHECK', () => {
    const dockerfileContent = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

    // 1. Non-root user
    assert.ok(dockerfileContent.includes('USER pwuser'), 'Dockerfile must switch to USER pwuser');
    assert.ok(dockerfileContent.includes('10001'), 'Dockerfile must reference UID 10001 for pwuser');

    // 2. Pre-create runtime directories
    assert.ok(dockerfileContent.includes('/app/data'), 'Dockerfile must create /app/data');
    assert.ok(dockerfileContent.includes('/app/public/media'), 'Dockerfile must create /app/public/media');
    assert.ok(dockerfileContent.includes('/app/logs'), 'Dockerfile must create /app/logs');
    assert.ok(dockerfileContent.includes('/app/.backup'), 'Dockerfile must create /app/.backup');
    assert.ok(dockerfileContent.includes('chown -R pwuser:pwuser /app'), 'Dockerfile must chown /app to pwuser');

    // 3. HEALTHCHECK against /livez
    assert.ok(dockerfileContent.includes('HEALTHCHECK'), 'Dockerfile must define HEALTHCHECK');
    assert.ok(dockerfileContent.includes('/livez'), 'HEALTHCHECK must probe /livez endpoint');
  });

  await t.test('3. docker-compose.yml configures media_data volume and declares top-level volume', () => {
    const composeContent = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');

    // 1. Check media_data volume mount for /app/public/media
    assert.ok(composeContent.includes('media_data:/app/public/media'), 'docker-compose.yml must mount media_data to /app/public/media');

    // 2. Check parent ./public mount is read-only
    assert.ok(composeContent.includes('./public:/app/public:ro'), './public must be mounted as read-only :ro');

    // 3. Check top-level volume declaration
    const volumesMatch = composeContent.match(/^volumes:\s*([\s\S]*)$/m);
    assert.ok(volumesMatch, 'docker-compose.yml must contain top-level volumes section');
    assert.ok(volumesMatch[1].includes('media_data:'), 'media_data must be declared under top-level volumes:');

    // 4. Check collector healthcheck
    assert.ok(composeContent.includes('healthcheck:'), 'collector service must define healthcheck');
    assert.ok(composeContent.includes('/livez'), 'collector healthcheck must test /livez');
  });
});
