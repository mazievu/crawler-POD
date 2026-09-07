/**
 * Product & Ad Ranking Engine
 * Provides a clean, configurable interface for calculating multi-dimensional
 * engagement, growth velocity, and rank scores.
 *
 * P1-1: the weights baked in below (PROVISIONAL_TEST_WEIGHTS) are placeholder
 * values chosen to make the ranking framework testable — they are NOT a
 * business-approved scoring model. Any ranker built without explicit business
 * weights (via the `businessWeights` constructor option or the
 * RANKING_WEIGHTS_JSON env var) runs in provisional mode and reports
 * `isProvisional: true` via getStatus(). Do not treat scores from a provisional
 * ranker as production-grade ranking decisions.
 */

const PROVISIONAL_TEST_WEIGHTS = {
  soldWeight: 2.0,
  likesWeight: 0.8,
  commentsWeight: 1.2,
  sharesWeight: 1.5,
  viewsWeight: 0.05,
  ratingWeight: 1.0,
  growthVelocityWeight: 1.0
};

// Backward-compatible alias for existing callers/tests.
const DEFAULT_WEIGHTS = PROVISIONAL_TEST_WEIGHTS;

function loadBusinessWeightsFromEnv() {
  if (!process.env.RANKING_WEIGHTS_JSON) return null;
  try {
    return JSON.parse(process.env.RANKING_WEIGHTS_JSON);
  } catch (_e) {
    console.warn('[ProductRanker] RANKING_WEIGHTS_JSON is not valid JSON, ignoring it.');
    return null;
  }
}

class ProductRanker {
  constructor(weights = {}, options = {}) {
    const businessWeights = options.businessWeights || loadBusinessWeightsFromEnv();
    const hasExplicitWeights = Boolean(businessWeights) || Object.keys(weights).length > 0;

    this.isProvisional = !hasExplicitWeights;
    this.weights = { ...PROVISIONAL_TEST_WEIGHTS, ...(businessWeights || {}), ...weights };

    if (this.isProvisional && !options.silenceProvisionalWarning) {
      console.warn('[ProductRanker] Using PROVISIONAL/TEST ranking weights (not business-approved). Pass businessWeights or set RANKING_WEIGHTS_JSON before relying on rank_score in production.');
    }
  }

  getWeights() {
    return { ...this.weights };
  }

  setWeights(newWeights = {}) {
    this.weights = { ...this.weights, ...newWeights };
    this.isProvisional = false; // Explicit weights were provided at runtime.
    return this.weights;
  }

  getStatus() {
    return { isProvisional: this.isProvisional, weights: this.getWeights() };
  }

  calculateRankScore(item = {}, customWeights = null) {
    const w = customWeights ? { ...this.weights, ...customWeights } : this.weights;

    const deltaSold = Number(item.delta_sold || item.deltaSold || 0);
    const deltaLikes = Number(item.delta_likes || item.deltaLikes || 0);
    const deltaComments = Number(item.delta_comments || item.deltaComments || 0);
    const deltaShares = Number(item.delta_shares || item.deltaShares || 0);
    const deltaViews = Number(item.delta_views || item.deltaViews || 0);
    const currentRating = Number(item.current_rating || item.rating || 0);
    const delta24hViews = Number(item.delta_24h_views || item.growth?.views || 0);

    const baseScore = (
      (deltaSold * w.soldWeight) +
      (deltaLikes * w.likesWeight) +
      (deltaComments * w.commentsWeight) +
      (deltaShares * w.sharesWeight) +
      (deltaViews * w.viewsWeight) +
      (currentRating * w.ratingWeight) +
      (delta24hViews * w.growthVelocityWeight * 0.02)
    );

    return Number(Math.max(0, baseScore).toFixed(2));
  }

  rankList(items = [], customWeights = null) {
    if (!Array.isArray(items)) return [];
    return items
      .map(item => ({
        ...item,
        rank_score: this.calculateRankScore(item, customWeights)
      }))
      .sort((a, b) => b.rank_score - a.rank_score);
  }
}

// The module-level singleton used by product-current.js is intentionally
// provisional until RANKING_WEIGHTS_JSON is configured; suppress the per-import
// warning here (still surfaced via getStatus() for anyone who checks).
const defaultRanker = new ProductRanker({}, { silenceProvisionalWarning: true });

module.exports = {
  ProductRanker,
  DEFAULT_WEIGHTS,
  PROVISIONAL_TEST_WEIGHTS,
  defaultRanker
};
