'use strict';

/*
 * Which metrics a product card shows, per platform — as DATA, not as HTML.
 *
 * WHY THIS IS ITS OWN FILE
 * The card used to present its numbers two different ways: most of them in a
 * vertical box, but a few (TikTok Shop's return position / 30-day sales / GMV,
 * and Facebook Ads' ad count / views / countries) on a horizontal dot-separated
 * line above it. Unifying those into one vertical form meant touching the one
 * piece of card logic that is genuinely easy to break silently: a metric can be
 * dropped for a single platform and nothing complains. Returning row descriptors
 * instead of a string makes that testable in Node with no DOM — see
 * test/item-metric-rows.test.js, which pins every platform's row set.
 *
 * The formatting helpers are injected rather than imported because they live in
 * app.js alongside the rest of the browser code. This file therefore has no
 * dependencies at all and loads in either environment.
 *
 * A row is:
 *   { label, value, cls, change }
 * where `change` is null, or { direction: 'up' | 'down', amount } for a metric
 * that moved since the previous crawl. The renderer decides how an arrow looks;
 * this file only decides that there IS one.
 */

const ECOMMERCE_PLATFORMS = ['amazon', 'ebay', 'etsy', 'shopify', 'google_shopping', 'tiktok_shop'];

/** Positive means "moved up", negative "moved down"; 0 and null mean "no change
 *  worth drawing". The amount is always reported positive — direction carries
 *  the sign, so the renderer never has to print "▼ -4". */
function toChange(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return null;
  return { direction: n > 0 ? 'up' : 'down', amount: Math.abs(n) };
}

