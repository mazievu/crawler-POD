require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { runDoctor } = require('../src/doctor');

async function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(urlStr);
      const req = http.request(urlStr, { method: 'GET' }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function checkCdp(cdpUrl) {
  try {
    const res = await fetchUrl(`${cdpUrl}/json/version`);
    return res.status === 200 ? 'ok' : 'failed';
  } catch (err) {
    return 'failed';
  }
}

async function checkSearxng(searxngUrl) {
  try {
    const res = await fetchUrl(searxngUrl);
    // SearXNG usually returns 200 on root
    return res.status >= 200 && res.status < 400 ? 'ok' : 'failed';
  } catch (err) {
    return 'failed';
  }
}

async function checkToidispyLogin(cdpUrl) {
  try {
    // Attempt to connect to CDP and check login via a simple HTTP check if we know the browser state
    // But since CDP is headless/browser control, we might just use the CDP endpoint to list targets or run a simple evaluation.
    // For setup wizard, we can just use the CDP backend probe if it supports it, or use the check-login logic
    // We'll require cdp backend or playwright
    // Wait, the spec says: Toidispy login state: CDP reachable, Toidispy app URL không redirect về /login
    // Let's implement a simple CDP fetch
    const CDPBackend = require('../src/backends/cdp.backend');
    const cdp = new CDPBackend();
    // Use the probe or checkLogin if we add it to CDPBackend.
    // Let's do it simply by using playwright.
    const { chromium } = require('playwright');
    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const context = browser.contexts()[0];
      const page = await context.newPage();
      const response = await page.goto('https://app.toidispy.com/posts', { waitUntil: 'domcontentloaded', timeout: 5000 });
      const currentUrl = page.url();
      await page.close();
      await browser.close();
      if (currentUrl.includes('/login')) {
        return { status: 'failed', code: 'TOIDISPY_LOGIN_REQUIRED', action: 'Login Toidispy in the Chrome CDP profile' };
      }
      return { status: 'ok' };
    } catch (e) {
      if (browser) await browser.close();
      return { status: 'failed', code: 'CDP_UNREACHABLE', action: 'Start Chrome with --remote-debugging-port' };
    }
  } catch (err) {
    return { status: 'failed', code: 'UNKNOWN_ERROR', action: err.message };
  }
}

