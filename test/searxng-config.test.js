const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('SearXNG accepts JSON search responses used by marketplace discovery', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const settingsPath = path.join(root, 'searxng', 'settings.yml');
  assert.match(compose, /\.\/searxng\/settings\.yml:\/etc\/searxng\/settings\.yml:ro/);
  const settings = fs.readFileSync(settingsPath, 'utf8');
  assert.match(settings, /formats:\s*\n\s*- html\s*\n\s*- json/);
});