function buildItemMetricRows(item, helpers) {
  const { formatCommas, formatNum, formatTimeAgo, escapeHtml } = helpers;
  const platform = item.platform;
  const rows = [];

  const updatedAt = item.last_crawled_at || item.last_seen_at || item.created_at;

  if (ECOMMERCE_PLATFORMS.includes(platform)) {
    // A listing reports either impressions or units, never reliably both, so the
    // first row is whichever one this source actually gave us.
    const viewsVal = Number(item.views || 0);
    const soldVal = Number(item.sold_count || item.soldCount || 0);
    if (viewsVal > 0) {
      rows.push({ label: 'Views', value: formatCommas(viewsVal), cls: 'val-red', change: toChange(item.growth?.views) });
    } else if (soldVal > 0) {
      rows.push({ label: 'Sold', value: formatCommas(soldVal), cls: 'val-red', change: toChange(item.growth?.soldCount) });
    } else {
      rows.push({ label: 'Views', value: '—', cls: 'val-red', change: null });
    }

    const dailyViews = Number(item.delta_24h_views || item.delta_views || item.growth?.views || 0);
    const dailySold = Number(item.delta_24h_sold || item.growth?.soldCount || 0);
    if (dailyViews !== 0) {
      rows.push({ label: 'Daily views', value: formatCommas(dailyViews), cls: 'val-red', change: null });
    } else if (dailySold !== 0) {
      rows.push({ label: 'Daily sales', value: formatCommas(dailySold), cls: 'val-red', change: null });
    } else {
      rows.push({ label: 'Daily views', value: '0', cls: 'val-red', change: null });
    }

    /*
     * A number only ever appears under its own name.
     *
     * This row used to be a single one whose value was
     *   item.likes || item.saves || item.reviews
     * so an Amazon listing with 0 likes and 361 reviews rendered "Likes 361" —
     * a review count wearing the label of a metric Amazon does not have, while
     * the detail view for that same product correctly said "361 reviews".
     * Falling one metric back onto another's label is how a card ends up
     * stating something that is simply untrue.
     *
     * Each metric is now its own row and appears only when it has a value, so a
     * platform that does not report something says nothing about it rather than
     * borrowing a neighbour's number.
     */
    const likesVal = Number(item.likes || item.saves || 0);
    if (likesVal > 0) {
      const likeLabel = platform === 'etsy' ? 'Favorers' : (platform === 'ebay' ? 'Watchers' : 'Likes');
      rows.push({ label: likeLabel, value: formatCommas(likesVal), cls: 'val-blue', change: toChange(item.growth?.likes) });
    }

    const reviewsVal = Number(item.reviews || 0);
    if (reviewsVal > 0) {
      // "Feedback" is eBay's own word for a review count, and the word the item
      // detail view already uses for it.
      rows.push({
        label: platform === 'ebay' ? 'Feedback' : 'Reviews',
        value: formatCommas(reviewsVal),
        cls: 'val-blue',
        change: toChange(item.growth?.reviews),
      });
    }

    /*
     * TikTok Shop's three marketplace metrics. These used to sit on a horizontal
     * line above the box reading "#7 return position ▲3 · 30d: 913 · GMV $11.4K".
     * Same three values, now rows — including the position arrow, which is the
     * only movement indicator that line carried.
     *
     * Each is emitted only when the provider actually supplied it: pratikdani
     * reports sold30d/gmv, the other TikTok Shop actor does not, and printing a
     * zero for a number nobody reported would read as "this product sells
     * nothing" rather than "this source does not say".
     */
    if (platform === 'tiktok_shop') {
      if (item.returnPosition) {
        rows.push({
          label: 'Return position',
          value: `#${item.returnPosition}`,
          cls: 'val-orange',
          change: toChange(item.returnPositionChange),
        });
      }
      if (item.sold30d) {
        rows.push({ label: 'Sold 30d', value: formatNum(item.sold30d), cls: 'val-red', change: null });
      }
      if (item.gmv) {
        rows.push({ label: 'GMV', value: `$${formatNum(item.gmv)}`, cls: 'val-teal', change: null });
      }
    }

    rows.push({
      label: 'Created',
      value: formatTimeAgo(item.first_seen_at || item.startDate || item.created_at),
      cls: 'val-teal',
      change: null,
    });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });

  } else if (platform === 'facebook_ads') {
    rows.push({ label: 'Số QC', value: formatCommas(item.adCount ?? 1), cls: 'val-red', change: null });
    rows.push({
      label: 'Fanpage Likes',
      value: formatCommas(item.fanpageLikes || item.likes || 0),
      cls: 'val-blue',
      change: null,
    });
    // Meta publishes reach for EU-targeted ads only. A 0 here would be a claim
    // about the ad; "Meta N/A" is a claim about the source, which is the truth.
    rows.push({
      label: 'Views',
      value: Number(item.views) > 0 ? formatCommas(item.views) : 'Meta N/A',
      cls: 'val-orange',
      change: null,
    });
    // Moved in from the old emoji line under the price, so the whole ad story is
    // in one place.
    rows.push({
      label: 'Quốc gia',
      value: Array.isArray(item.activeCountries) && item.activeCountries.length
        ? item.activeCountries.map((c) => escapeHtml(c)).join(', ')
        : 'Meta N/A',
      cls: 'val-teal',
      change: null,
    });
    rows.push({
      label: 'Bắt đầu',
      value: formatTimeAgo(item.startDate || item.first_seen_at),
      cls: 'val-teal',
      change: null,
    });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });

  } else if (platform === 'reddit') {
    rows.push({ label: 'Upvotes', value: formatCommas(item.likes || 0), cls: 'val-red', change: toChange(item.growth?.likes) });
    rows.push({ label: 'Comments', value: formatCommas(item.comments || 0), cls: 'val-blue', change: toChange(item.growth?.comments) });
    rows.push({
      label: 'Subreddit',
      value: item.subreddit ? `r/${escapeHtml(item.subreddit)}` : '—',
      cls: 'val-teal',
      change: null,
    });
    rows.push({ label: 'Created', value: formatTimeAgo(item.first_seen_at || item.created_at), cls: 'val-teal', change: null });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });

  } else if (platform === 'twitter') {
    rows.push({ label: 'Views', value: formatCommas(item.views || 0), cls: 'val-red', change: toChange(item.growth?.views) });
    rows.push({ label: 'Likes', value: formatCommas(item.likes || 0), cls: 'val-blue', change: toChange(item.growth?.likes) });
    rows.push({ label: 'Replies', value: formatCommas(item.comments || 0), cls: 'val-orange', change: toChange(item.growth?.comments) });
    rows.push({ label: 'Retweets', value: formatCommas(item.shares || 0), cls: 'val-blue', change: toChange(item.growth?.shares) });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });

  } else if (platform === 'facebook_posts') {
    // Facebook post search reports engagement only — no impression count. The
    // generic social branch below would have printed "Views 0", which reads as
    // "nobody saw this" rather than "Facebook does not publish that".
    rows.push({ label: 'Likes', value: formatCommas(item.likes || 0), cls: 'val-red', change: toChange(item.growth?.likes) });
    rows.push({ label: 'Comments', value: formatCommas(item.comments || 0), cls: 'val-blue', change: toChange(item.growth?.comments) });
    rows.push({ label: 'Shares', value: formatCommas(item.shares || 0), cls: 'val-orange', change: toChange(item.growth?.shares) });
    rows.push({ label: 'Created', value: formatTimeAgo(item.first_seen_at || item.created_at), cls: 'val-teal', change: null });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });

  } else {
    // TikTok videos, Instagram, Pinterest — anything whose unit of content is a
    // post rather than a listing, and which does report impressions.
    rows.push({ label: 'Views', value: formatCommas(item.views || 0), cls: 'val-red', change: toChange(item.growth?.views) });
    rows.push({ label: 'Likes', value: formatCommas(item.likes || 0), cls: 'val-blue', change: toChange(item.growth?.likes) });
    rows.push({ label: 'Comments', value: formatCommas(item.comments || 0), cls: 'val-orange', change: toChange(item.growth?.comments) });
    rows.push({
      label: 'Shares / Saves',
      value: formatCommas(item.shares || item.saves || 0),
      cls: 'val-blue',
      change: toChange(item.growth?.shares),
    });
    rows.push({ label: 'Updated', value: formatTimeAgo(updatedAt), cls: 'val-teal', change: null });
  }

  return rows;
}

// Loaded as a plain <script> in the browser and require()d by the test.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildItemMetricRows, toChange, ECOMMERCE_PLATFORMS };
} else if (typeof window !== 'undefined') {
  window.buildItemMetricRows = buildItemMetricRows;
}
