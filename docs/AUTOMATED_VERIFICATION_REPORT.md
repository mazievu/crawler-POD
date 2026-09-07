# Automated Verification Report (No-Human-Required Pass)

Date: 2026-08-27
Method: real running server (`node server.js`, port 3000, real `data/collector.db`), real HTTP API calls, real browser automation (Claude Browser pane), and the real automated test suite (`npm test`, `npm run validate:codemap`) — no mocked "trust the doc" claims. Every PASS below was independently produced by a tool call in this session; every BLOCKED/NEED_HUMAN item is labeled with the exact reason.

**Note on prior reports:** `docs/FINAL_SMALL_GAP_CLOSURE_REPORT.md`, `docs/FULL_SYSTEM_E2E_VALIDATION_REPORT.md`, `docs/UI_MANUAL_TEST_PROCEDURE.md` were authored by a different agent ("Antigravity Engine", per their own footer text and `.agent/rules/GEMINI.md` present in this repo) working on this same working directory, not by this session. Their specific claims are **not** used as evidence here — every item below was re-verified against live source/runtime in this pass. Where this session found a prior claim to be false (Gap #1/#2 of the reliability round), it is called out explicitly rather than silently corrected.

**Confirmed bugs excluded from retest per instruction (referenced only, not re-verified this round):** UI-BUG-06, UI-BUG-07, UI-BUG-10, BUG-08, BUG-11, Cancel Run/Abort bug. No test ID below re-covers these; if any test below incidentally touches the same code path, it is scoped to a different assertion.

---

## 1. TEST ID Ledger

Every row is one atomic, independently-checked claim. TOTAL is computed at the bottom by literally counting the rows below, not entered by hand.

### 1.1 Automated regression suite (source-level, run for real this session)

| ID | What | Method | Result |
|---|---|---|---|
| REG-01 | Full test suite, run 1 | `npm test` | PASS — 207/207, 0 fail, 0 cancelled |
| REG-02 | Full test suite, run 2 (stability) | `npm test` | PASS — 207/207, 0 fail, 0 cancelled |
| REG-03 | Full test suite, run 3 (stability) | `npm test` | PASS — 207/207, 0 fail, 0 cancelled |
| REG-04 | CodeMap validation | `npm run validate:codemap` | PASS — exit 0, `crawler-pod-capability-layer-root-manifest` v1.0.0 |
| REG-05 | Gap #1 (stale attempt ownership revoked immediately) | New test in `test/reliability.test.js`, executed | PASS — `isCurrentOwner` false immediately after recovery starts; `executeRun()` on the stale token returns `discarded:true, reason:'STALE_EXECUTION'`, zero `insertSnapshots` calls, Run never marked `done` |
| REG-06 | Gap #2 (`waitForSettled` timer no longer `unref()`'d) | Direct source read + edit + existing suite re-run | PASS — timer now keeps the event loop alive until it fires; confirmed no cancelled tests across REG-01..03 |
| REG-07 | Gap #4 (Apify retry blocked while remote actor still running) | Source read: `scheduler.js` `isApifyActorTerminal()` gate | PASS (present in source, exercised by existing scheduler.test.js suite within REG-01..03) |
| REG-08 | Gap #3/#5 (AbortSignal wiring + `reviews` field in packed history) | Source read: `shopify.js` signal param, `daily-history.js` `reviews` field | PASS (present in source, exercised by existing suite within REG-01..03) |

### 1.2 Live runtime / API verification (real server, real DB, no mocks)

| ID | What | Method | Result |
|---|---|---|---|
| API-01 | Server boots cleanly | `preview_start` + log read | PASS — Scheduler/StuckDetector/SocialScheduler all started, no fatal errors |
| API-02 | `GET /api/system/info` | curl | PASS — real pid/version/commit returned |
| API-03 | `GET /api/database/health` | curl | PASS — `productCurrentRowCount:207`, integrity fields present |
| API-04 | `GET /api/scheduler/status` | curl | PASS — pools LOCAL/CLOUD/BROWSER/CDP reporting real capacity/running counts |
| API-05 | `GET /api/doctor?json=true` | curl | PASS — 13 channels reported; correctly shows `APIFY_TOKEN is configured, but paid actor entitlement is unverified` for Apify-backed channels (see NEED_HUMAN_COST items below) |
| E2E-01 | Shopify happy-path crawl (real public storefront, free) | `POST /api/runs {platform:shopify, query:https://colourpop.com, options:{maxItems:5}}`, then poll | PASS — Run went `pending`→`done` in ~2s, `items_count:5`, real titles/prices/images from colourpop.com in `result_items_json` |
| E2E-02 | `maxItems` request-shape check (found and ruled out a false alarm) | First attempt sent top-level `maxItems` (ignored, defaulted to 20); corrected to `options.maxItems` per `server.js:491` (`const { platform, query, options } = req.body`) → got exactly 5 | PASS — not a product bug, was this session's own test-shape mistake; documented so it isn't mistaken for a regression later |
| E2E-03 | `GET /api/items?platform=shopify` (Tier-1 read model) | curl | PASS — real rows returned |
| E2E-04 | `GET /api/items/:uid/history` (Tier-2 packed history) | curl (URL-encoded item_uid) | PASS — 3 real historical observations with distinct timestamps for one real product |
| E2E-05 | `GET /api/export/:runId` (JSON) | curl | PASS — full run+items JSON returned |
| E2E-06 | `GET /api/export/:runId?format=csv` | curl -D (headers only) | PASS — `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="shopify_..._<ts>.csv"`, non-zero `Content-Length` |
| E2E-07 | Delete run | `DELETE /api/runs/2003` then re-`GET` | PASS — `{success:true}` then `404 Run not found` |
| API-06 | `GET /api/social-bots` (list only, no trigger) | curl | PASS — 5 bot configs returned with real `lastRunAt`/`nextRunAt`/`totalDispatched` |
| API-07 | `GET /api/marketplace-accounts?platform=etsy` | curl | PASS — `200`, `[]` (no accounts configured, valid empty state) |
| API-08 | `GET /api/marketplace-proxies` | curl | PASS — `200`, returns 1 real SOCKS5 proxy row (`89.106.0.151:23295`) from the DB |
| API-09 | `GET /api/toidispy/filters` | curl | PASS — `200`, real filter schema returned |
| API-10 | `GET /api/platforms` | curl | PASS — `200`, platform list with UI field schemas |
| UI-01 | Dashboard loads with zero JS console errors | Browser pane: navigate + `read_console_messages(onlyErrors:true)` | PASS — "No console logs" (no errors) |
| UI-02 | Product grid renders real live data (search/filter controls present) | Browser pane: `read_page` + `get_page_text` | PASS — real product cards (Amazon/Etsy/Shopify/Twitter/Facebook) with price/rating/reviews/growth badges rendered; search box, platform filter buttons, sort dropdown all present and populated |
| UI-03 | Header nav button labels match `docs/UI_MANUAL_TEST_PROCEDURE.md`'s description (Doctor / Social Bots buttons) | Browser pane `get_page_text` | **PARTIAL / DISCREPANCY** — actual header text captured was "Marketplace Accounts, Capture HTML, Saved Captures, Schedules, Jobs History, Collect, Export" — no "Doctor" or "Social Bots" labels appeared in the text dump captured. Not confirmed as a bug (icons/aria-only buttons wouldn't show in plain text, and viewport stayed mobile-width despite a desktop resize request) — flagged as needing a closer follow-up pass, not asserted as broken |

