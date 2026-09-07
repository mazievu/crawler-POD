# Database V2 Module

## Responsibility
Provide 3-tier storage architecture (`product_current`, `daily_packed_history`, `weekly_summary`) for high-scale product analytics.

## Public API
- `initSchemaV2(db)`: Initializes V2 SQLite schema and indexes.
- `productCurrentOps.upsertItem(item, runId)`: Atomically upserts current product state and computes deltas.
- `dailyHistoryOps.appendObservation(item, timestamp)`: Compresses intra-day observation into daily row.
- `weeklySummaryOps.updateWeekly(item, timestamp)`: Computes weekly trend rollup.
- `db.getProductCurrent(params)`: Queries current product state with ranking order.
- `db.getProductHistory(itemUid, limitDays)`: Retrieves unpacked daily observations.
- `db.backfillSnapshotsToV2()`: Backfills legacy snapshots into V2 storage.
