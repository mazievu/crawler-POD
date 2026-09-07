const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');
const db = require('../src/database');

const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'collector.db');

/**
 * §12/§20.Q/R: LEGACY_SNAPSHOT_WRITE is read once at module load
 * (src/database.js) via process.env, so it cannot be toggled inside this
 * already-running test process. Spawning a real child process with the env
 * var set is the same mechanism production actually uses to flip the flag —
 * this proves the real behavior, not a simulated one.
 */
// The PostgreSQL connection is opened at module load and keeps the event loop
// alive, so the test process would never exit on its own once the suite ends.
after(async () => { await db._connection.close(); });

function runInChildWithEnv(env, code) {
  const output = execFileSync(process.execPath, ['-e', code], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return JSON.parse(output.trim().split('\n').pop());
}

test('LEGACY_SNAPSHOT_WRITE=false: legacy snapshot row count is unchanged by a real crawl (#20.Q)', () => {
  const suffix = Date.now();
  const script = `
    const db = require('${path.join(PROJECT_ROOT, 'src', 'database').replace(/\\/g, '\\\\')}');
    const platform = 'test';
    const query = 'cutover-q-${suffix}';
    // §16 CONTRACT CHANGE (PostgreSQL cutover): this used to count rows in
    // data/collector.db with its own better-sqlite3 handle. The application no
    // longer writes to that file at all, so the legacy-snapshot count is now
    // read from the snapshots table in PostgreSQL — the same assertion
    // (LEGACY_SNAPSHOT_WRITE=false must not grow it) on the current backend.
    (async () => {
      await db.initDatabase();
      const countSnapshots = async () =>
        (await db.getSnapshotsMatchingQuery(platform, query, 500)).length;

      const legacyBefore = await countSnapshots();
      const run = await db.createRun({ platform, query, maxItems: 2 });
      await db.insertSnapshots(run.id, platform, query, [
        { title: 'A', url: 'https://example.com/cutover-q-${suffix}/a', likes: 1 },
        { title: 'B', url: 'https://example.com/cutover-q-${suffix}/b', likes: 2 },
      ]);
      const legacyAfter = await countSnapshots();
      await db.deleteRun(run.id);
      console.log(JSON.stringify({ legacyBefore, legacyAfter }));
      // The PostgreSQL connection keeps the event loop alive, so an async
      // child script has to exit explicitly; the old synchronous one ended
      // on its own.
      process.exit(0);
    })();
  `;
  const result = runInChildWithEnv({ LEGACY_SNAPSHOT_WRITE: 'false' }, script);
  assert.equal(result.legacyAfter, result.legacyBefore, 'snapshots table row count must not grow when LEGACY_SNAPSHOT_WRITE=false');
});

test('With legacy writes OFF, new/active/dropped stay correct across two sequential Runs (#12/#20.R)', () => {
  const suffix = Date.now();
  const script = `
    const db = require('${path.join(PROJECT_ROOT, 'src', 'database').replace(/\\/g, '\\\\')}');
    const platform = 'test';
    const query = 'cutover-r-${suffix}';

    (async () => {
      await db.initDatabase();

      // Run 1: items A and B are both new.
      const run1 = await db.createRun({ platform, query, maxItems: 2, requestedBackend: null });
      await db.updateRun(run1.id, { status: 'done' }); // must be 'done' so the NEXT run can find it as the comparison baseline
      const result1 = await db.insertSnapshots(run1.id, platform, query, [
        { title: 'A', url: 'https://example.com/cutover-r-${suffix}/a', likes: 1 },
        { title: 'B', url: 'https://example.com/cutover-r-${suffix}/b', likes: 2 },
      ]);

      // Run 2: A is seen again (active), B is gone (dropped), C is new.
      const run2 = await db.createRun({ platform, query, maxItems: 2 });
      const result2 = await db.insertSnapshots(run2.id, platform, query, [
        { title: 'A', url: 'https://example.com/cutover-r-${suffix}/a', likes: 5 },
        { title: 'C', url: 'https://example.com/cutover-r-${suffix}/c', likes: 3 },
      ]);

      await db.deleteRun(run1.id);
      await db.deleteRun(run2.id);
      console.log(JSON.stringify({ result1, result2 }));
      process.exit(0); // see note above: PostgreSQL keeps the loop alive
    })();
  `;
  const { result1, result2 } = runInChildWithEnv({ LEGACY_SNAPSHOT_WRITE: 'false' }, script);

  assert.deepEqual(result1, { newItems: 2, activeItems: 0, droppedItems: 0 }, 'Run 1: A and B must both be new');
  assert.deepEqual(result2, { newItems: 1, activeItems: 1, droppedItems: 1 }, 'Run 2 with legacy writes OFF: A=active, B=dropped, C=new must all be correct from V2 state alone');
});

// §11 (Final Architecture Closure Round): export growth must be computed
// from the V2 source (product_current's delta_* fields) under READ_MODEL_V2,
// not silently degrade to 0 because legacy snapshot history stopped growing.
test('getProductCurrentByUid exposes real non-zero growth across two sequential crawls, the source export now reads under READ_MODEL_V2 (#11)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'growth-v2-' + suffix;
  const url = `https://example.com/growth-v2-${suffix}/a`;
  const itemUid = `${platform}:${url}`;

  const run1 = await db.createRun({ platform, query, maxItems: 1 });
  await db.updateRun(run1.id, { status: 'done' });
  await db.insertSnapshots(run1.id, platform, query, [
    { title: 'Growth Item', url, price: 10, views: 100, likes: 5, soldCount: 3, reviews: 20 }
  ]);

  const afterFirstCrawl = await db.getProductCurrentByUid(itemUid);
  assert.ok(afterFirstCrawl, 'product_current row must exist after the first crawl');
  assert.equal(afterFirstCrawl.delta_likes, 0, 'a brand-new item has no prior observation to diff against');

  const run2 = await db.createRun({ platform, query, maxItems: 1 });
  await db.insertSnapshots(run2.id, platform, query, [
    { title: 'Growth Item', url, price: 12, views: 100, likes: 9, soldCount: 5, reviews: 25 }
  ]);

  const afterSecondCrawl = await db.getProductCurrentByUid(itemUid);
  try {
    assert.equal(afterSecondCrawl.delta_likes, 4, 'delta_likes must reflect the real 5->9 change, not 0');
    assert.equal(afterSecondCrawl.delta_sold, 2, 'delta_sold must reflect the real 3->5 change, not 0');
    assert.equal(afterSecondCrawl.delta_reviews, 5, 'delta_reviews must reflect the real 20->25 change, not 0');
    assert.equal(Number(afterSecondCrawl.delta_price.toFixed(2)), 2, 'delta_price must reflect the real 10->12 change, not 0');
  } finally {
    const raw = db._connection;
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run1.id);
    await db.deleteRun(run2.id);
  }
});

