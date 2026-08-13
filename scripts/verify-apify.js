require('dotenv').config();
const { ApifyClient } = require('apify-client');
const registry = require('../src/channels/registry');

async function main() {
  const args = process.argv.slice(2);
  let platform = null;
  let isJson = false;
  let runCheck = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform') platform = args[++i];
    if (args[i] === '--json') isJson = true;
    if (args[i] === '--run-check') runCheck = true;
  }

  if (!platform) {
    if (!isJson) console.error('Please specify a platform with --platform <name>');
    else console.log(JSON.stringify({ error: 'Missing --platform' }));
    process.exit(1);
  }

  const channel = registry.getChannel(platform);
  if (!channel) {
    if (!isJson) console.error(`Unknown platform: ${platform}`);
    else console.log(JSON.stringify({ error: 'Unknown platform', platform }));
    process.exit(1);
  }

  const apifyBackend = channel.backends.find(b => b.kind === 'apify');
  const actorId = apifyBackend ? apifyBackend.actorId : null;

  const result = {
    platform,
    backend: 'apify',
    actorId,
    status: 'missing_token',
    actions: []
  };

  if (!actorId) {
    result.status = 'actor_not_found';
    result.actions.push('No Apify actor configured for this platform');
    if (isJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Platform: ${platform}\nStatus: ${result.status}\nActions: ${result.actions.join(', ')}`);
    }
    return;
  }

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    result.actions.push('Add APIFY_TOKEN to .env');
    if (isJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Platform: ${platform}\nStatus: ${result.status}\nActions: ${result.actions.join(', ')}`);
    }
    return;
  }

  result.status = 'entitlement_unverified';

  // Check using apify-client
  const client = new ApifyClient({ token });
  try {
    // Attempt to get the actor
    const actor = await client.actor(actorId).get();
    if (!actor) {
      result.status = 'actor_not_found';
    } else {
      if (!runCheck) {
        result.status = 'entitlement_unverified'; // we can't be sure without running or checking billing
        result.actions.push(`Run verify:apify -- --platform ${platform} --run-check`);
        result.actions.push('Rent/enable actor in Apify if required');
      } else {
        // run minimal check
        const run = await client.actor(actorId).call({ search: 'test', maxItems: 1 }, { memoryMbytes: 256, timeoutSecs: 30 });
        if (run && run.status === 'SUCCEEDED') {
          result.status = 'verified_usable';
        } else {
          result.status = 'run_check_failed';
          result.actions.push(`Run failed with status: ${run ? run.status : 'unknown'}`);
        }
      }
    }
  } catch (err) {
    const msg = err.message ? err.message.toLowerCase() : '';
    if (msg.includes('not found')) {
       result.status = 'actor_not_found';
    } else if (msg.includes('unauthorized') || msg.includes('payment') || msg.includes('forbidden') || msg.includes('access denied')) {
       result.status = 'actor_requires_rental';
       result.actions.push('Rent/enable the actor in Apify');
    } else {
       result.status = 'run_check_failed';
       result.actions.push(err.message);
    }
  }

  if (isJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Platform: ${platform}`);
    console.log(`Actor ID: ${actorId}`);
    console.log(`Status: ${result.status}`);
    if (result.actions.length) console.log(`Actions: \n - ${result.actions.join('\n - ')}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
