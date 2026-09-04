function parseNum(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

const { extractImage } = require('../image-utils');

function extractCreativeImage(raw) {
  const snap = raw.snapshot || {};

  // 1. Single images
  if (Array.isArray(snap.images) && snap.images.length > 0) {
    for (const img of snap.images) {
      const u = img.originalImageUrl || img.resizedImageUrl || img.url || img.src;
      if (u && typeof u === 'string') return u;
    }
  }

  // 2. Carousel cards
  if (Array.isArray(snap.cards) && snap.cards.length > 0) {
    for (const card of snap.cards) {
      const u = card.originalImageUrl || card.resizedImageUrl || card.videoPreviewImageUrl || card.url || card.src;
      if (u && typeof u === 'string') return u;
    }
  }

  // 3. Videos preview poster
  if (Array.isArray(snap.videos) && snap.videos.length > 0) {
    for (const vid of snap.videos) {
      const u = vid.videoPreviewImageUrl || vid.previewUrl || vid.thumbnail;
      if (u && typeof u === 'string') return u;
    }
  }

  // 4. Generic extractImage (skip 60x60 / 100x100 avatars if possible)
  const generic = extractImage(raw);
  if (generic && !generic.includes('s60x60') && !generic.includes('s100x100')) return generic;

  // 5. Fallback to profile avatar
  return snap.pageProfilePictureUrl || generic || '';
}

module.exports = function normalizeAdCreative(raw, context = { platform: 'facebook_ads' }) {
  const archiveId = raw.adArchiveId || raw.adArchiveID || raw.id || '';
  const adLibraryUrl = archiveId ? `https://www.facebook.com/ads/library/?id=${archiveId}` : '';
  const landingUrl = raw.snapshot?.linkUrl || raw.url || raw.adUrl || raw.permalink || raw.inputUrl || '';
  const url = adLibraryUrl || landingUrl || '';

  const advertiser = raw.advertiserName || raw.author || raw.pageName || raw.snapshot?.pageName || 'Facebook Advertiser';
  const rawBody = (typeof raw.body === 'string' ? raw.body : raw.body?.text) || raw.description || raw.snapshot?.body?.text || raw.snapshot?.linkDescription || '';

  // Clean title: Avoid raw template tags like {{product.name}}
  let title = raw.title || raw.adTitle || raw.snapshot?.title || '';
  if (!title || title.includes('{{') || title === 'Facebook Ad') {
    if (raw.snapshot?.linkDescription && !raw.snapshot.linkDescription.includes('{{')) {
      title = raw.snapshot.linkDescription;
    } else if (rawBody) {
      const firstLine = rawBody.split('\n').filter(Boolean)[0] || '';
      title = firstLine.slice(0, 120);
    } else {
      title = `${advertiser} Sponsored Ad`;
    }
  }

  const image = extractCreativeImage(raw);
  const video = raw.videoUrl || (raw.snapshot?.videos && (raw.snapshot.videos[0]?.videoSdUrl || raw.snapshot.videos[0]?.videoHdUrl)) || '';
  const cta = raw.ctaText || raw.callToAction || raw.snapshot?.ctaText || raw.snapshot?.ctaType || '';

  let landingDomain = raw.domain || '';
  if (!landingDomain && landingUrl) {
    try {
      landingDomain = new URL(landingUrl).hostname;
    } catch {}
  }

  const fanpageLikes = parseNum(raw.snapshot?.pageLikeCount || raw.pageLikeCount || raw.likes || raw.reactions || 0);
  const views = parseNum(raw.views || raw.impressions || 0);
  const publisherPlatforms = Array.isArray(raw.publisherPlatform) && raw.publisherPlatform.length > 0
    ? raw.publisherPlatform
    : (Array.isArray(raw.snapshot?.publisherPlatform) && raw.snapshot.publisherPlatform.length > 0
      ? raw.snapshot.publisherPlatform
      : ['FACEBOOK']);

  const startDate = raw.startDateFormatted || (raw.startDate ? (typeof raw.startDate === 'number' ? new Date(raw.startDate * 1000).toISOString() : String(raw.startDate)) : '') || raw.firstSeenAt || '';
  const endDate = raw.endDateFormatted || (raw.endDate ? (typeof raw.endDate === 'number' ? new Date(raw.endDate * 1000).toISOString() : String(raw.endDate)) : '') || '';
  const isActive = raw.isActive !== undefined ? Boolean(raw.isActive) : true;

  return {
    uid: `${context.platform}:${archiveId || url || title}`,
    type: 'ad_creative',
    platform: context.platform,
    advertiser,
    author: advertiser,
    title: String(title).substring(0, 200),
    body: String(rawBody),
    url,
    landingUrl,
    landingDomain,
    image,
    video,
    cta,
    startDate,
    endDate,
    isActive,
    publisherPlatforms,
    fanpageLikes,
    firstSeenAt: startDate || new Date().toISOString(),
    likes: fanpageLikes,
    comments: parseNum(raw.comments || 0),
    shares: parseNum(raw.shares || 0),
    views,
    engagement: {
      likes: fanpageLikes,
      comments: parseNum(raw.comments || 0),
      shares: parseNum(raw.shares || 0),
      views
    },
    raw
  };
};