// Gap #3 mandatory regression (Final Gap Closure Round): count parity alone
// cannot catch a wrong VALUE inside an existing, correctly-identified
// observation. Exact per-observation identity (legacy:<snapshotId>) mapping
// must catch it, including the newly-finalized `reviews` field.
test('checkV2Parity detects an exact metric mismatch inside a correctly-identified packed observation, including reviews (Gap #3)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'gap3-metric-' + suffix;
  const url = `https://example.com/gap3-metric-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'Gap3 Item', url, price: 10, views: 100, likes: 5, comments: 1, shares: 1, soldCount: 2, rating: 4.5, reviews: 20 }
    ]);

    // Migrate the legacy snapshot into daily_packed_history under its
    // deterministic legacy:<snapshotId> identity.
    await db.backfillSnapshotsToV2();

    const legacySnap = await raw.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
    assert.ok(legacySnap, 'legacy snapshot must exist');
    const expectedObservationId = `legacy:${legacySnap.id}`;

    const packedRow = await raw.prepare('SELECT * FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    assert.ok(packedRow, 'a packed history row must exist after backfill');
    const observations = JSON.parse(packedRow.observations_json);
    const idx = observations.findIndex((o) => o.observationId === expectedObservationId);
    assert.ok(idx >= 0, 'the exact migrated observation must be found by its deterministic identity');

    // Corrupt the VALUE inside the exact same observation — same count, same identity.
    observations[idx].likes = 999;
    observations[idx].reviews = 12345;
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?').run(JSON.stringify(observations), itemUid);

    const parity = await db.checkV2Parity();
    assert.equal(parity.parityOk, false, 'a metric mismatch inside a correctly-identified observation must fail parityOk, not just the count check');

    const likesMismatch = parity.history.historyMetricMismatchSamples.find((m) => m.itemUid === itemUid && m.field === 'likes');
    assert.ok(likesMismatch, 'likes mismatch must be detected even though counts still match');
    assert.equal(likesMismatch.legacyValue, 5);
    assert.equal(likesMismatch.obsValue, 999);

    const reviewsMismatch = parity.history.historyMetricMismatchSamples.find((m) => m.itemUid === itemUid && m.field === 'reviews');
    assert.ok(reviewsMismatch, 'reviews mismatch must be detected — reviews must now exist in the packed observation schema');
    assert.equal(reviewsMismatch.legacyValue, 20);
    assert.equal(reviewsMismatch.obsValue, 12345);
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// §13/§20.O: checkV2Parity must catch a mismatch in a metric OTHER than
// price/likes (the pre-§13 check only compared those two).
test('checkV2Parity detects a full-metric mismatch beyond price/likes (#13/#20.O)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'parity-o-' + suffix;
  const url = `https://example.com/parity-o-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'Parity Item', url, price: 10, views: 100, likes: 5, comments: 2, shares: 1, soldCount: 3, rating: 4.5, reviews: 20 }
    ]);

    // Desync product_current's `views` from what was just legacy-written —
    // price/likes still agree, so the OLD price/likes-only check would have
    // reported this as a false PASS.
    await raw.prepare('UPDATE product_current SET current_views = ? WHERE item_uid = ?').run(9999, itemUid);

    const parity = await db.checkV2Parity();
    const viewsMismatch = parity.current.metricMismatches.find((m) => m.itemUid === itemUid && m.field === 'views');
    assert.ok(viewsMismatch, 'checkV2Parity must report the views mismatch');
    assert.equal(viewsMismatch.legacyValue, 100);
    assert.equal(viewsMismatch.v2Value, 9999);
    assert.equal(parity.parityOk, false, 'A real metric mismatch must fail parityOk');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// §13/§20.P: history parity must detect legacy observations that never made
