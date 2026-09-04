# Master Fix Round — 12 Confirmed Bugs + 6 Architecture Gaps

Date: 2026-08-27
Scope: fix the 12 confirmed bugs directly (no re-discovery), verify the 6 architecture-gap invariants against current source and close only what's still open. No redesign, no paid calls, no DB rebuild.

---

## A. 12 Confirmed Bugs

```
ID: UI-BUG-01
BEFORE: /api/items/:uid/history (READ_MODEL_V2 path) returned only metric
  fields (price/likes/comments/shares/views/sold) per observation — no
  title/platform/url/image/author/status. The Product Detail modal renders
  history[history.length-1].title/platform/url, so it showed "Untitled",
  platform `undefined`, and no "View Source" link.
ROOT CAUSE: daily_packed_history observations only ever carried metric
  fields (by design — that data lives in product_current instead). The
  route handler never merged product_current's static fields back in.
FIX: extracted the route's logic into db.getProductHistoryWithMetadata(uid),
  which looks up product_current once and denormalizes
  platform/title/url/image/author/status onto every history point.
FILES CHANGED: src/database.js, server.js
TEST: test/master-fix-round.test.js — "getProductHistoryWithMetadata()
  returns real title/platform/url/image, not Untitled/undefined" (PASS).
  Also verified live via a real Shopify crawl + GET /api/items/:uid/history:
  title/platform/url all correct.
RESULT: FIXED
```

```
ID: UI-BUG-03
BEFORE: DELETE /api/runs/:id (the only "Cancel/Stop" affordance for an
  active job in the UI) unconditionally called db.deleteRun(id) — the real
  scraper/browser/backend call kept running unattended in the background,
  orphaned from the now-deleted DB row.
ROOT CAUSE: the route never called into ExecutionControlRegistry at all —
  it only ever touched the DB row.
FIX: before deleting a run whose status is running/queued/pending, extract
  its current executionToken from input_options and call
  abortExecution(token, 'USER_CANCELLED') — reuses the same registry
  StuckDetector already uses, no new mechanism.
FILES CHANGED: server.js
TEST: not automated — this repo has no HTTP test harness for server.js
  routes, and building one is new test infrastructure (out of scope for a
  "no new framework" round). Verified by code review: the call site uses
  the exact same abortExecution(token, reason) function already covered by
  reliability.test.js's StuckDetector/ExecutionControl tests.
RESULT: FIXED (verification: code review only, documented above)
```

```
ID: UI-BUG-07
BEFORE: parseMarketplaceHtml() for Amazon fell through to
  findFirstTag(html,'h1') when JSON-LD/meta tags were absent (the normal
  case for Amazon) — grabbing Amazon's accessibility-only skip-navigation
  <h1> ("Amazon.com"), never the real title (in <span id="productTitle">,
  not an h1 at all). Price/rating/reviews had no Amazon-specific fallback
  either.
ROOT CAUSE: the parser is 100% generic (schema.org JSON-LD + meta tags);
  Amazon deliberately doesn't emit rich Product structured data.
FIX: added a targeted extractAmazonFallback(html) tier, consulted only for
  platform==='amazon', using Amazon's real DOM anchors: #productTitle,
  .a-offscreen price, "X out of 5 stars" rating text,
  #acrCustomerReviewText/#acrCustomerReviewCount, #landingImage.
FILES CHANGED: src/marketplaces/html-parser.js
TEST: test/master-fix-round.test.js — "parseMarketplaceHtml() extracts real
  Amazon title/price/rating/reviews/image, not the accessibility h1" (PASS).
RESULT: FIXED
```

```
ID: BUG-08
BEFORE: apify-client.js's instagram INPUT_BUILDER passed `query` straight
  through as `search`. The Social Bot's seed queries (bot-config.js) are
  written with a leading '#' (e.g. "#podfashion") the way a human types a
  hashtag, but the apify/instagram-search-scraper actor's `hashtag` search
  type expects the bare tag with no '#'.
ROOT CAUSE: no normalization between "how a hashtag is written" and "what
  the actor's hashtag search type expects."
FIX: strip a leading '#' (one or more) from `query` before assigning it to
  `search`, at the single point every caller (manual run or bot) goes
  through.
FILES CHANGED: src/apify-client.js
TEST: test/master-fix-round.test.js — "Instagram Actor input strips leading
  # from hashtag queries" (PASS, both with and without leading #).
RESULT: FIXED
```

