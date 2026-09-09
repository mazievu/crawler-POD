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

/*
 * Two actors feed this normalizer and they disagree on case:
 * apify/facebook-ads-scraper emits camelCase (adArchiveID, collationCount,
 * publisherPlatform), memo23/facebook-ads-library-scraper-ppe emits snake_case
 * (ad_archive_id, collation_count, publisher_platform). Reading both here keeps
 * the fallback usable instead of forcing a second normalizer.
 */
function pick(raw, ...keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Meta publishes reach and the served-country list under DSA transparency for
 * ads delivered in the EU, on the ad's DETAIL page. memo23's `includeAdReach`
 * fetches that page; the search-results endpoint never carries it.
 *
 * Verified 2026-09-08, dataset CD4GGAOYifWYnBow6:
 *   eu_total_reach 2,622,368 / 3,014,085, location_audience [Austria, Germany]
 *
 * Absent for a US-only ad, and that is Meta's scope rather than a scraping
 * failure — the DSA obliges disclosure for EU delivery only.
 */
/**
 * memo23 nests an entirely snake_case snapshot (link_url, cta_text,
 * page_like_count, and inside cards/images/videos original_image_url,
 * video_sd_url…). Rather than teach every read site both spellings, camelCase
 * ALIASES are added alongside the originals, so the existing camelCase reads
 * work on both actors and nothing that already read snake_case breaks.
 */
/**
 * One Library ID can carry several creatives — Meta labels this "Quảng cáo này
 * có nhiều phiên bản" and serves a DIFFERENT one on each page load. Ad
 * 1549200472421776 (CurvLife) holds six cards, which is why opening its Ad
 * Library link twice showed two different pictures and looked like a wrong URL.
 *
 * Storing only the cover image hid that entirely, so the count and the full
 * list are carried through and the card can say how many versions exist.
 */
function extractCreativeMedia(raw) {
  const snap = raw.snapshot || {};
  const items = [];

  for (const card of (snap.cards || [])) {
    const imageUrl = card.originalImageUrl || card.resizedImageUrl || card.videoPreviewImageUrl || '';
    const videoUrl = card.videoSdUrl || card.videoHdUrl || '';
    if (imageUrl || videoUrl) items.push({ type: videoUrl ? 'video' : 'image', imageUrl, videoUrl });
  }
  for (const img of (snap.images || [])) {
    const imageUrl = img.originalImageUrl || img.resizedImageUrl || img.url || '';
    if (imageUrl) items.push({ type: 'image', imageUrl, videoUrl: '' });
  }
  for (const vid of (snap.videos || [])) {
    const videoUrl = vid.videoSdUrl || vid.videoHdUrl || '';
    const imageUrl = vid.videoPreviewImageUrl || vid.previewUrl || '';
    if (videoUrl || imageUrl) items.push({ type: 'video', imageUrl, videoUrl });
  }

  const mediaType = items.length > 1
    ? 'carousel'
    : (items[0]?.type || '');

  return { mediaItems: items, mediaCount: items.length, mediaType };
}

function withCamelAliases(value) {
  if (Array.isArray(value)) return value.map(withCamelAliases);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const converted = withCamelAliases(val);
    out[key] = converted;
    const camel = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (camel !== key && out[camel] === undefined) out[camel] = converted;
  }
  return out;
}

function readEuTransparency(raw) {
  return raw?.data_reach?.ad_library_main?.ad_details?.transparency_by_location?.eu_transparency
    || raw?.eu_transparency
    || null;
}

