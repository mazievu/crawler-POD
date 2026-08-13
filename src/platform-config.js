const registry = require('./channels/registry');

const PLATFORMS = registry.getPlatformCompatibilityList();

function getPlatform(name) {
  return registry.getChannel(name);
}

function validateJobInput(platform, query) {
  if (!platform) return { valid: false, error: 'platform is required' };
  if (!query || !query.trim()) return { valid: false, error: 'query is required' };
  const config = getPlatform(platform);
  if (!config) return { valid: false, error: `Unknown platform: ${platform}` };
  return { valid: true };
}

module.exports = {
  PLATFORMS,
  getPlatform,
  validateJobInput
};