```
ID: UI-BUG-10
BEFORE: checkpoint-store.js's processAndSaveProductDetail() called
  db.insertSnapshots(runId, ..., [productRecord]) once PER PRODUCT inside
  the User Journey's per-item loop. insertSnapshots() unconditionally
  OVERWRITES runs.result_items_json with exactly the batch it's given
  (correct for its normal one-call-per-Run contract) — so N per-item calls
  left only the LAST product in result_items_json.
ROOT CAUSE: a one-call-per-Run function was called once per item, violating
  its own contract.
FIX: CheckpointStore now only accumulates in-memory (savedProducts); the
  caller (user-journey-runner.js) makes exactly ONE insertSnapshots() call
  with the FULL accumulated batch after each loop completes. Per-iteration
  assertOwner() checks were kept (cheap, no I/O) so a revoked lease is still
  caught as early as before — only the WRITE moved, not the ownership check.
FILES CHANGED: src/journey/checkpoint-store.js, src/journey/user-journey-runner.js
TEST: test/master-fix-round.test.js — "User Journey accumulates ALL products
  into result_items_json, not just the last one" (PASS) — asserts exactly
  ONE insertSnapshots call carrying all 3 items, and result_items_json
  contains all 3 titles.
RESULT: FIXED
```

```
ID: UI-BUG-02
BEFORE: doctor/index.js's channel status computation:
  `channelReport.status = hasFallback || candidateBackends.length===1 ? 'ok' : 'warn'`.
  For Shopify (2 candidates: local-scraper healthy, apify unverified/
  misconfigured), hasFallback stays false (needs a SECOND ok backend), so
  the channel was marked 'warn' -> UI badge "NEEDS SETUP", even though the
  actual activeBackend (local-scraper) was completely healthy.
ROOT CAUSE: "is there a backup ready too" (hasFallback) was conflated with
  "does this channel work right now" — a healthy primary backend was
  dragged down by an unrelated unready paid fallback nobody is using.
FIX: channel status is 'ok' whenever hasOkBackend is true, regardless of
  fallback readiness or candidate count. An unready fallback is still
  visible per-backend in channelReport.backends.
FILES CHANGED: src/doctor/index.js
TEST: test/master-fix-round.test.js — "Shopify channel reports ok when
  local-scraper is the healthy active backend..." (PASS). Also verified
  live via GET /api/doctor?json=true: shopify.status === "ok".
RESULT: FIXED
```

```
ID: UI-BUG-04
BEFORE: SQLite's naive "YYYY-MM-DD HH:MM:SS" UTC timestamps (no 'Z'/offset)
  were passed straight to `new Date(...)` in the UI and written verbatim
  into the CSV export. Browsers parse a space-separated, marker-less
  timestamp as LOCAL time, not UTC — so a UTC value gets re-interpreted as
  already-local, shifting every displayed time by the viewer's UTC offset
  (~7h for Vietnam/ICT).
ROOT CAUSE: ambiguous timestamp format, parsed inconsistently between "the
  value's real timezone (UTC)" and "how a marker-less string is parsed."
FIX: (1) added parseServerTimestamp() in public/app.js — detects the naive
  "YYYY-MM-DD HH:MM:SS" shape and explicitly appends 'Z' before parsing;
  replaced every `new Date(server_field)` call site in the file with it.
  (2) added db.formatVietnamTime() — converts the same naive UTC string to
  an explicit, labeled Asia/Ho_Chi_Minh time for the CSV export, matching
  the "(Vietnam)" convention already used elsewhere in the app.
FILES CHANGED: public/app.js, src/database.js, server.js
TEST: test/master-fix-round.test.js — "formatVietnamTime() converts naive
  UTC timestamps to explicit Vietnam-local time" (PASS). Also verified live
  via CSV export: "27/08/2026 11:47:54 (Vietnam)" for a run created at
  "...04:47:54" UTC (exact +7h shift, explicitly labeled).
RESULT: FIXED
```

