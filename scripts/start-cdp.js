/**
 * Start a browser with Chrome DevTools Protocol enabled.
 *
 * Toidispy scraping needs a real, visible browser so the user can log in and
 * keep the session in data/cdp-profile.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const CDP_PORT = new URL(CDP_URL).port || '9222';
const USER_DATA_DIR = process.env.CDP_USER_DATA_DIR || path.join(__dirname, '..', 'data', 'cdp-profile');

async function isReady() {
  try {
    const resp = await fetch(CDP_URL + '/json/version', {
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch (_err) {
    return false;
  }
}

function existingPath(filePath) {
  return filePath && fs.existsSync(filePath) ? filePath : null;
}

function candidateExecutables() {
  const envPath = existingPath(process.env.CHROME_PATH);
  const candidates = [];
  if (envPath) candidates.push(envPath);

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }

  try {
    const { chromium } = require('playwright');
    candidates.push(chromium.executablePath());
  } catch (_err) {
    // Playwright is an app dependency, but keep this helper usable in partial installs.
  }

  return candidates.filter(Boolean);
}

function findBrowser() {
  for (const candidate of candidateExecutables()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitUntilReady() {
  for (let i = 0; i < 20; i++) {
    if (await isReady()) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  if (await isReady()) {
    console.log('[CDP] Ready at ' + CDP_URL);
    return;
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('No Chrome/Edge/Chromium executable found. Install Chrome or set CHROME_PATH.');
  }

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });

  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + USER_DATA_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    'https://app.toidispy.com/posts',
  ];

  console.log('[CDP] Starting browser: ' + browserPath);
  const child = spawn(browserPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  if (!(await waitUntilReady())) {
    throw new Error('Browser started but CDP did not become ready at ' + CDP_URL);
  }

  console.log('[CDP] Ready at ' + CDP_URL);
  console.log('[CDP] Profile: ' + USER_DATA_DIR);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[CDP] ' + err.message);
    process.exit(1);
  });
}

module.exports = { isReady, findBrowser };
