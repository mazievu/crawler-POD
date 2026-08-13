const { execSync, spawn } = require('child_process');
const http = require('http');

async function fetchJson(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:3005${path}`, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('--- 1. setup:capabilities --json ---');
  try { console.log(execSync('node scripts/setup-capabilities.js --json').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }
  
  console.log('\n--- 4. verify:apify --platform facebook_posts --json ---');
  try { console.log(execSync('node scripts/verify-apify.js --platform facebook_posts --json').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  console.log('\n--- 6. validate:codemap ---');
  try { console.log(execSync('node scripts/validate-codemap.js').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  console.log('\n--- 6. doctor --json ---');
  try { console.log(execSync('node scripts/doctor.js --json').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  console.log('\n--- 6. npm test (node --test) ---');
  try { console.log(execSync('node --test').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  console.log('\n--- 6. verify:real-backends --json ---');
  try { console.log(execSync('node scripts/verify-real-backends.js --json').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  console.log('\nStarting server to test API endpoints...');
  const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3005' } });
  
  // Wait for server
  await delay(2000);

  console.log('\n--- 2. Structured API Response for facebook_posts ---');
  const fbRes = await fetchJson('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'facebook_posts', query: 'test', options: { maxItems: 1 } })
  });
  console.log('Status Code:', fbRes.status);
  console.log('Response Body:', JSON.stringify(fbRes.data, null, 2));

  console.log('\n--- 5. /api/toidispy/check-login side-effect free ---');
  const runsBefore = await fetchJson('/api/runs');
  console.log('Runs count before:', runsBefore.data.length);
  
  const loginRes = await fetchJson('/api/toidispy/check-login');
  console.log('check-login response status:', loginRes.data.status);

  const runsAfter = await fetchJson('/api/runs');
  console.log('Runs count after:', runsAfter.data.length);
  
  console.log('\n--- 6. e2e:release ---');
  try { console.log(execSync('node scripts/e2e-test.js').toString().trim()); } catch(e) { console.log(e.stdout.toString().trim()); }

  server.kill();
}

main().catch(console.error);
