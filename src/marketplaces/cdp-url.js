const dns = require('node:dns/promises');
const net = require('node:net');

async function resolveCdpUrl(value, lookup = dns.lookup) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CDP URL must use HTTP(S)');
  if (!net.isIP(url.hostname) && url.hostname !== 'localhost') {
    const { address } = await lookup(url.hostname);
    url.hostname = address;
  }
  return url.toString();
}

module.exports = { resolveCdpUrl };
