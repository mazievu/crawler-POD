/**
 * pg-client.js — PostgreSQL client shaped like the better-sqlite3 API.
 *
 * WHY THIS EXISTS
 * The codebase drives the database through better-sqlite3's *synchronous*
 * surface in 500+ call sites: a module-level table of 113 `db.prepare(...)`
 * statements, then `stmt.x.get()/.all()/.run()` inside ordinary functions.
 * node-postgres has no synchronous mode, so a migration has to turn query
 * execution async. Re-shaping every SQL string and call site at once would be
 * an enormous, unreviewable diff.
 *
 * This adapter splits that problem in two:
 *
 *   - `prepare(sql)` stays SYNCHRONOUS. It only parses/translates the SQL and
 *     returns a statement handle, so the existing module-level `const stmt = {…}`
 *     table keeps working verbatim.
 *   - Only `.get()/.all()/.run()` (and `exec`/`transaction`) become async, so
 *     the conversion at call sites is a mechanical `await`.
 *
 * WHAT IT TRANSLATES (behavior-preserving, verified against the live SQL)
 *
 *   @name / ?           -> $1..$n positional placeholders, values ordered to match.
 *   CURRENT_TIMESTAMP   -> to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')
 *                          SQLite's CURRENT_TIMESTAMP yields the TEXT
 *                          'YYYY-MM-DD HH:MM:SS'; Postgres' yields a timestamptz
 *                          ('… .123456+00'). The timestamp columns stay TEXT and
 *                          normalizeLegacyUtcTimestamp() parses the SQLite shape,
 *                          so emitting the native Postgres value here would
 *                          silently change every stored timestamp.
 *   LIKE                -> ILIKE
 *                          SQLite's LIKE is case-INSENSITIVE for ASCII; Postgres'
 *                          is case-SENSITIVE. Keyword search (product_current
 *                          title/query) would quietly start missing rows.
 *                          Already-lowercased comparisons are unaffected by ILIKE.
 *   INSERT OR IGNORE    -> INSERT … ON CONFLICT DO NOTHING
 *   PRAGMA table_info(t)-> information_schema.columns query returning {name,type,…}
 *
 * `.run()` returns { changes, lastInsertRowid } like better-sqlite3. To supply
 * lastInsertRowid, INSERT statements that have no RETURNING clause get
 * `RETURNING id` appended; when the table has no `id` column Postgres reports
 * that as an error, so the append is skipped for known id-less tables.
 */

const path = require('path');
const { Pool, types } = require('pg');

// better-sqlite3 trả COUNT()/SUM() là number; node-postgres mặc định parse
// int8 (OID 20) và numeric (OID 1700) thành string, khiến getStats() v.v.
// trả "1" thay vì 1. Lỗi chỉ lộ trên PostgreSQL server thật — PGlite tự parse
// thành number nên test local không bắt được. Giữ hành vi cũ của hệ thống
// (toàn bộ call sites đã được await hoá theo contract better-sqlite3).
// ponytail: Number() mất chính xác trên bigint > 2^53; khi cần đếm lớn hơn
// vậy mới đổi sang đọc string + BigInt có điều kiện.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

// Tables whose primary key is not a column named `id`; `RETURNING id` must not
// be appended for these, and lastInsertRowid is meaningless for them.
const TABLES_WITHOUT_ID = new Set(['product_current', 'migration_checkpoints']);

/** Tables are quoted/unquoted in the source SQL; match either form. */
function insertTargetTable(sql) {
  const m = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(sql);
  return m ? m[1] : null;
}

/**
 * Rewrite SQLite dialect to PostgreSQL, preserving observable behavior.
 * String literals are protected first so nothing inside quotes is rewritten.
 */
function translateDialect(sql) {
  const literals = [];
  // Stash `--` line comments FIRST. An apostrophe inside a comment (for
  // example "PostgreSQL's") would otherwise read as the start of a string
  // literal and swallow the rest of the statement, silently turning bound
  // parameters into bare identifiers (column "likes" does not exist).
  let out = sql.replace(/--.*/g, (c) => {
    literals.push(c);
    return ` L${literals.length - 1} `;
  });
  // Then stash single-quoted literals (with '' escapes).
  out = out.replace(/'(?:[^']|'')*'/g, (lit) => {
    literals.push(lit);
    return ` L${literals.length - 1} `;
  });

  const hadOrIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out);
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');

  out = out.replace(
    /\bCURRENT_TIMESTAMP\b/gi,
    "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
  );
  // NOT LIKE must stay a single operator; handle it before bare LIKE.
  out = out.replace(/\bNOT\s+LIKE\b/gi, 'NOT ILIKE');
  out = out.replace(/\bLIKE\b/gi, 'ILIKE');

  // SQLite's `col IS <value>` is null-safe equality against any operand.
  // Postgres only accepts IS with NULL/TRUE/FALSE/UNKNOWN/DISTINCT, so a bound
  // parameter there is a syntax error ("syntax error at or near $4"). The
  // null-safe equivalent is IS NOT DISTINCT FROM, which keeps the SQLite
  // semantics the claim-token checks rely on (NULL matches NULL).
  out = out.replace(
    /\bIS\s+(?!NULL\b|NOT\b|TRUE\b|FALSE\b|UNKNOWN\b|DISTINCT\b)(@[A-Za-z_][A-Za-z0-9_]*|\?)/gi,
    'IS NOT DISTINCT FROM $1'
  );

  if (hadOrIgnore && !/ON\s+CONFLICT/i.test(out)) out = `${out.trimEnd()} ON CONFLICT DO NOTHING`;

  // Restore literals.
  out = out.replace(/ ?L(\d+) ?/g, (_m, i) => literals[Number(i)]);
  return out;
}

