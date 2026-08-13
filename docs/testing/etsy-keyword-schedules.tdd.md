# Etsy keyword schedules — TDD evidence

User journeys: create an Etsy keyword schedule in the UI; discover at most 30
listing URLs on each scheduled run; capture sequentially using the server
browser; preserve blocked and failed counts without stopping the remaining
listings.

RED: `test/marketplace-scheduler.test.js` initially failed because
`capture-scheduler` and the scheduling UI did not exist.

GREEN verification:

| Guarantee | Evidence | Result |
|---|---|---|
| Etsy-only schedule normalizes a keyword, interval, account, and 30-listing cap | scheduler unit tests | PASS |
| Listings are captured sequentially and failures do not abort the run | scheduler unit tests | PASS |
| Schedule form is present in the dashboard | UI static test | PASS |
| Full regression suite | `npm.cmd test` | 98/98 PASS |
| Scheduler coverage | targeted Node coverage | 100% lines, 83.87% branches, 80% functions |
| Docker schedule API | `GET /api/marketplace-capture-schedules` | HTTP 200 |

Schedules are dormant until the user saves one. Each saved schedule starts
after its selected interval and uses the server's CloakBrowser Etsy search
with the selected account and proxy; CAPTCHA pages are recorded as blocked
rather than bypassed.

## One-time date and time schedule

User journey: choose the exact date, month, year, hour, and minute at which
an Etsy keyword capture should run, rather than accepting a hard-coded next
day. The value is interpreted as Vietnam time (UTC+7), converted to UTC for
server storage, and the schedule is disabled after its one run completes.

| Guarantee | Evidence | Result |
|---|---|---|
| A one-time schedule accepts a valid Vietnam `datetime-local` value and computes the intended UTC instant | `test/marketplace-scheduler.test.js` | PASS |
| Invalid calendar dates and an empty one-time date are rejected | `test/marketplace-scheduler.test.js` | PASS |
| The scheduling form exposes a date-and-time picker | `test/marketplace-ui.test.js` | PASS |
| Scheduler module coverage remains above 80% for branches and functions | `node --test --experimental-test-coverage test/marketplace-scheduler.test.js test/marketplace-ui.test.js` | 100% lines, 83.05% branches, 85.71% functions |

## Run-history UI

User journey: after a scheduled capture completes, inspect each completed run
from the relevant schedule rather than relying on an opaque database record.

| Guarantee | Evidence | Result |
|---|---|---|
| Completing a schedule persists a timestamped run summary and disables a one-time schedule | `test/marketplace-schedule-once-db.test.js` | PASS |
| The server returns that persisted history for a schedule | `test/marketplace-api.test.js` | PASS |
| The dashboard exposes an inline run-history control for each schedule | `test/marketplace-ui.test.js` | PASS |

## CloakBrowser keyword discovery

User journey: run an Etsy keyword schedule through the saved CloakBrowser
profile and its assigned proxy, rather than relying on SearXNG to discover
listing URLs.

| Guarantee | Evidence | Result |
|---|---|---|
| Cloak host client sends a keyword discovery request with account session and proxy data | `test/everbee-host-executor.test.js` | PASS |
| Host executor exposes an authenticated Etsy search endpoint | `test/everbee-host-executor.test.js` | PASS |
| Scheduler forwards its saved account to browser discovery and retains the 30-listing cap | `test/marketplace-scheduler.test.js` | PASS |
| Live CloakBrowser discovery returned three Etsy listing URLs for `POD nails` via saved account #2 | container-to-host executor check | PASS |
