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
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types: pgTypes } = require('pg');

/*
 * PostgreSQL returns int8 (what COUNT/SUM produce) and numeric (what AVG
 * produces) as STRINGS, because both can exceed what a JS number represents
 * exactly. Every caller here was written against better-sqlite3, which returned
 * numbers, so the strings do not throw — they silently corrupt arithmetic:
 * getStats() handed the dashboard "27" instead of 27, and
 * `Object.values(counts).reduce((a, b) => a + b, 0)` then CONCATENATED the
 * per-platform counts into "0271158" instead of summing them.
 *
 * PGlite hides the int8 half (it already yields numbers) but not the numeric
 * half, so this only surfaced against a real server — CI on PostgreSQL 16
 * caught it as `'string' !== 'number'` at test/test.js:241.
 *
 * Converting once here is what keeps every call site honest. The precision
 * Postgres is protecting does not apply to this schema: the int8 values are row
 * counts and the numeric values are prices, ratings and observation averages —
 * all far inside Number.MAX_SAFE_INTEGER.
 */
const PG_OID_INT8 = 20;
const PG_OID_NUMERIC = 1700;
const toNumberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

pgTypes.setTypeParser(PG_OID_INT8, toNumberOrNull);
pgTypes.setTypeParser(PG_OID_NUMERIC, toNumberOrNull);

/** Same two parsers, in the shape PGlite's per-query `parsers` option wants. */
const PG_NUMERIC_PARSERS = { [PG_OID_INT8]: toNumberOrNull, [PG_OID_NUMERIC]: toNumberOrNull };

/** PGlite exposes exec() for multi-statement scripts; a pg Pool/Client does not. */
function isPgliteDriver(driver) {
  return !!driver && typeof driver.exec === 'function' && typeof driver.connect !== 'function';
}

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
/**
 * Masks string literals and `--` line comments in ONE left-to-right scan, so
 * each is recognised in the context of the other. Both regex-pass orderings
 * are wrong in a different direction:
 *
 *   comments first  a `--` INSIDE a string ('https://a/foo--bar') eats the
 *                   rest of the statement, and the `?` after it vanishes;
 *   strings first   an apostrophe INSIDE a comment ("PostgreSQL's") opens a
 *                   phantom string and swallows the statement — the bug the
 *                   old comment-first order was chosen to avoid.
 *
 * A scanner has no ordering problem: whichever starts first wins, exactly as
 * the PostgreSQL parser reads it. Placeholders use  sentinels, which
 * cannot appear in SQL — the old ` L<n> ` form collided with any identifier
 * that happened to be named L0, L1, …
 */
function maskLiteralsAndComments(sql) {
  const literals = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // String literal, honouring '' escapes. Unterminated: take the rest.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      const end = j < sql.length ? j + 1 : sql.length;
      literals.push(sql.slice(i, end));
      out += `${literals.length - 1}`;
      i = end;
    } else if (ch === '-' && sql[i + 1] === '-') {
      // Line comment: runs to end of line, never across it.
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      literals.push(sql.slice(i, j));
      out += `${literals.length - 1}`;
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  const restore = (text) => text.replace(/(\d+)/g, (_m, k) => literals[Number(k)]);
  return { masked: out, restore };
}

function translateDialect(sql) {
  const { masked, restore } = maskLiteralsAndComments(sql);
  let out = masked;

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

  return restore(out);
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

  // Same single-pass masking as translateDialect — see maskLiteralsAndComments
  // for why neither regex-pass ordering is safe here.
  const { masked, restore } = maskLiteralsAndComments(sql);
  let out = masked;

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

  out = restore(out);
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
    // The active transaction's client is scoped to the async execution context,
    // NOT stored on the instance. This class is a singleton in practice, and an
    // instance field meant two concurrent transactions overwrote each other:
    // tx2 re-pointed the field mid-flight so tx1's statements ran on tx2's
    // connection, and tx1's `finally` nulled it so tx2's remaining statements
    // escaped onto the plain pool — no isolation, no atomicity, no error.
    // AsyncLocalStorage gives each transaction its own view of "my client".
    this._txStorage = new AsyncLocalStorage();
    // Single-connection drivers (PGlite) have only one session, so two
    // interleaved BEGIN/COMMIT pairs would corrupt each other; transactions on
    // such drivers queue on this promise chain instead of interleaving.
    this._txLock = Promise.resolve();
  }

  /** The transaction client of the CURRENT async context, if one is active. */
  _txClientForContext() {
    return this._txStorage.getStore() || null;
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
    const driver = this._txClientForContext() || await this._driver();
    // PGlite does not read pg's global type registry, so the int8/numeric
    // parsers set at the top of this file have to be handed to it per query.
    // Probed against @electric-sql/pglite: without them AVG() comes back as
    // "2.0000000000000000"; with them, 2. node-postgres must NOT get a third
    // argument here — it would be taken as a callback.
    if (isPgliteDriver(driver)) return driver.query(text, values, { parsers: PG_NUMERIC_PARSERS });
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
    if (!this._txClientForContext() && typeof driver.exec === 'function') {
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
      // A nested call joins the transaction of ITS OWN async context. Reading
      // this from AsyncLocalStorage (not an instance field) is what keeps two
      // concurrent transactions from seeing each other.
      if (this._txClientForContext()) return fn(...args);
      const driver = await this._driver();

      const runInTx = async (client) => {
        await client.query('BEGIN');
        try {
          const result = await fn(...args);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) { /* keep original error */ }
          throw err;
        }
      };

      if (typeof driver.connect !== 'function') {
        // Single-connection drivers (e.g. PGlite) have no pool to check out
        // from — everyone shares one session, so concurrent transactions must
        // QUEUE. Without this, two overlapping calls interleaved their
        // BEGIN/COMMIT pairs on the same connection: the first COMMIT ended
        // both, and the second transaction's tail ran outside any transaction.
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const previous = this._txLock;
        this._txLock = previous.then(() => held);
        await previous;
        try {
          return await this._txStorage.run(driver, () => runInTx(driver));
        } finally {
          release();
        }
      }

      const client = await driver.connect();
      try {
        // Everything fn() does — however deep the call chain — sees this
        // client via _txClientForContext(), and ONLY this transaction's
        // context does. No shared field to overwrite, nothing to null out.
        return await this._txStorage.run(client, () => runInTx(client));
      } finally {
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
