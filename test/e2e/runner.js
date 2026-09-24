#!/usr/bin/env node
'use strict';

/**
 * test/e2e/runner.js — Modular E2E Test Suite Runner
 *
 * Runs the Crawler-POD Internet Launch Security & Auth 4-Tier Test Suite.
 *
 * Usage:
 *   node test/e2e/runner.js            # Run all tiers (Tiers 1 - 4)
 *   node test/e2e/runner.js --tier=1   # Run Tier 1: Feature Coverage only
 *   node test/e2e/runner.js --tier=2   # Run Tier 2: Boundary & Corner Cases only
 *   node test/e2e/runner.js --tier=3   # Run Tier 3: Cross-Feature Combinations only
 *   node test/e2e/runner.js --tier=4   # Run Tier 4: Real-World Scenarios only
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const TIERS = [
  {
    tier: 1,
    name: 'Tier 1: Feature Coverage',
    file: 'tier1_features.test.js',
    description: '>=5 primary behavior tests for all 21 features',
    expectedMinTests: 105,
  },
  {
    tier: 2,
    name: 'Tier 2: Boundary & Corner Cases',
    file: 'tier2_boundaries.test.js',
    description: '>=5 edge, boundary, and stress tests for all 21 features',
    expectedMinTests: 105,
  },
  {
    tier: 3,
    name: 'Tier 3: Cross-Feature Combinations',
    file: 'tier3_combinations.test.js',
    description: 'Pairwise interaction tests across security and operational layers',
    expectedMinTests: 20,
  },
  {
    tier: 4,
    name: 'Tier 4: Real-World Scenarios',
    file: 'tier4_realworld.test.js',
    description: 'End-to-end user workflows, attack campaigns, and disaster recovery',
    expectedMinTests: 5,
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let selectedTier = null;
  let verbose = false;

  for (const arg of args) {
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg.startsWith('--tier=')) {
      selectedTier = parseInt(arg.split('=')[1], 10);
    } else if (/^tier[1-4]$/i.test(arg)) {
      selectedTier = parseInt(arg.replace(/tier/i, ''), 10);
    } else if (['1', '2', '3', '4'].includes(arg)) {
      selectedTier = parseInt(arg, 10);
    }
  }

  return { selectedTier, verbose };
}

function runTestFile(filePath, verbose) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, ['--test', filePath], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (verbose) process.stdout.write(d);
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (verbose) process.stderr.write(d);
    });

    child.on('close', (code) => {
      const duration = Date.now() - start;
      
      // Parse output for test counts
      const testsMatch = stdout.match(/ℹ tests\s+(\d+)/);
      const passMatch = stdout.match(/ℹ pass\s+(\d+)/);
      const failMatch = stdout.match(/ℹ fail\s+(\d+)/);

      const tests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
      const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
      const fail = failMatch ? parseInt(failMatch[1], 10) : (code !== 0 ? 1 : 0);

      resolve({
        code,
        duration,
        tests,
        pass,
        fail,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  const { selectedTier, verbose } = parseArgs();

  console.log('='.repeat(78));
  console.log('   Crawler-POD Internet Launch Security & Auth — E2E Test Suite');
  console.log('='.repeat(78));
  console.log(`Execution Mode: ${selectedTier ? `Tier ${selectedTier} only` : 'All Tiers (Tiers 1 - 4)'}`);
  console.log(`Node.js Version: ${process.version}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const tiersToRun = selectedTier
    ? TIERS.filter((t) => t.tier === selectedTier)
    : TIERS;

  if (tiersToRun.length === 0) {
    console.error(`Invalid tier: ${selectedTier}. Allowed values are 1, 2, 3, 4.`);
    process.exit(1);
  }

  const results = [];
  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  let overallStart = Date.now();

  for (const tierConfig of tiersToRun) {
    const testPath = path.join('test', 'e2e', tierConfig.file);
    process.stdout.write(`► Running ${tierConfig.name} (${testPath})... `);

    const result = await runTestFile(testPath, verbose);
    results.push({ ...tierConfig, ...result });

    totalTests += result.tests;
    totalPass += result.pass;
    totalFail += result.fail;

    if (result.code === 0 && result.fail === 0) {
      console.log(`✔ PASS [${result.pass}/${result.tests} passed] (${(result.duration / 1000).toFixed(2)}s)`);
    } else {
      console.log(`✖ FAIL [${result.fail} failed] (${(result.duration / 1000).toFixed(2)}s)`);
      if (!verbose) {
        console.error('\n--- Failure Output ---');
        console.error(result.stdout || result.stderr);
        console.error('----------------------\n');
      }
    }
  }

  const overallDuration = ((Date.now() - overallStart) / 1000).toFixed(2);

  // Print Summary Table
  console.log('\n' + '-'.repeat(78));
  console.log('                            TEST SUITE SUMMARY');
  console.log('-'.repeat(78));
  console.log('Tier                     Tests    Passed    Failed    Duration    Status');
  console.log('-'.repeat(78));

  for (const r of results) {
    const tierName = r.name.padEnd(25);
    const testsStr = String(r.tests).padStart(5);
    const passStr = String(r.pass).padStart(9);
    const failStr = String(r.fail).padStart(9);
    const durStr = `${(r.duration / 1000).toFixed(2)}s`.padStart(11);
    const statusStr = r.fail === 0 && r.code === 0 ? '   ✔ PASS' : '   ✖ FAIL';

    console.log(`${tierName}${testsStr}${passStr}${failStr}${durStr}${statusStr}`);
  }

  console.log('-'.repeat(78));
  const summaryLine = `TOTAL                    ${String(totalTests).padStart(5)}${String(totalPass).padStart(9)}${String(totalFail).padStart(9)}${`${overallDuration}s`.padStart(11)}   ${totalFail === 0 ? '✔ ALL PASSED' : '✖ FAILED'}`;
  console.log(summaryLine);
  console.log('='.repeat(78));

  if (totalFail > 0) {
    console.error(`\n❌ Test suite failed with ${totalFail} failure(s).`);
    process.exit(1);
  } else {
    console.log(`\n✅ 100% of tests passed (${totalPass}/${totalTests}) across all executed tiers.`);
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
}

module.exports = { runTestFile, TIERS };
