const fs = require('fs');
const path = require('path');
const { getPlatformInputFields, getPlatformQueryField } = require('../collection-inputs');

const channelsDir = __dirname;
const channels = new Map();

// Dynamically load all .channel.js files
fs.readdirSync(channelsDir).forEach(file => {
  if (file.endsWith('.channel.js')) {
    const channel = require(path.join(channelsDir, file));
    channels.set(channel.name, channel);
  }
});

function getAllChannels() {
  return Array.from(channels.values());
}

function getChannel(name) {
  return channels.get(name) || null;
}

function getEnabledChannels() {
  return getAllChannels().filter(c => c.availability.status !== 'disabled');
}

function getPlatformCompatibilityList() {
  return getAllChannels().map(c => {
    // Determine primary actorId for UI compatibility
    let primaryActorId = 'unknown';
    if (c.backends && c.backends.length > 0) {
      const apifyBackend = c.backends.find(b => b.kind === 'apify');
      if (apifyBackend && apifyBackend.actorId) {
        primaryActorId = apifyBackend.actorId;
      } else {
        primaryActorId = c.backends[0].name;
      }
    }

    return {
      name: c.name,
      displayName: c.displayName,
      description: c.description,
      queryType: c.queryType,
      actorId: primaryActorId,
      countrySupport: c.availability.countrySupport ? 1 : 0,
      icon: c.icon,
      color: c.color,
      paid: c.availability.paid,
      disabled: c.availability.status === 'disabled',
      queryField: getPlatformQueryField(c.name),
      inputFields: getPlatformInputFields(c.name),
    };
  });
}

module.exports = {
  getAllChannels,
  getChannel,
  getEnabledChannels,
  getPlatformCompatibilityList
};
