const fs = require('fs');
const glob = fs.readdirSync('src/channels').filter(f => f.endsWith('.channel.js'));
for (const f of glob) {
  let c = fs.readFileSync('src/channels/' + f, 'utf8');
  c = c.replace(/requiresPaidActor: true,\r?\n\s*paid: true,/g, 'actorEntitlement: "unverified",');
  fs.writeFileSync('src/channels/' + f, c);
}
