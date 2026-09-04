/**
 * @deprecated Simplification Round (2026-08-24): this module is NO LONGER used
 * by src/scheduler/scheduler.js or src/scheduler/execution-planner.js. It
 * persisted a moving-average RAM estimate per (platform, backend, mode) and
 * fed it back into admission decisions for the NEXT request — which is wrong:
 * two requests to the same platform+backend can have very different resource
 * cost (maxItems=20 vs maxItems=1000, image enrichment, browser fallback),
 * so "what the last run used" is not a valid predictor for "what this run
 * needs". Resource envelopes are now computed fresh per request in
 * execution-planner.js from that request's own declared shape (see
 * DEFAULT_CLASS_ENVELOPES_MB / computeEnvelope there), never from history.
 *
 * Kept in the tree (not deleted) only as a rollback safety net; do not wire
 * it back into the scheduler without re-reading the reasoning above. The
 * `data/resource-profiles.json` file it used to write is no longer produced.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_PROFILES = {
  "*:cdp:*": { baseMB: 350, baseDurationMs: 15000, pool: "CDP" },
  "*:browser:*": { baseMB: 400, baseDurationMs: 20000, pool: "BROWSER" },
  "*:user-journey:*":{ baseMB: 450, baseDurationMs: 25000, pool: "BROWSER" },
  "shopify:local:*": { baseMB: 80, baseDurationMs: 2500, pool: "LOCAL" },
  "reddit:local:*":{ baseMB: 80, baseDurationMs: 2500, pool: "LOCAL" },
  "etsy:local:*": { baseMB: 160, baseDurationMs: 8000, pool: "LOCAL" },
  "ebay:local:*": { baseMB: 160, baseDurationMs: 8000, pool: "LOCAL" },
  "google_shopping:local:*":{ baseMB: 160, baseDurationMs: 8000, pool: "LOCAL" },
  "*:local:*": { baseMB: 120, baseDurationMs: 6000, pool: "LOCAL" },
  "*:apify:*": { baseMB: 50, baseDurationMs: 10000, pool: "CLOUD" },
  "*:cloud:*": { baseMB: 50, baseDurationMs: 10000, pool: "CLOUD" },
  "*:mock:*": { baseMB: 20, baseDurationMs: 200, pool: "LOCAL" },
  "default":{ baseMB: 100, baseDurationMs: 5000, pool: "LOCAL" }
};

class ResourceProfileManager {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(__dirname, '..', '..', 'data', 'resource-profiles.json');
    this.profiles = new Map();
    this.load();
  }

  makeKey(platform = '*', backend = '*', mode = '*') {
    return [platform || '*', backend || '*', mode || '*'].join(':').toLowerCase();
  }


  resolveDefault(platform, backend, mode) {
    const p = (platform || '*').toLowerCase();
    const b = (backend || '*').toLowerCase();
    const m = (mode || '*').toLowerCase();

    const exactKey = [p, b, m].join(':');
    if (DEFAULT_PROFILES[exactKey]) return DEFAULT_PROFILES[exactKey];

    const pbKey = [p, b, '*'].join(':');
    if (DEFAULT_PROFILES[pbKey]) return DEFAULT_PROFILES[pbKey];

    const wildcardBKey = ['*', b, '*'].join(':');
    if (DEFAULT_PROFILES[wildcardBKey]) return DEFAULT_PROFILES[wildcardBKey];

    const wildcardMKey = ['*', '*', m].join(':');
    if (DEFAULT_PROFILES[wildcardMKey]) return DEFAULT_PROFILES[wildcardMKey];

    return DEFAULT_PROFILES['default'];
  }


  getProfile(platform, backend, mode) {
    const key = this.makeKey(platform, backend, mode);
    if (this.profiles.has(key)) {
      return this.profiles.get(key);
    }
    const def = this.resolveDefault(platform, backend, mode);
    const profile = {
      key,
      sampleCount: 0,
      confidentSampleCount: 0,
      averageMemoryMB: def.baseMB,
      peakMemoryMB: def.baseMB,
      averageDurationMs: def.baseDurationMs,
      estimatedMemoryMB: Math.round(def.baseMB * 1.2),
      lastSampleConfident: null,
      pool: def.pool || 'LOCAL'
    };
    this.profiles.set(key, profile);
    return profile;
  }


  /**
   * `confident` must be false whenever the observed memory delta cannot be
   * attributed to this run alone (e.g. other runs were sharing the same pool
   * concurrently, so process.memoryUsage() deltas are contaminated). Physical
   * RAM at admission time is always the source of truth for admission decisions
   * (see ResourceMonitor) — this profile is only an *estimate* used to size the
   * next admission request, and estimates are only allowed to grow from a
   * low-confidence sample, never shrink. This avoids the estimate racing to
   * an unsafely low number just because one noisy concurrent sample looked light.
   */
  updateProfile(platform, backend, mode, observedMemoryMB, durationMs, options = {}) {
    const confident = options.confident !== false;
    const profile = this.getProfile(platform, backend, mode);
    const mem = Math.max(10, Math.round(observedMemoryMB || profile.averageMemoryMB));
    const dur = Math.max(50, Math.round(durationMs || profile.averageDurationMs));
    const previousEstimate = profile.estimatedMemoryMB;

    if (profile.sampleCount === 0) {
      profile.averageMemoryMB = mem;
      profile.peakMemoryMB = mem;
      profile.averageDurationMs = dur;
      profile.sampleCount = 1;
    } else {
      const n = profile.sampleCount;
      profile.averageMemoryMB = Math.round((profile.averageMemoryMB * n + mem) / (n + 1));
      profile.peakMemoryMB = Math.max(profile.peakMemoryMB, mem);
      profile.averageDurationMs = Math.round((profile.averageDurationMs * n + dur) / (n + 1));
      profile.sampleCount += 1;
    }

    profile.lastSampleConfident = confident;
    const candidateEstimate = Math.round(Math.max(profile.peakMemoryMB, profile.averageMemoryMB * 1.25));

    if (confident) {
      profile.confidentSampleCount += 1;
      // A confident sample can move the estimate in either direction, but only
      // once we've actually seen enough confident samples to trust a decrease.
      profile.estimatedMemoryMB = profile.confidentSampleCount >= 3
        ? candidateEstimate
        : Math.max(previousEstimate, candidateEstimate);
    } else {
      // Low-confidence (concurrent) sample: peak/average bookkeeping still
      // updates for visibility, but the estimate used for admission may only
      // increase, never decrease, from noisy data.
      profile.estimatedMemoryMB = Math.max(previousEstimate, candidateEstimate);
    }

    this.save();
    return profile;
  }


  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          this.profiles.set(k, v);
        }
      }
    } catch (err) {
      // Start clean
    }
  }


  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.profiles.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      // Ignore persistence error
    }
  }
}

module.exports = { ResourceProfileManager, DEFAULT_PROFILES };