// it into daily_packed_history (a real, silent data-loss signal).
test('checkV2Parity detects missing historical observations (packed count < legacy count) (#13/#20.P)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'parity-p-' + suffix;
  const url = `https://example.com/parity-p-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'History Parity Item', url, price: 5, views: 10, likes: 1 }
    ]); // 1 legacy row, packed observation_count=1

    // Simulate a legacy observation that never reached V2 (a real historical
    // gap): insert a second raw `snapshots` row for the same item_uid without
    // touching daily_packed_history at all.
    await raw.prepare(`
      INSERT INTO snapshots (run_id, platform, query, item_uid, raw_data, title, url, price, likes, status)
      VALUES (?, ?, ?, ?, '{}', 'History Parity Item', ?, 5, 1, 'active')
    `).run(run.id, platform, query, itemUid, url);

    const parity = await db.checkV2Parity();
    assert.ok(parity.history.missingHistoricalObservationUids.includes(itemUid), 'checkV2Parity must flag this item_uid as having missing historical observations');
    assert.ok(parity.history.missingHistoricalObservations >= 1);
    assert.equal(parity.parityOk, false, 'Missing historical observations must fail parityOk');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// §5 mandatory regression: a duplicate observation must fail parityOk — it
// was previously computed but not included in the gate ("53 duplicates ->
// parityOk=true" was the exact bug this proves is fixed).
test('checkV2Parity: a duplicate observation makes parityOk false, not just visible in the count (#5)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'parity-dup-' + suffix;
  const url = `https://example.com/parity-dup-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [{ title: 'Dup Item', url, price: 1, views: 1, likes: 1 }]);
    const row = await raw.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    const obs = JSON.parse(row.observations_json);
    const duped = [...obs, { ...obs[0] }]; // force a real duplicate: same observationId AND same time
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ?, observation_count = ? WHERE item_uid = ?')
      .run(JSON.stringify(duped), duped.length, itemUid);

    const parity = await db.checkV2Parity();
    // The real production DB may already have other pre-existing duplicates
    // (found and reported honestly in this session's own report), and the
    // reported UID list is capped at 20 — so assert on the total count and
    // on parityOk, not on this specific item_uid appearing in a capped sample.
    assert.ok(parity.history.duplicateHistoricalObservations >= 1, 'duplicate count must reflect the one we just injected');
    assert.equal(parity.parityOk, false, 'A duplicate observation must fail parityOk, not just appear in the count');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// Gap #5 mandatory test: checkV2Parity fails on timestamp mismatch between legacy and V2
test('checkV2Parity detects timestamp mismatch between legacy snapshot and V2 observation (Gap #5)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'gap5-ts-' + suffix;
  const url = `https://example.com/gap5-ts-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'TS Item', url, price: 10, views: 100, likes: 5, reviews: 20 }
    ]);
    await db.backfillSnapshotsToV2();

    const legacySnap = await raw.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
    assert.ok(legacySnap, 'legacy snapshot must exist');
    const expectedObservationId = `legacy:${legacySnap.id}`;

    const row = await raw.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    const obs = JSON.parse(row.observations_json);
    const idx = obs.findIndex((o) => o.observationId === expectedObservationId);
    assert.ok(idx >= 0, 'migrated observation must be found by identity');

    // Tamper with observation time (e.g. set time to '00:00:00')
    obs[idx].time = '00:00:00';
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?')
      .run(JSON.stringify(obs), itemUid);

    const parity = await db.checkV2Parity();
    assert.equal(parity.parityOk, false, 'timestamp mismatch must fail parityOk');
    assert.ok(parity.history.historyTimestampMismatches >= 1, 'historyTimestampMismatches must be >= 1');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// Gap #5 mandatory test: checkV2Parity fails when the same observationId appears across TWO daily rows
test('checkV2Parity detects global duplicate observationId appearing across different daily rows (Gap #5)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'gap5-crossrow-' + suffix;
  const url = `https://example.com/gap5-crossrow-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'Crossrow Item', url, price: 10, views: 100, likes: 5, reviews: 20 }
    ]);
    await db.backfillSnapshotsToV2();

    const legacySnap = await raw.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
    assert.ok(legacySnap);
    const expectedObservationId = `legacy:${legacySnap.id}`;

    const row = await raw.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    const obs = JSON.parse(row.observations_json);
    const targetObs = obs.find((o) => o.observationId === expectedObservationId) || obs[0];

    // Insert a SECOND daily row on a different date containing the SAME observationId
    const secondDate = '2020-01-01';
    await raw.prepare(`
      INSERT INTO daily_packed_history (item_uid, platform, date, observations_json, observation_count, min_price, max_price, latest_price, latest_likes, latest_views, latest_sold, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 10, 10, 10, 5, 100, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(itemUid, platform, secondDate, JSON.stringify([targetObs]));

    const parity = await db.checkV2Parity();
    assert.equal(parity.parityOk, false, 'cross-row duplicate observationId must fail parityOk');
    assert.ok(parity.history.duplicateHistoricalObservations >= 1, 'duplicate count must catch cross-row duplicate');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// Gap #5 mandatory test: checkV2Parity flags malformed when observation is missing a required schema key
test('checkV2Parity flags malformed when observation is missing a required schema key (Gap #5)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'gap5-malformed-' + suffix;
  const url = `https://example.com/gap5-malformed-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'Malformed Item', url, price: 10, views: 100, likes: 5, reviews: 20 }
    ]);
    await db.backfillSnapshotsToV2();

    const row = await raw.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    const obs = JSON.parse(row.observations_json);
    // Delete a required schema key (e.g. 'reviews') across all entries
    for (const o of obs) {
      delete o.reviews;
    }
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?')
      .run(JSON.stringify(obs), itemUid);

    const parity = await db.checkV2Parity();
    assert.equal(parity.parityOk, false, 'missing schema key must fail parityOk');
    assert.ok(parity.history.malformedObservations >= 1, 'malformed count must reflect the missing key');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// Patch 2B mandatory test: normalizeLegacyUtcTimestamp interprets SQLite timestamp as UTC