/**
 * Convert better-sqlite3 placeholders to Postgres positional ones.
 * Returns { text, names } where `names` is the ordered binding plan:
 * a string for a named (@foo) slot, or an integer index for a positional (?) slot.
 */
function translateParams(sql) {
  const names = [];
  const seen = new Map();
  let positional = 0;

  const literals = [];
  // Same comment-first masking as translateDialect: an apostrophe inside a
  // '--' comment would otherwise be read as an opening quote and hide the
  // parameters that follow it.
  let out = sql.replace(/--.*/g, (c) => {
    literals.push(c);
    return ` L${literals.length - 1} `;
  });
  out = out.replace(/'(?:[^']|'')*'/g, (lit) => {
    literals.push(lit);
    return ` L${literals.length - 1} `;
  });

  // Named parameters: @foo. Repeated names reuse the same $n, matching
  // better-sqlite3, where one object key can fill several occurrences.
  out = out.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
    if (seen.has(name)) return `$${seen.get(name)}`;
    names.push(name);
    const idx = names.length;
    seen.set(name, idx);
    return `$${idx}`;
  });

  // Positional parameters: ?
  out = out.replace(/\?/g, () => {
    names.push(positional++);
    return `$${names.length}`;
  });

  out = out.replace(/ ?L(\d+) ?/g, (_m, i) => literals[Number(i)]);
  return { text: out, names };
}

/** PRAGMA table_info(x) -> information_schema equivalent with the same field names. */
function translatePragmaTableInfo(sql) {
  const m = /^\s*PRAGMA\s+table_info\(\s*'?"?([A-Za-z_][A-Za-z0-9_]*)"?'?\s*\)\s*;?\s*$/i.exec(sql);
  if (!m) return null;
  return {
    text: `SELECT column_name AS name, data_type AS type,
                  (is_nullable = 'NO')::int AS notnull,
                  column_default AS dflt_value,
                  0 AS pk,
                  (ordinal_position - 1) AS cid
           FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = $1
           ORDER BY ordinal_position`,
    names: [0],
    pragmaArg: m[1],
  };
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.source = sql;

    const pragma = translatePragmaTableInfo(sql);
    if (pragma) {
      this.text = pragma.text;
      this.names = pragma.names;
      this.pragmaArg = pragma.pragmaArg;
      this.isInsert = false;
      this.returnsId = false;
      return;
    }

    const dialect = translateDialect(sql);
    const { text, names } = translateParams(dialect);
    this.names = names;
    this.isInsert = /^\s*INSERT\s+/i.test(dialect);

    // Append RETURNING id so .run() can report lastInsertRowid the way
    // better-sqlite3 does. Skipped when the statement already returns, or the
    // target table has no `id` column.
    const table = insertTargetTable(dialect);
    if (this.isInsert && !/\bRETURNING\b/i.test(dialect) && table && !TABLES_WITHOUT_ID.has(table)) {
      this.text = `${text.trimEnd().replace(/;\s*$/, '')} RETURNING id`;
      this.returnsId = true;
    } else {
      this.text = text;
      this.returnsId = false;
    }
  }

  /**
   * Map better-sqlite3 call shapes onto an ordered values array:
   *   .get(1)             positional
   *   .get(1, 'x')        positional
   *   .run({ a: 1 })      named
   */
  bind(args) {
    if (this.pragmaArg !== undefined) return [this.pragmaArg];
    if (this.names.length === 0) return [];

    const named = this.names.some((n) => typeof n === 'string');
    if (named) {
      const obj = args[0] || {};
      return this.names.map((n) => {
        const v = typeof n === 'string' ? obj[n] : args[n];
        return v === undefined ? null : v;
      });
    }
    return this.names.map((i) => (args[i] === undefined ? null : args[i]));
  }

  async all(...args) {
    const res = await this.db.query(this.text, this.bind(args));
    return res.rows;
  }

  async get(...args) {
    const res = await this.db.query(this.text, this.bind(args));
    return res.rows[0];
  }

  async run(...args) {
    const res = await this.db.query(this.text, this.bind(args));
    return {
      changes: res.rowCount ?? 0,
      lastInsertRowid: this.returnsId && res.rows[0] ? res.rows[0].id : undefined,
    };
  }

  /** better-sqlite3's .iterate() streams; the row counts here are small enough
   *  that materialising and yielding keeps the same observable semantics. */
  async *iterate(...args) {
    const rows = await this.all(...args);
    for (const row of rows) yield row;
  }
}

