# crawler-POD — SQLite crawl data packet

Generated: 2026-09-04T10:36:16.508Z
Source: `data/collector.db` (journal mode: wal)

This packet contains the complete crawl dataset held in the project's SQLite
database at the time of generation. The source database was opened read-only
and **was not modified** (verified: `sourceUntouched = true`).

## Contents

| Path | What it is |
|---|---|
| `collector.snapshot.db` | Consistent single-file SQLite snapshot. Produced with SQLite's Online Backup API, so it **includes WAL contents** — a plain file copy of a WAL-mode database would have missed recent writes. |
| `schema/schema.sql` | Full DDL: every table and index, exactly as defined in the source. |
| `export/<table>.json` | One JSON array per table containing every row. Portable, engine-independent. |
| `MANIFEST.json` | Row counts, per-file SHA-256, and the snapshot verification results. |
| `checksums.sha256` | SHA-256 for every file in this packet. |

## Totals

- Tables: **14**
- Rows: **4486**
- Snapshot `PRAGMA integrity_check`: **ok**
- All table counts match between source and snapshot: **true**

| Table | Rows | Export SHA-256 |
|---|---:|---|
| daily_packed_history | 1364 | 9c27b27cbd4a59e3… |
| marketplace_accounts | 1 | 900103bc36cd2738… |
| marketplace_capture_schedule_runs | 4 | a37e9df4380a1dbd… |
| marketplace_capture_schedules | 3 | 7d91dce0c85d4740… |
| marketplace_captures | 519 | b05b2c5dffcd8d9a… |
| marketplace_proxies | 1 | 7cde1009e3ea90da… |
| migration_checkpoints | 1 | 8858cdafa37d0c3f… |
| platforms | 13 | 5371283b2206cd0e… |
| product_current | 1133 | e4169f03e9a04a5c… |
| runs | 792 | 3c4c57d7bc4aae44… |
| snapshots | 307 | 89c3b4675eea0330… |
| social_bot_state | 180 | 5f797a071e1d9b80… |
| v2_write_failures | 0 | 4f53cda18c2baa0c… |
| weekly_summary | 168 | 56ea48c97d78ea52… |

## How to verify this packet

Check every file against the recorded checksums:

```bash
sha256sum -c checksums.sha256
```

Confirm the snapshot opens and its row counts match `MANIFEST.json`:

```bash
sqlite3 collector.snapshot.db "PRAGMA integrity_check;"
sqlite3 collector.snapshot.db "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
sqlite3 collector.snapshot.db "SELECT COUNT(*) FROM runs;"
```

## Sensitive material

Columns listed under sensitiveColumns hold application-encrypted credential material (ciphertext, not plaintext). Transfer this packet over a secure channel.

Affected columns:

- `marketplace_accounts`: `session_encrypted`
- `marketplace_proxies`: `config_encrypted`
