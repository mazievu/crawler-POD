const BaseBackend = require('./base.backend');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');

class CDPBackend extends BaseBackend {
  constructor() {
    super({ name: 'cdp', kind: 'cdp' });
  }

  async probe(channel, backendConfig, options = {}) {
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'toidispy-cdp.js');
    if (!fs.existsSync(scriptPath)) {
      return {
        name: 'cdp',
        status: 'failed',
        missing: ['TOIDISPY_CDP_SCRIPT'],
        warnings: ['scripts/toidispy-cdp.js is missing'],
        actions: ['Restore scripts/toidispy-cdp.js']
      };
    }

    const cdpUrl = options.cdpUrl || process.env.CDP_URL || 'http://localhost:9222';
    const checkedUrl = `${cdpUrl}/json/version`;
    const timeoutMs = parseInt(process.env.DEPENDENCY_PROBE_TIMEOUT_MS || '2000', 10);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(checkedUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.Browser && !data.webSocketDebuggerUrl) throw new Error('Invalid CDP response');
    } catch (e) {
      return {
        name: 'cdp',
        status: 'failed',
        missing: ['CDP_BROWSER_9222'],
        checkedUrl,
        warnings: [`CDP endpoint is not reachable at ${cdpUrl}`],
        actions: [`Start Chrome with --remote-debugging-port=${new URL(cdpUrl).port} or set CDP_URL`]
      };
    }

    return { name: 'cdp', status: 'ok', version: '1.0.0', checkedUrl, warnings: [] };
  }

  async run(channel, backendConfig, query, options = {}) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'toidispy-cdp.js');
      const section = options.section || 'posts';
      const filterArgs = JSON.stringify(options.filters || {});

      const child = child_process.spawn('node', [
        scriptPath, 
        '--output', 'stdout', 
        '--query', query, 
        '--section', section, 
        '--filters', filterArgs
        , '--cdp-url', options.cdpUrl || process.env.CDP_URL || 'http://localhost:9222'
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        let stdoutJson = null;
        try {
          if (stdout.trim()) stdoutJson = JSON.parse(stdout);
        } catch(e) {}

        let stderrDiagnostic = null;
        try {
          const lines = stderr.split('\n').filter(l => l.trim());
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed && parsed.event === 'toidispy_fatal') {
                stderrDiagnostic = parsed;
                break;
              }
            } catch(e) {}
          }
        } catch(e) {}

        let items = [];
        let parseError = null;

        if (code === 0) {
          if (!stdoutJson) parseError = 'No valid JSON in stdout';
          else items = stdoutJson.items || [];
          
          if (parseError) {
             resolve({
                backend: this.name,
                backendKind: this.kind,
                backendRunId: null,
                datasetId: null,
                items: [],
                rawStatus: 'FAILED',
                healthSnapshot: { 
                  error: 'CDP script did not emit valid JSON stdout',
                  stdout: stdout.substring(0, 2000), 
                  stderr: stderr.substring(0, 2000) 
                }
             });
          } else {
             resolve({
               backend: this.name,
               backendKind: this.kind,
               backendRunId: null,
               datasetId: null,
               items: items,
               rawStatus: 'SUCCEEDED',
               healthSnapshot: { code, stderr: stderr.substring(0, 2000) }
             });
          }
        } else {
          resolve({
            backend: this.name,
            backendKind: this.kind,
            backendRunId: null,
            datasetId: null,
            items: [],
            rawStatus: 'FAILED',
            healthSnapshot: { 
              error: stdoutJson?.error?.message || stderrDiagnostic?.message || 'CDP script failed',
              code: stdoutJson?.error?.code || stderrDiagnostic?.code || code,
              checkedUrl: 'http://localhost:9222/json/version',
              script: 'scripts/toidispy-cdp.js',
              outputMode: 'stdout',
              stdoutJson,
              stderrDiagnostic,
              stdout: stdout.substring(0, 2000),
              stderr: stderr.substring(0, 2000),
              actions: [
                "Open the reported currentUrl in the CDP browser",
                "Verify Facebook/Ads Library login",
                "Check whether page title indicates login/checkpoint/captcha",
                "Retry after fixing the browser session"
              ]
            }
          });
        }
      });
    });
  }

  getHealthHint(error) {
    if (error.message.includes('not found')) {
      return { message: error.message, action: 'Ensure scripts/toidispy-cdp.js exists' };
    }
    return super.getHealthHint(error);
  }
}

module.exports = CDPBackend;