```
ID: UI-BUG-06
BEFORE: the interactive marketplace-login browser factory always resolved
  to the SAME shared 'public' Chromium profile directory
  (data/everbee-profiles/<platform>/public) — resolveEverbeeProfileDir()
  falls back to 'public' whenever no numeric accountId is given, which the
  interactive login flow never provides. Two overlapping login attempts (or
  a stale not-yet-cancelled session) collided on Chromium's own
  ProcessSingleton lock inside that shared directory.
ROOT CAUSE: a persistent-profile mechanism (correct for saved accounts,
  keyed by accountId) was reused for a throwaway, one-off login capture
  that should never share a directory with another concurrent attempt.
FIX: added an optional `sessionKey` param to resolveEverbeeProfileDir()/
  createEverbeeContextSession() that resolves to a private
  `session-<key>` directory, taking priority over the accountId/'public'
  logic (fully backward-compatible — existing accountId callers untouched).
  openInteractiveLogin() now generates a unique sessionKey per call and
  passes it to the browser factory.
FILES CHANGED: src/marketplaces/everbee-executor.js, src/marketplaces/session-login.js
TEST: test/master-fix-round.test.js — "resolveEverbeeProfileDir() gives
  distinct sessionKeys distinct profile dirs" and "openInteractiveLogin()
  passes a unique sessionKey to the browser factory on every call" (both PASS).
RESULT: FIXED
```

```
ID: UI-BUG-09
BEFORE: Jobs History only rendered an error box when
  status==='failed' AND health_snapshot.error existed. Most failure/stuck
  paths (generic try/catch failures, StuckDetector's
  RECOVERY_CLEANUP_FAILED) only set error_message, never a health_snapshot
  with an .error field — so nothing was shown for them at all.
ROOT CAUSE: error_message (the more universally-populated field) was never
  read by this rendering path.
FIX: added a fallback render using j.error_message whenever the richer
  snapshot-based rendering produced nothing, and extended the condition/
  status badge to also cover status==='stuck' (StuckDetector's terminal
  state), not only 'failed'.
FILES CHANGED: public/app.js
TEST: not automated — pure DOM-rendering change in public/app.js, this repo
  has no DOM/jsdom test harness (would be new framework). Verified by code
  review; logic mirrors the already-present snapshot-based rendering.
RESULT: FIXED (verification: code review only, documented above)
```

```
ID: BUG-11
BEFORE: AmazonJourneyHandler.extractListingUrls() deduped candidate product
  links with `set.add(a.href.split('?')[0])` — a raw URL-string Set. The
  same product commonly appears multiple times on a results page with
  different SEO slug text or tracking suffixes ahead of the same
  /dp/<ASIN>, which this treats as distinct products.
ROOT CAUSE: dedup key was the raw href, not Amazon's real product identity
  (the ASIN embedded in the URL).
FIX: extract the ASIN via the same regex pattern already used elsewhere in
  this codebase (html-parser.js's listingIdFromUrl) and dedupe by ASIN,
  falling back to the raw URL only when no ASIN can be extracted.
FILES CHANGED: src/journey/amazon-journey.js
TEST: test/master-fix-round.test.js — "AmazonJourneyHandler.extractListingUrls()
  dedupes by ASIN, not raw URL" (PASS — 3 links with 2 unique ASINs collapse to 2 URLs).
RESULT: FIXED
```

```
ID: BUG-12
BEFORE: bot-config.js's DEFAULT_BOT_CONFIGS had facebook=120min,
  reddit=60min, instagram=120min, twitter=60min — none matched the 3-hour
  (180min) cadence requirement. The already-persisted data/social-bots.json
  runtime state (which overrides source defaults on load) had reddit=45min
  too.
ROOT CAUSE: config values were never set to the 180min target; separately,
  a persisted runtime-state file would have silently overridden any source
  fix without also being updated.
FIX: set intervalMinutes: 180 for all 4 enabled bots in both
  bot-config.js's source defaults AND the persisted data/social-bots.json
  (not the SQLite DB — a small JSON config file the app itself manages),
  so the fix takes effect on next boot without a manual data reset.
FILES CHANGED: src/social-bots/bot-config.js, data/social-bots.json
TEST: test/master-fix-round.test.js — "all enabled Social Bots default to
  180-minute (3h) cadence" (PASS).
RESULT: FIXED
```