function checkDatabase() {
  const dbPath = path.join(__dirname, '..', 'data', 'collector.db');
  if (!fs.existsSync(dbPath)) return { status: 'missing', dbPath };
  try {
    const db = new Database(dbPath, { readonly: true });
    // Check migration
    const info = db.prepare("PRAGMA table_info(runs)").all();
    const columns = info.map(c => c.name);
    db.close();
    if (columns.includes('platform') && columns.includes('status')) {
      return { status: 'ok', dbPath, migrations: 'ok' };
    }
    return { status: 'ok', dbPath, migrations: 'failed' };
  } catch (e) {
    return { status: 'failed', dbPath, error: e.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  const report = {
    status: 'ok',
    checks: {}
  };

  // Node version
  report.checks.node = { status: 'ok', version: process.version };

  // npm dependencies
  const nodeModulesExists = fs.existsSync(path.join(__dirname, '..', 'node_modules'));
  report.checks.dependencies = { status: nodeModulesExists ? 'ok' : 'missing' };

  // .env
  const envExists = fs.existsSync(path.join(__dirname, '..', '.env'));
  report.checks.env = { status: envExists ? 'ok' : 'missing' };

  // APIFY
  const apifyToken = process.env.APIFY_TOKEN;
  let apifyStatus = 'warn';
  let apifyReason = 'APIFY_TOKEN missing or actor entitlement unverified';
  
  if (!apifyToken) {
    apifyStatus = 'warn';
    apifyReason = 'APIFY_TOKEN is missing';
  } else {
    try {
       const { execSync } = require('child_process');
       const verifyOut = JSON.parse(execSync('node scripts/verify-real-backends.js --json').toString());
       let isUnverified = false;
       for (const key of Object.keys(verifyOut.backends || {})) {
          if (key.startsWith('apify-') && verifyOut.backends[key].status === 'skipped') {
             isUnverified = true;
          }
       }
       if (!isUnverified) {
          apifyStatus = 'ok';
          apifyReason = 'Verified';
       } else {
          apifyStatus = 'warn';
          apifyReason = 'APIFY_TOKEN missing or actor entitlement unverified';
       }
    } catch(e) {
       apifyStatus = 'warn';
       apifyReason = 'Could not verify Apify entitlement';
    }
  }
  report.checks.apify = { status: apifyStatus, reason: apifyReason, optional: true };

  // CDP
  const cdpUrl = process.env.CDP_URL || 'http://localhost:9222';
  const cdpStatus = await checkCdp(cdpUrl);
  report.checks.cdp = { status: cdpStatus, checkedUrl: `${cdpUrl}/json/version` };

  // SEARXNG
  const searxngUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
  const searxngStatus = await checkSearxng(searxngUrl);
  report.checks.searxng = { status: searxngStatus, checkedUrl: searxngUrl };

  // Toidispy login
  report.checks.toidispyLogin = await checkToidispyLogin(cdpUrl);

  // Database
  const dbCheck = checkDatabase();
  report.checks.database = { status: dbCheck.status, path: dbCheck.dbPath };
  report.checks.migrations = { status: dbCheck.migrations || 'missing' };

  // Doctor
  report.checks.doctor = await runDoctor();

  // Aggregate Status
  let hasFailed = false;
  let hasWarn = false;
  
  if (report.checks.dependencies.status !== 'ok' || report.checks.cdp.status !== 'ok' || report.checks.searxng.status !== 'ok' || report.checks.toidispyLogin.status !== 'ok' || report.checks.database.status !== 'ok' || report.checks.migrations.status !== 'ok') {
    hasWarn = true;
  }
  if (report.checks.apify.status !== 'ok') hasWarn = true;

  if (hasWarn) report.status = 'warn';
  if (hasFailed) report.status = 'failed';

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`crawler-POD Capability Setup\n`);
    console.log(`Node: ${report.checks.node.status}`);
    console.log(`Dependencies: ${report.checks.dependencies.status}`);
    console.log(`.env: ${report.checks.env.status}`);
    console.log(`Apify Entitlement: ${report.checks.apify.status} (${report.checks.apify.reason})`);
    console.log(`CDP_URL: ${cdpUrl}`);
    console.log(`Chrome CDP: ${report.checks.cdp.status}`);
    console.log(`SEARXNG_URL: ${searxngUrl}`);
    console.log(`SearXNG: ${report.checks.searxng.status}`);
    
    if (report.checks.toidispyLogin.status === 'ok') {
      console.log(`Toidispy login: ok`);
    } else {
      console.log(`Toidispy login: failed — ${report.checks.toidispyLogin.action || 'Unknown error'}`);
    }
    
    console.log(`Database: ${report.checks.database.status}`);
    console.log(`Migrations: ${report.checks.migrations.status}`);
    
    console.log(`\nRecommended actions:`);
    let actionIdx = 1;
    if (report.checks.apify.status !== 'ok') {
      console.log(`${actionIdx++}. Add APIFY_TOKEN and rent necessary actors if you need Apify channels.`);
    }
    if (report.checks.toidispyLogin.status !== 'ok') {
      console.log(`${actionIdx++}. Login Toidispy in the Chrome CDP profile.`);
    }
    if (report.checks.cdp.status !== 'ok') {
      console.log(`${actionIdx++}. Ensure Chrome is running with --remote-debugging-port=9222.`);
    }
    if (report.checks.searxng.status !== 'ok') {
      console.log(`${actionIdx++}. Start SearXNG locally if you need local scraping discovery.`);
    }
    if (report.checks.dependencies.status !== 'ok') {
      console.log(`${actionIdx++}. Run 'npm install' to install dependencies.`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
