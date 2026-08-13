# Etsy analytics import — TDD evidence

## Source and user journeys

Derived during this TDD run (no plan file was supplied).

1. As a researcher, I can search imported Etsy shop and listing analytics by product name or shop name.
2. As an operator, I can import every CSV under an analytics export directory in a repeatable command.
3. As a dashboard user, I can see search results even when an analytics product row has no image.

## Task report

| Behavior | RED evidence | GREEN evidence | Guarantee |
|---|---|---|---|
| Parse CSV exports and preserve quoted commas | `node --test test/etsy-analytics-import.test.js test/etsy-analytics-dashboard.test.js` failed because `src/etsy-analytics-import` did not exist | Same command: 8 passing tests | CSV fields such as product names and tags retain commas correctly. |
| Normalize and de-duplicate shop/listing rows | Missing module prevented the import-record tests from running | Same command: `converts shop and product analytics…` and `deduplicates…` pass | One record is created for each distinct Etsy shop URL or listing URL in an import. |
| Search at database scale | The search test returned `86491 !== 1` before server-side filtering | Same command: `latest snapshot search…` passes | Search matches product title, shop name, platform, and retained raw analytics fields, with a bounded result limit. |
| Display records without images | Dashboard static behavior test failed because image-less rows were filtered out | Same command: dashboard behavior test passes | Imported product rows without images remain visible with a fallback placeholder. |

## Import evidence

Command run:

```text
node scripts/import-etsy-analytics.js "C:\Users\Server_00\Downloads\DB\DB" "2026-07-25"
```

Result:

```text
runId: 382
files: 90
shopRows: 100
productRows: 89149
importedRecords: 86392
newItems: 86392
```

The API was verified with `GET /api/items?search=College%20Logo%20Engraved%20Wine%20Tumbler&limit=5`; it returned the expected AcentialDrinkware listing at `$21.99` and estimated sales `31`.

## Test specification

| # | What is guaranteed | Test target | Type | Result |
|---|---|---|---|---|
| 1 | Quoted CSV values retain embedded commas | `etsy-analytics-import.test.js` | unit | PASS |
| 2 | Shop and listing fields become searchable snapshot records | `etsy-analytics-import.test.js` | unit | PASS |
| 3 | Duplicate export rows do not create duplicate records | `etsy-analytics-import.test.js` | unit | PASS |
| 4 | Nested CSV exports import in one run | `etsy-analytics-import.test.js` | integration | PASS |
| 5 | Image-less imports are returned and can be searched | `etsy-analytics-import.test.js` | database integration | PASS |
| 6 | Dashboard requests bounded server-side search results | `etsy-analytics-dashboard.test.js` | UI behavior | PASS |

## Validation and coverage

- `npm.cmd test` — 116 passing, 0 failing (the PowerShell `npm` shim is blocked by execution policy; `npm.cmd` runs the same package script).
- `node --test --experimental-test-coverage test/etsy-analytics-import.test.js test/etsy-analytics-dashboard.test.js` — 8 passing. The new importer has 96.67% line coverage and 100% function coverage; the loaded test scope reports 83.22% aggregate line coverage.
- ESLint run on the changed importer, import command, database, server, dashboard, and tests completed with no errors. Existing unrelated warnings remain in `server.js` and `src/database.js`.

## Known gaps

The source export has extra values beyond the advertised product headers in some rows. The importer preserves every original row under `raw_data` for search and inspection, while mapping only stable named fields into the dashboard metrics. The project does not define a coverage threshold for branch/function coverage; the aggregate branch/function figures include pre-existing modules outside this feature.

## Git checkpoint note

No checkpoint commit was created because the repository already had a large unrelated dirty worktree before this task. This avoids staging or committing another person's in-progress changes.
