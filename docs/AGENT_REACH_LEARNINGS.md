# Agent-Reach learnings for this collector

Source studied: https://github.com/Panniantong/Agent-Reach

Agent-Reach is useful because it treats internet access as a capability layer,
not as one scraper per platform. The important ideas to reuse here are:

1. Ordered backends per platform

   Each platform keeps a preferred backend list. Switching strategy should mean
   reordering or adding a backend, not rewriting platform code.

2. Real probes, not presence checks

   A backend is only active when a lightweight command or HTTP check proves it
   can serve data. Checking that a binary exists or an environment variable is
   set is not enough.

3. Free-first, paid-last routing

   Free public data, local search, browser/CDP login state, and public readers
   are tried first. Paid APIs are kept as explicit fallbacks for platforms where
   the free route cannot produce real data.

4. Runtime bootstrap belongs in the app

   If the app depends on CDP or SearXNG, the app must install/start/check those
   dependencies. Documentation alone is not enough.

5. A universal public-web fallback helps

   Jina Reader can read many public pages as Markdown with no API key. It is not
   a replacement for platform-specific structured scraping, but it gives the
   collector a low-friction "read this public URL" path.

Current implementation in this repo:

- `src/capability-registry.js` defines ordered platform backends.
- `npm run doctor` reports runtime checks and active/fallback backends.
- SearXNG and CDP are auto-started by `npm start` / `npm run start:deps`.
- Phase 2 live probes continue to prove which target platforms return real data.

Next implementation targets:

- Use the registry from the run orchestrator before calling Apify.
- Add a `web`/URL reader path using Jina Reader for public pages.
- Store the backend used for each run so reports show where data came from.
- Promote a platform from `candidate_free` to `verified_free` only after a live
  probe returns real data and writes a report.