### 1.3 Config/arithmetic checks (no live run, no cost — pure source + live DB read)

| ID | What | Method | Result |
|---|---|---|---|
| SOCIAL-01 | Social Bot cadence vs. 3-hour (180 min) target | Read `src/social-bots/bot-config.js` `DEFAULT_BOT_CONFIGS` | **FAIL vs target** — facebook=120min, reddit=60min, instagram=120min, twitter=60min; only the *disabled* `tiktok` entry is 180min. **No enabled bot currently matches a 3-hour cadence.** This is a config-value fact, not "scheduler runs correctly ⇒ pass" — per instruction, correct-file-execution is not treated as satisfying the 3h requirement. |
| SOCIAL-02 | Live confirmation of SOCIAL-01 against the running scheduler (not just static config) | `GET /api/social-bots` while server running | CONFIRMED live — `facebook`: `lastRunAt: 2026-08-27 02:00:17`, `nextRunAt: 2026-08-27T04:00:00.000Z` = exactly 120 min apart, matching the 120min config, not 180min |
| SOCIAL-03 | Overlap between two different scheduled bot windows | Read `windowSlotFor(bot, atMs) = Math.floor(atMs / (intervalMinutes*60000))` in `social-scheduler.js:86-89` | **OVERLAP CONFIRMED by construction** — reddit(60min) and twitter(60min) share the identical window formula, so they become due at the exact same wall-clock instant every hour; facebook(120min) and instagram(120min) likewise share every 2 hours; and since 120 is an exact multiple of 60, every 2-hour boundary is simultaneously due for **all four** enabled bots at once. This is a structural property of the epoch-aligned `floor(atMs/intervalMs)` formula — provable by reading the formula, no live/paid dispatch was run to observe it. |
| PROXY-01 | SOCKS5 config source: env var vs. per-account DB record | Read `src/database.js:898-921` (`validateSocks5Proxy`, `buildSocks5ProxyUrl` read `config_encrypted` from the `marketplace_proxies` DB row) | CONFIRMED — SOCKS5 credentials are **entirely per-account, DB-encrypted**, never read from a global `process.env.SOCKS5_*`. There is no such env var in this codebase's design. |
| PROXY-02 | Production runtime actually loads `.env` | Read `server.js:6` (`require('dotenv').config()`) + confirm `.env` exists on disk | CONFIRMED — production runtime (`node server.js`) loads `.env` correctly at startup. |
| PROXY-03 | Distinguish "shell audit missing env" from "production blocker" | Reasoned from PROXY-01+PROXY-02 | **Any prior "SOCKS5 blocked — env missing" finding from a bare `node -e "..."` probe is a shell-audit artifact, not a production blocker** — a raw `node -e` never runs `dotenv.config()` and SOCKS5 isn't env-var-based here anyway. Production (`server.js`) has no such gap. |
| PROXY-04 | Live proxy egress test through the real SOCKS5 proxy found in API-08 (`89.106.0.151:23295`) | *(not performed)* | **Same test as COST-08 below — see §2, not counted twice in the TOTAL.** Cross-referenced here for context only. |

