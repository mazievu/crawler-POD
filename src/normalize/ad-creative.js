function parseNum(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

const { extractImage } = require('../image-utils');

module.exports = function normalizeAdCreative(raw, context) {
  const url = raw.url || raw.adUrl || raw.permalink || '';
  const title = raw.title || raw.adTitle || raw.text || '';
  
  return {
    uid: `${context.platform}:${url || title}`,
    type: 'ad_creative',
    platform: context.platform,
    advertiser: raw.advertiserName || raw.author || '',
    title: String(title).substring(0, 200),
    body: raw.body || raw.description || '',
    url: url,
    image: extractImage(raw),
    video: raw.videoUrl || '',
    cta: raw.ctaText || raw.callToAction || '',
    landingDomain: raw.domain || '',
    firstSeenAt: raw.firstSeenAt || new Date().toISOString(),
    engagement: {
      likes: parseNum(raw.likes || raw.reactions || 0),
      comments: parseNum(raw.comments || 0),
      shares: parseNum(raw.shares || 0),
      views: parseNum(raw.views || raw.impressions || 0)
    },
    raw: raw
  };
};