```
ID: UI-BUG-05
BEFORE: the cookie/storage-state helper text under the Marketplace Accounts
  form was static HTML: "Một cookie Etsy được tự gán domain .etsy.com" —
  regardless of which platform (Amazon/eBay/Etsy) was selected in the
  dropdown right above it.
ROOT CAUSE: the hint text was never wired to the platform selector's onchange.
FIX: gave the hint element an id; added updateMarketplaceCookieHint(platform),
  called from loadMarketplaceAccounts() (already invoked on the select's
  onchange and on initial load), rendering the correct platform name/domain.
FILES CHANGED: public/index.html, public/app.js
TEST: not automated — pure DOM text, no DOM/jsdom test harness in this
  repo. Verified by code review.
RESULT: FIXED (verification: code review only, documented above)
```

---

## B. Architecture Gaps — verified against current source, all already closed

No new code was needed for any of these — each was already implemented (matching the design proposed in the prior investigation round), confirmed by direct source reading and by running the existing targeted regression tests.

```
ID: ARCH-GAP-01 (retry before old attempt settles)
VERIFY: src/scheduler/scheduler.js tick() — hasLiveAttempt check (checks
  activeRunMetrics + cleanupFailedTokens by runId) before admission,
  independent of pool concurrency.
TEST: test/scheduler.test.js has multiple localConcurrency:2 tests
  exercising exactly this (line 194, 362, 450).
RESULT: ALREADY_FIXED
```

```
ID: ARCH-GAP-02 (channel crawler execution control)
VERIFY: src/runs.service.js registers every channel execution with
  registerExecution()/unregisterExecution() and threads the SAME
  AbortSignal into BackendRouter.run(). Confirmed the signal reaches real
  I/O in reddit.js, ebay.js, etsy.js, search-discovery.js, shopify.js (all
  check options.signal / options.signal.aborted at their fetch/loop boundaries).
TEST: test/reliability.test.js — "Channel execution registers with
  ExecutionControlRegistry and downstream work observes abortExecution()
  via the threaded signal (#2)".
RESULT: ALREADY_FIXED
```

```
ID: ARCH-GAP-03 (history parity to observation level)
VERIFY: src/database.js checkV2Parity() computes expectedObservationId =
  `legacy:${snap.id}`, finds the exact packed observation, and compares
  every applicable metric (including reviews) — historyMetricMismatches.
TEST: test/db-cutover.test.js — "checkV2Parity detects a full-metric
  mismatch beyond price/likes" and reviews-specific mismatch assertions
  (lines 168-188, 457-475).
RESULT: ALREADY_FIXED
```

```
ID: ARCH-GAP-04 (restart recovery vs. external CDP/Apify execution)
VERIFY: src/scheduler/scheduler.js's admission loop calls
  isApifyActorTerminal() and blocks retry while an old Apify actor run is
  still active/unconfirmed; src/reliability/restart-recovery.js has
  matching CDP/Apify probe-before-requeue logic with injectable fake probes.
TEST: test/reliability.test.js — "RestartRecovery refuses to requeue a Run
  whose external CDP process is still alive (#4.G)" and the Apify
  equivalent (#4.H), both present and passing.
RESULT: ALREADY_FIXED
```

```
ID: ARCH-GAP-05 (marketplace lost claim reporting fake success)
VERIFY: src/marketplaces/capture-scheduler.js checks markComplete()'s
  return value; on false, sets summary.error='MARKETPLACE_CLAIM_LOST' and
  summary.claimLost=true instead of returning a normal-looking summary.
TEST: test/marketplace-scheduler.test.js — "run() reports claimLost, not
  fake success, when ownership is stolen right before the final
  markComplete (#5)".
RESULT: ALREADY_FIXED
```