module.exports = function normalizeAdCreative(rawInput, context = { platform: 'facebook_ads' }) {
  // data_reach is deliberately left out of the alias pass: it is a large nested
  // GraphQL blob read by path in readEuTransparency(), not by camelCase keys.
  const raw = rawInput?.snapshot
    ? { ...rawInput, snapshot: withCamelAliases(rawInput.snapshot) }
    : rawInput;

  const archiveId = raw.adArchiveId || raw.adArchiveID || raw.ad_archive_id || raw.id || '';
  const adLibraryUrl = archiveId ? `https://www.facebook.com/ads/library/?id=${archiveId}` : '';
  const landingUrl = raw.snapshot?.linkUrl || raw.Website || raw.url || raw.adUrl || raw.permalink || raw.inputUrl || '';
  const url = adLibraryUrl || landingUrl || '';

  const advertiser = pick(raw, 'advertiserName', 'author', 'pageName', 'page_name')
    || raw.snapshot?.pageName || 'Facebook Advertiser';
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
  const media = extractCreativeMedia(raw);
  const cta = raw.ctaText || raw.callToAction || raw.snapshot?.ctaText || raw.snapshot?.ctaType || '';

  let landingDomain = raw.domain || '';
  if (!landingDomain && landingUrl) {
    try {
      landingDomain = new URL(landingUrl).hostname;
    } catch {}
  }

  const fanpageLikes = parseNum(raw.snapshot?.pageLikeCount || raw.pageLikeCount || raw.likes || raw.reactions || 0);

  /*
   * Task 4 — audited against 5 real ads from apify/facebook-ads-scraper
   * (run le7PpnR25ZkhJNtDD, query "press on nails", country US, 2026-09-07).
   *
   * adCount        <- collationCount. Real, and genuinely nullable: the sample
   *                   returned null, 1, 2, 4, null. null means "this ad is not
   *                   part of a collation", which is not the same as 0 ads, so
   *                   it stays null rather than being flattened to a number.
   *
   * views          <- SOURCE_NOT_AVAILABLE. The payload carries no `views` and
   *                   no `impressions` key at all — the two the previous line
   *                   read never existed, which is why views was always 0. What
   *                   the actor does return is impressionsWithIndex, and on all
   *                   5 ads that was {impressionsText: null, impressionsIndex:
   *                   -1}; reachEstimate and spend were null too. Meta only
   *                   publishes impression/spend ranges for political and
   *                   social-issue ads, so commercial ads carry none. The field
   *                   is read here so a political ad WOULD report it, but
   *                   nothing is invented when it is absent.
   *
   * activeCountries<- targetedOrReachedCountries. Present in the schema but []
   *                   on all 5 commercial ads, for the same transparency-scope
   *                   reason. An empty list is reported as empty, never guessed
   *                   from the search country.
   */
  const eu = readEuTransparency(raw);

  // total_ads_count is the advertiser's live ad count from the detail page and
  // is a real number (75 / 60 / 82 / 10 on the verification run). collationCount
  // only counts ads sharing this creative and is null when there is no
  // collation, so it is the weaker fallback, not the first choice.
  // 0 is treated as "the count did not come back", not as a real zero: this ad
  // is IN the library, so its page has at least one ad. Observed on run #782,
  // where NAILD returned total_ads_count 0 while the same page returned 82
  // twenty minutes earlier — a failed sub-fetch, not a page with no ads.
  const totalAdsCount = parseNum(pick(raw, 'total_ads_count', 'totalAdsCount') ?? 0);
  const collation = pick(raw, 'collationCount', 'collation_count');
  const adCount = totalAdsCount > 0
    ? totalAdsCount
    : (collation == null ? null : parseNum(collation));

  // eu_total_reach is the number of people Meta reports the ad reached in the
  // EU. impressionsText only ever appears on political / social-issue ads, so
  // it stays as the fallback rather than the primary.
  const impressionsText = pick(raw, 'impressionsWithIndex', 'impressions_with_index')?.impressionsText
    ?? pick(raw, 'impressionsWithIndex', 'impressions_with_index')?.impressions_text;
  const views = eu?.eu_total_reach != null
    ? parseNum(eu.eu_total_reach)
    : (impressionsText != null ? parseNum(impressionsText) : parseNum(raw.views ?? raw.impressions ?? 0));

  // location_audience names the countries the ad is actually served in and is
  // populated for EU delivery; targetedOrReachedCountries was [] on every
  // commercial ad tested, so it is the fallback.
  const euCountries = Array.isArray(eu?.location_audience)
    ? eu.location_audience.filter((c) => c && !c.excluded && c.name).map((c) => String(c.name))
    : [];
  const reachedCountries = pick(raw, 'targetedOrReachedCountries', 'targeted_or_reached_countries');
  const activeCountries = euCountries.length
    ? euCountries
    : (Array.isArray(reachedCountries) ? reachedCountries.filter((c) => typeof c === 'string' && c.trim()) : []);
  const rawPlatforms = pick(raw, 'publisherPlatform', 'publisher_platform');
  const publisherPlatforms = Array.isArray(rawPlatforms) && rawPlatforms.length > 0
    ? rawPlatforms
    : (Array.isArray(raw.snapshot?.publisherPlatform) && raw.snapshot.publisherPlatform.length > 0
      ? raw.snapshot.publisherPlatform
      : ['FACEBOOK']);

  // memo23 sends start_date as a unix timestamp; the older actor sends a
  // preformatted ISO string. Both end up as ISO-8601 UTC.
  const rawStart = pick(raw, 'startDateFormatted', 'start_date_formatted', 'startDate', 'start_date');
  const startDate = (typeof rawStart === 'number' ? new Date(rawStart * 1000).toISOString() : (rawStart ? String(rawStart) : '')) || raw.firstSeenAt || '';
  const endDate = raw.endDateFormatted || (raw.endDate ? (typeof raw.endDate === 'number' ? new Date(raw.endDate * 1000).toISOString() : String(raw.endDate)) : '') || '';
  const isActive = pick(raw, 'isActive', 'is_active') !== undefined ? Boolean(pick(raw, 'isActive', 'is_active')) : true;

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
    videoUrl: video,
    mediaItems: media.mediaItems,
    mediaCount: media.mediaCount,
    mediaType: media.mediaType,
    cta,
    startDate,
    endDate,
    isActive,
    publisherPlatforms,
    adCount,
    activeCountries,
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
