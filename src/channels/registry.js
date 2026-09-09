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
      metricGroup: getPlatformMetricGroup(c.normalizer),
    };
  });
}

/**
 * Which metric panel (E-COM or SOCIAL) a platform's crawl filter should offer.
 *
 * Derived from the channel's own normalizer rather than a second hand-kept
 * list, so a platform can never be offered a metric its normalizer never
 * produces: `product_listing` emits price/rating/reviews/sold, while
 * `social_post` and `ad_creative` emit likes/comments/shares/views.
 */
function getPlatformMetricGroup(normalizer) {
  return normalizer === 'product_listing' ? 'ecom' : 'social';
}

module.exports = {
  getAllChannels,
  getChannel,
  getEnabledChannels,
  getPlatformCompatibilityList
};