class PgDatabase {
  constructor(poolOrClient, { owned = false } = {}) {
    this._pool = poolOrClient;
    this._owned = owned;
    this._txClient = null;
  }

  /** The driver may be supplied as a promise (PGlite is ESM-only and has to be
   *  loaded with dynamic import()), so resolve it once on first use. */
  async _driver() {
    if (!this._resolved) this._resolved = await this._pool;
    return this._resolved;
  }

  /** Routes through the transaction client when one is active, so statements
   *  prepared at module load participate in whatever transaction is running. */
  async query(text, values) {
    if (this._txClient) return this._txClient.query(text, values);
    const driver = await this._driver();
    return driver.query(text, values);
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async exec(sql) {
    const translated = translateDialect(sql);
    // exec() is handed multi-statement DDL. node-postgres runs that fine
    // through the simple query protocol, but some drivers (PGlite) only accept
    // a single statement via query() and expose a separate exec() for scripts.
    const driver = await this._driver();
    if (!this._txClient && typeof driver.exec === 'function') {
      await driver.exec(translated);
      return;
    }
    await this.query(translated);
  }

  /** SQLite pragmas have no Postgres equivalent; connection tuning is handled
   *  by the pool/server configuration. Kept so existing calls stay valid. */
  pragma(_setting) {
    return [];
  }

  /**
   * better-sqlite3's db.transaction(fn) returns a callable that runs fn inside
   * a transaction. The returned function is async here. Nested calls join the
   * outer transaction rather than opening a second one, matching better-sqlite3,
   * where a nested transaction call does not start an independent transaction.
   */
  transaction(fn) {
    return async (...args) => {
      if (this._txClient) return fn(...args);
      const driver = await this._driver();
      if (typeof driver.connect !== 'function') {
        // Single-connection drivers (e.g. PGlite in tests) have no pool to
        // check out from; run the transaction on the driver itself.
        await this.query('BEGIN');
        try {
          const result = await fn(...args);
          await this.query('COMMIT');
          return result;
        } catch (err) {
          try { await this.query('ROLLBACK'); } catch (_) { /* keep original error */ }
          throw err;
        }
      }

      const client = await driver.connect();
      this._txClient = client;
      try {
        await client.query('BEGIN');
        const result = await fn(...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          /* rollback failure must not mask the original error */
        }
        throw err;
      } finally {
        this._txClient = null;
        client.release();
      }
    };
  }

  async close() {
    const driver = await this._driver();
    if (this._owned && typeof driver.end === 'function') await driver.end();
    if (this._owned && typeof driver.close === 'function') await driver.close();
  }
}

function createPool() {
  const connectionString = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
  if (connectionString) {
    return new Pool({
      connectionString,
      ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX) || 10,
    });
  }
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'crawler',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'crawler_pod',
    max: Number(process.env.PG_POOL_MAX) || 10,
  });
}

/** Wrap an already-constructed driver (a pg Pool/Client, or a PGlite instance
 *  in tests) so the same adapter can run against either. */
function fromDriver(driver) {
  return new PgDatabase(driver, { owned: false });
}

/**
 * Opens the application's database connection.
 *
 * Default: a node-postgres pool against a PostgreSQL server (PGHOST/PGPORT/…
 * or DATABASE_URL).
 *
 * PG_MODE=pglite switches to PGlite — PostgreSQL itself compiled to WASM and
 * run in-process, persisting to PGLITE_DIR. It is real PostgreSQL (same SQL,
 * same semantics, durable across restarts), so it is a valid target when no
 * server is reachable. It is single-connection, so it does not exercise
 * pooling or network behavior; a deployment still wants a server.
 *
 * There is no SQLite branch here on purpose: if PostgreSQL cannot be opened the
 * error propagates, rather than silently falling back to the archived file.
 */
function openDatabase() {
  if ((process.env.PG_MODE || '').toLowerCase() === 'pglite') {
    // PGlite is ESM-only with a top-level await, so it cannot be require()d
    // from CommonJS; hand the pool a promise and let _driver() resolve it.
    const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', '..', 'data', 'pgdata');
    const driver = import('@electric-sql/pglite').then(({ PGlite }) => new PGlite(dir));
    return new PgDatabase(driver, { owned: true });
  }
  return new PgDatabase(createPool(), { owned: true });
}

module.exports = {
  PgDatabase,
  Statement,
  openDatabase,
  fromDriver,
  createPool,
  // exported for unit tests of the translation layer
  translateDialect,
  translateParams,
  translatePragmaTableInfo,
};
