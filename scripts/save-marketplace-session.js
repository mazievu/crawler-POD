#!/usr/bin/env node
require('dotenv').config();

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const db = require('../src/database');
const { collectInteractiveStorageState } = require('../src/marketplaces/session-login');

async function main() {
  const [platform, ...labelParts] = process.argv.slice(2);
  const label = labelParts.join(' ').trim();
  if (!platform || !label) {
    console.error('Usage: node scripts/save-marketplace-session.js <amazon|ebay|etsy> <account label>');
    process.exitCode = 1;
    return;
  }

  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`Opening ${platform}. Sign in manually in the browser, complete any MFA/CAPTCHA, then return here.`);
    const storageState = await collectInteractiveStorageState({
      platform,
      waitForConfirmation: async () => { await prompt.question('Press Enter only after the account page is ready... '); },
    });
    const account = db.createMarketplaceAccount({ platform, label, storageState });
    console.log(`Saved encrypted ${account.platform} session as "${account.label}" (account #${account.id}).`);
  } finally {
    prompt.close();
  }
}

main().catch((error) => {
  console.error(`Could not save marketplace session: ${error.message}`);
  process.exitCode = 1;
});