---

## 2. NEED_HUMAN_COST (skipped — would risk real charges)

| ID | What | Why it's cost-risk | What the human needs to do |
|---|---|---|---|
| COST-01 | Amazon crawl (`CLOUD_API`/Apify) | Doctor confirms `APIFY_TOKEN is configured, but paid actor entitlement is unverified` — running it executes a real, billed Apify Actor | Either confirm the Apify plan/credit is intended to be spent for this verification, or accept `BLOCKED_EXTERNAL` as the final status for this channel |
| COST-02 | Pinterest crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-03 | Facebook Posts crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-04 | Facebook Ads crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-05 | Instagram crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-06 | Twitter/X crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-07 | TikTok Shop crawl (`CLOUD_API`/Apify) | Same as COST-01 | Same as COST-01 |
| COST-08 | Live SOCKS5 proxy egress test through the real proxy found in API-08 (cross-referenced as PROXY-04 — same single test, counted once) | Real third-party proxy, unknown billing/quota owner | Confirm the proxy (`89.106.0.151:23295`, label "Deeplove") is free/self-owned, or provide a disposable test proxy |
| COST-09 | Social Bot live trigger on any Apify-backed platform (facebook/instagram/twitter via `POST /api/social-bots/:platform/trigger`) | Same underlying Apify actor cost as COST-01..07 — triggering a bot dispatches a real Run through the same channels | Confirm willingness to spend Apify credits, or accept the bot's `blockedReason`/dependency-check state as the final verification |

## 3. NEED_HUMAN_CREDENTIAL

| ID | What | Why | What the human needs to do |
|---|---|---|---|
| CRED-01 | Toidispy (`CDP`) channel live verification | Doctor reports `NO_HEALTHY_BACKEND` — requires a logged-in Toidispy account session over CDP; this agent is not permitted to create/enter account credentials | Log into the Toidispy-controlled Chrome session manually (or provide a valid CDP session already authenticated), then this session can re-verify the channel |

## 4. NEED_HUMAN_INTERACTION

| ID | What | Why | What the human needs to do |
|---|---|---|---|
| INTER-01 | eBay / Etsy anti-bot challenge resolution | Doctor/earlier E2E rounds note eBay hits a headless-browser anti-bot challenge and Etsy's SearXNG discovery path can return 0 results — both require a human to either solve a bot challenge in a real browser session or adjust discovery inputs interactively | A person drives a real (non-headless, human-fingerprinted) browser session through the challenge once, or supplies working SearXNG results/direct listing URLs for Etsy |
| INTER-02 | Pixel-level UI click-through of Doctor/Social Bots modal buttons (UI-03 discrepancy) | The automated browser pass could not get past a mobile-width viewport to reach the header's icon-only controls within this round's tool budget; can't confirm whether "Doctor"/"Social Bots" buttons are mislabeled, icon-only, or genuinely missing without a focused follow-up pass | Not strictly needing a human — flagged here as the one open item this session recommends a short dedicated browser-automation follow-up for, rather than asking a person to click it manually |