```
ID: ARCH-GAP-06 (no-orphan checker coverage)
VERIFY: src/reliability/system-invariants.js's assertSystemInvariants()
  covers worker-slot/lock/RAM-reservation orphans (3 of the 7 entity
  classes identified in the investigation round: Run-status, execution
  registry, heartbeat, marketplace claim, and external process orphans are
  not covered). This round found no NEW concrete orphan bug in any of those
  5 uncovered classes — extending the checker further would be architecture
  for its own sake, not a fix for a found defect.
FIX: none applied.
RESULT: NO_CODE_FIX (documented scope gap, not a bug — matches instruction
  "chỉ sửa code nếu tìm thấy concrete orphan bug")
```

---

## C. Validation

```
npm test (run 1):  217/217 pass, 0 fail, 0 cancelled
npm test (run 2):  217/217 pass, 0 fail, 0 cancelled (reliability/scheduler files touched this round)
npm run validate:codemap: PASS
DB integrity_check: ok
DB malformed observations: 0
DB duplicate observationIds: 0
DB orphan running Runs: 0
Legacy snapshot count: 188 (unchanged — LEGACY_SNAPSHOT_WRITE=false holding)
Free live E2E (Shopify, public storefront, no cost):
  - Doctor: shopify.status === "ok" (UI-BUG-02 confirmed live)
  - Real crawl -> /api/items/:uid/history: title/platform/url all correct (UI-BUG-01 confirmed live)
  - CSV export: "27/08/2026 11:47:54 (Vietnam)" — correctly shifted +7h and labeled (UI-BUG-04 confirmed live)
  - Test run deleted afterward; no test data left in the live DB
No Apify actor, no paid proxy, no paid Social Bot trigger was run this round.
```

---

## D. Final Summary

```
Bugs fixed: 12/12 (UI-BUG-01, UI-BUG-02, UI-BUG-03, UI-BUG-04, UI-BUG-05,
  UI-BUG-06, UI-BUG-07, UI-BUG-09, UI-BUG-10, BUG-08, BUG-11, BUG-12)
Architecture gaps closed: 5/6 already closed in source (ARCH-GAP-01..05);
  1/6 is a documented, non-bug scope gap with no code fix needed (ARCH-GAP-06)
Still open: none of the 12 confirmed bugs; ARCH-GAP-06's broader orphan
  coverage remains a documented scope gap (not a defect) for a future round
  if a concrete orphan bug is ever found in one of its 5 uncovered classes
NEED_HUMAN: none in this round (no login/CAPTCHA/credential-gated fix was required)
Paid tests intentionally skipped: none needed to be skipped this round — all
  12 fixes and all 6 gap verifications were provable via free/local means
  (unit tests, a free public Shopify crawl, and direct source reading)
npm test: 217/217 pass, 0 fail, 0 cancelled (2 consecutive runs)
codemap: PASS
DB integrity: ok, 0 malformed, 0 duplicate, 0 orphan running Run, legacy count unchanged (188)
Modified files:
  src/marketplaces/html-parser.js (UI-BUG-07)
  src/apify-client.js (BUG-08)
  src/journey/checkpoint-store.js (UI-BUG-10)
  src/journey/user-journey-runner.js (UI-BUG-10)
  src/journey/amazon-journey.js (BUG-11)
  src/social-bots/bot-config.js (BUG-12)
  data/social-bots.json (BUG-12, persisted runtime state)
  server.js (UI-BUG-03, UI-BUG-01, UI-BUG-04)
  src/doctor/index.js (UI-BUG-02)
  public/app.js (UI-BUG-09, UI-BUG-04, UI-BUG-05)
  public/index.html (UI-BUG-05)
  src/marketplaces/everbee-executor.js (UI-BUG-06)
  src/marketplaces/session-login.js (UI-BUG-06)
  src/database.js (UI-BUG-01, UI-BUG-04 — extracted testable helpers)
  test/master-fix-round.test.js (new — regression tests for 9 of the 12 bugs;
    3 are DOM/route-only and documented as code-review-verified, not automated)
  test/scheduler.test.js (cleanup — removed unused waitForSettled import)
```