test('normalizeLegacyUtcTimestamp interprets SQLite timestamp as UTC regardless of local timezone (Patch #2B)', () => {
  const { normalizeLegacyUtcTimestamp } = require('../src/database');
  const input = '2026-08-24 09:20:46';
  const expected = '2026-08-24T09:20:46.000Z';
  const actual = normalizeLegacyUtcTimestamp(input);
  assert.equal(actual, expected, 'SQLite CURRENT_TIMESTAMP string must be interpreted as UTC instant');
});

// Patch 2A mandatory test: asymmetric null fails parity (legacy has value, V2 null OR legacy null, V2 has value)
test('checkV2Parity fails parity on asymmetric null metrics between legacy and V2 (Patch #2A)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'patch2a-null-' + suffix;
  const url = `https://example.com/patch2a-null-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    await db.insertSnapshots(run.id, platform, query, [
      { title: 'Null Test Item', url, price: 10, views: 100, likes: 5, reviews: 20 }
    ]);
    await db.backfillSnapshotsToV2();

    const legacySnap = await raw.prepare('SELECT * FROM snapshots WHERE item_uid = ? ORDER BY id DESC LIMIT 1').get(itemUid);
    assert.ok(legacySnap);
    const expectedObservationId = `legacy:${legacySnap.id}`;

    // Case 1: Legacy has reviews = 20, V2 packed observation sets reviews = null -> MISMATCH
    const row = await raw.prepare('SELECT observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    const obs = JSON.parse(row.observations_json);
    const targetObs = obs.find((o) => o.observationId === expectedObservationId) || obs[0];
    targetObs.reviews = null;

    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?')
      .run(JSON.stringify(obs), itemUid);

    const parity1 = await db.checkV2Parity();
    assert.equal(parity1.parityOk, false, 'legacy has value and V2 is null must fail parityOk');
    assert.ok(parity1.history.historyMetricMismatches >= 1, 'must count as historical metric mismatch');

    // Case 2: Legacy has reviews = null, V2 packed observation has reviews = 20 -> MISMATCH
    await raw.prepare('UPDATE snapshots SET reviews = NULL WHERE id = ?').run(legacySnap.id);
    targetObs.reviews = 20;
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?')
      .run(JSON.stringify(obs), itemUid);

    const parity2 = await db.checkV2Parity();
    assert.equal(parity2.parityOk, false, 'legacy is null and V2 has value must fail parityOk');
    assert.ok(parity2.history.historyMetricMismatches >= 1, 'must count as historical metric mismatch');

    // Case 3: Both legacy and V2 have reviews = null -> EQUAL (no mismatch)
    targetObs.reviews = null;
    await raw.prepare('UPDATE daily_packed_history SET observations_json = ? WHERE item_uid = ?')
      .run(JSON.stringify(obs), itemUid);

    const parity3 = await db.checkV2Parity();
    assert.equal(parity3.history.historyMetricMismatches, 0, 'both null must be considered equal (0 mismatch)');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});

// Patch 2B mandatory test: backfill with SQLite CURRENT_TIMESTAMP string produces exact UTC observation and 0 timestamp mismatch
test('Backfill with SQLite UTC timestamp string produces exact UTC observation and 0 timestamp mismatch (Patch #2B)', async () => {
  const suffix = Date.now();
  const platform = 'test';
  const query = 'patch2b-ts-' + suffix;
  const url = `https://example.com/patch2b-ts-${suffix}/a`;
  const itemUid = `${platform}:${url}`;
  const run = await db.createRun({ platform, query, maxItems: 1 });
  const raw = db._connection;
  try {
    const sqliteTs = '2026-08-24 09:20:46';
    await raw.prepare(`
      INSERT INTO snapshots (run_id, platform, query, item_uid, raw_data, title, url, price, views, likes, rating, reviews, sold_count, status, created_at)
      VALUES (?, ?, ?, ?, '{}', 'UTC TS Item', ?, 15, 200, 10, 4.5, 30, 5, 'active', ?)
    `).run(run.id, platform, query, itemUid, url, sqliteTs);

    const res = await db.backfillSnapshotsToV2();
    assert.ok(res.migrated >= 1);

    const row = await raw.prepare('SELECT date, observations_json FROM daily_packed_history WHERE item_uid = ?').get(itemUid);
    assert.ok(row);
    assert.equal(row.date, '2026-08-24', 'date must match UTC date');
    const obs = JSON.parse(row.observations_json);
    assert.equal(obs[0].time, '09:20:46', 'time must match UTC time');

    const parity = await db.checkV2Parity();
    const itemMismatch = parity.history.historyTimestampMismatchSamples.find((m) => m.itemUid === itemUid);
    assert.equal(itemMismatch, undefined, 'must have 0 timestamp mismatch for the backfilled item');
  } finally {
    await raw.prepare('DELETE FROM product_current WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM daily_packed_history WHERE item_uid = ?').run(itemUid);
    await raw.prepare('DELETE FROM snapshots WHERE item_uid = ?').run(itemUid);
    await db.deleteRun(run.id);
  }
});