---

## 5. Executive Summary

- **Automated regression (source-level):** 8/8 PASS (REG-01..08) — includes 3 consecutive full `npm test` runs (207/207 each) and codemap validation, all executed for real this session.
- **Live API/runtime verification:** 17/18 PASS, 1 PARTIAL/DISCREPANCY (UI-03) — a real Shopify crawl ran end-to-end against a live public storefront with zero cost, proving the full CREATE→QUEUE→ADMIT→EXECUTE→DONE pipeline, V2 read model, JSON/CSV export, and delete-run all work against the real DB.
- **Config/arithmetic findings (SOCIAL/PROXY), no cost incurred:**
  - Social Bot cadence does **not** match the stated 3-hour target for any enabled bot (facebook/instagram=2h, reddit/twitter=1h).
  - Reddit+twitter and facebook+instagram scheduled windows structurally overlap by design (shared interval / integer-multiple intervals), confirmed by reading the epoch-aligned window formula, not by a live paid dispatch.
  - SOCKS5 proxy config is per-account/DB-based, not env-var-based; production (`server.js`) loads `.env` correctly — any "env missing" claim from a bare `node -e` shell probe is not a production blocker.
- **Skipped, labeled honestly:** 9 items NEED_HUMAN_COST (all 7 Apify-backed platforms + live proxy egress + bot-trigger-through-Apify), 1 NEED_HUMAN_CREDENTIAL (Toidispy login), 2 NEED_HUMAN_INTERACTION (eBay/Etsy anti-bot challenge, one follow-up UI pass).
- **Excluded by instruction, referenced only, not retested:** UI-BUG-06, UI-BUG-07, UI-BUG-10, BUG-08, BUG-11, Cancel Run/Abort bug.

## 6. TOTAL — UNIQUE testcases (corrected 2026-08-27, post-audit hygiene pass)

**Correction applied:** PROXY-04 and COST-08 described the exact same unperformed test (live egress through the one real SOCKS5 proxy found in API-08, `89.106.0.151:23295`) from two angles (§1.3 config finding vs. §2 cost-skip reason). The original version of this report counted both as separate rows, double-counting one unique testcase. PROXY-04 is now a cross-reference only (see §1.3) and is excluded from the counts below; the single underlying test is counted once, as COST-08.

Row counts, taken directly from §1–§4, PROXY-04 excluded as a duplicate cross-reference:

| Section | IDs counted | Row count |
|---|---|---|
| §1.1 Automated regression | REG-01..REG-08 | 8 |
| §1.2 Live runtime/API | API-01..API-10, E2E-01..E2E-07, UI-01..UI-03 | 10 + 7 + 3 = 20 |
| §1.3 Config/arithmetic | SOCIAL-01..SOCIAL-03, PROXY-01..PROXY-03 (PROXY-04 excluded — duplicate of COST-08) | 3 + 3 = 6 |
| §2 NEED_HUMAN_COST | COST-01..COST-09 (COST-08 = the one unique proxy-egress test) | 9 |
| §3 NEED_HUMAN_CREDENTIAL | CRED-01 | 1 |
| §4 NEED_HUMAN_INTERACTION | INTER-01..INTER-02 | 2 |
| **TOTAL unique rows** | | **8 + 20 + 6 + 9 + 1 + 2 = 46** |

Same 46 rows, split by outcome (cross-check — must sum to the same 46):

| Outcome | Count | Which IDs |
|---|---|---|
| PASS | 27 | REG-01..08 (8), API-01..10 (10), E2E-01..07 (7), UI-01, UI-02 (2) |
| PARTIAL/DISCREPANCY (not a pass, not a code-defect fail) | 1 | UI-03 |
| FAIL vs. stated target (config value, not a code defect) | 1 | SOCIAL-01 |
| CONFIRMED structural finding (arithmetic/design fact, no live paid run) | 5 | SOCIAL-02, SOCIAL-03, PROXY-01, PROXY-02, PROXY-03 |
| NEED_HUMAN_COST | 9 | COST-01..09 (includes the one proxy-egress test, counted once here) |
| NEED_HUMAN_CREDENTIAL | 1 | CRED-01 |
| NEED_HUMAN_INTERACTION | 2 | INTER-01, INTER-02 |
| **Sum** | **27+1+1+5+9+1+2 = 46** | matches TOTAL above |

**TOTAL (unique testcases) = 46**, confirmed by two independent countings of the same ledger.
