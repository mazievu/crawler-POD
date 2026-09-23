'use strict';

/**
 * test/adversarial/runner.js — Challenger 1 Adversarial Stress Test Runner
 *
 * Runs all Tier 5 Adversarial Stress Suites for Milestone M1 (Authentication & RBAC):
 * 1. Session Hijacking, Forged Tokens, Expired Sessions, Corrupted Cookies
 * 2. API Key Tampering, Revocation, Malformed Headers, Privilege Escalation
 * 3. Timing Attack Resilience & Constant-Time Verification
 * 4. Password Edge Cases (Empty, Null Bytes, Long Inputs, Multilingual)
 * 5. Super Admin Bootstrap Idempotency Under High Concurrency
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ADVERSARIAL_SUITES = [
  { name: 'Suite 1: Session Hijacking & Cookie Resilience', file: 'm1_session_adversarial.test.js' },
  { name: 'Suite 2: API Key Tampering & Revocation Defenses', file: 'm1_apikey_adversarial.test.js' },
  { name: 'Suite 3: Timing Attack Resilience & Dummy Verification', file: 'm1_timing_adversarial.test.js' },
  { name: 'Suite 4: Password Edge Cases & Null Byte Immunity', file: 'm1_password_adversarial.test.js' },
  { name: 'Suite 5: Super Admin Bootstrap Concurrency Stress', file: 'm1_bootstrap_concurrency.test.js' },
  { name: 'Suite 6: MCP Bridge Lockdown & Reverse Proxy Ingress', file: 'm2_mcp_bridge_adversarial.test.js' },
  { name: 'Suite 7: Live Server MCP Bridge & Path Traversal Verification', file: 'm2_mcp_bridge_live.test.js' },
  { name: 'Suite 8: Outbound Guard SSRF & Ingress Defenses', file: 'm2_ssrf_outbound_guard.test.js' },
  { name: 'Suite 9: Rate Limiting & Abuse Prevention Defenses', file: 'm3_rate_limit_adversarial.test.js' },
  { name: 'Suite 10: Concurrency, Freeze & Apify Budget Kill Switch', file: 'm3_concurrency_budget_adversarial.test.js' },
  { name: 'Suite 11: Container Operations, Probes & Lifecycle Resilience', file: 'm4_ops_adversarial.test.js' },
  { name: 'Suite 12: Backup & Rollback Tamper Resilience', file: 'm4_backup_adversarial.test.js' },
];

async function runSuite(suite) {
  const filePath = path.join(__dirname, suite.file);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', filePath], {
      cwd: path.resolve(__dirname, '../..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      const passMatch = stdout.match(/ℹ pass (\d+)/);
      const failMatch = stdout.match(/ℹ fail (\d+)/);
      const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      const failed = failMatch ? parseInt(failMatch[1], 10) : (code !== 0 ? 1 : 0);

      resolve({
        name: suite.name,
        file: suite.file,
        passed,
        failed,
        duration: `${duration}s`,
        success: code === 0 && failed === 0,
        output: stdout + stderr,
      });
    });
  });
}

async function main() {
  console.log('==============================================================================');
  console.log('   Crawler-POD Adversarial Challenge Suite — Milestone M1, M2, M3 & M4 Verification');
  console.log('==============================================================================');
  console.log(`Execution Mode: Adversarial & Empirical Stress (${ADVERSARIAL_SUITES.length} Suites)`);
  console.log(`Node.js Version: ${process.version}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const results = [];
  let allPass = true;

  for (const suite of ADVERSARIAL_SUITES) {
    process.stdout.write(`► Running ${suite.name} (${suite.file})... `);
    const res = await runSuite(suite);
    results.push(res);

    if (res.success) {
      console.log(`✔ PASS [${res.passed}/${res.passed} passed] (${res.duration})`);
    } else {
      console.log(`✖ FAIL [${res.passed} passed, ${res.failed} failed] (${res.duration})`);
      allPass = false;
      console.error(res.output);
    }
  }

  console.log('\n------------------------------------------------------------------------------');
  console.log('                        ADVERSARIAL SUITE SUMMARY');
  console.log('------------------------------------------------------------------------------');
  console.log(
    'Suite Name'.padEnd(48) +
    'Passed'.padStart(8) +
    'Failed'.padStart(8) +
    'Duration'.padStart(10) +
    '   Status'
  );
  console.log('------------------------------------------------------------------------------');

  let totalPassed = 0;
  let totalFailed = 0;

  for (const r of results) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    console.log(
      r.name.padEnd(48) +
      String(r.passed).padStart(8) +
      String(r.failed).padStart(8) +
      r.duration.padStart(10) +
      (r.success ? '   ✔ PASS' : '   ✖ FAIL')
    );
  }

  console.log('------------------------------------------------------------------------------');
  console.log(
    'TOTAL'.padEnd(48) +
    String(totalPassed).padStart(8) +
    String(totalFailed).padStart(8) +
    '          ' +
    (allPass ? '   ✔ ALL PASSED' : '   ✖ FAILING')
  );
  console.log('==============================================================================\n');

  if (allPass) {
    console.log(`✅ 100% of adversarial stress tests passed (${totalPassed}/${totalPassed}) across all ${results.length} suites.`);
    process.exit(0);
  } else {
    console.error(`❌ Adversarial suite detected ${totalFailed} failure(s).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Adversarial runner fatal error:', err);
  process.exit(1);
});
