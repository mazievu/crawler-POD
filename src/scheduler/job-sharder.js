/**
 * Large Job Sharder
 *
 * A request for a large maxItems is not run as one giant, unpredictable-memory
 * job. It is split into N shard runs, each bounded by the execution class's
 * configurable shardSize, so the Scheduler only ever has to admit small,
 * bounded units of work — it decides "run one more shard?" instead of trying
 * to predict the RAM cost of an entire 1000-item job upfront.
 *
 * Honesty note: shard correctness (avoiding duplicate/missing items across
 * shards) depends on the underlying channel/scraper honoring the `offset`/
 * `maxItems` hints passed in each shard's options. Not every channel in this
 * repository implements offset-based pagination today; where a channel ignores
 * `offset`, shards will fetch overlapping results rather than a true partition.
 * This module still correctly bounds RAM/concurrency per shard regardless —
 * that data-partitioning caveat is a per-channel capability gap, not a
 * scheduler defect, and is called out explicitly in the final report.
 */

function needsSharding(plan) {
  return Number(plan.shardCount || 1) > 1;
}

/**
 * Splits a parent run into `shardCount` child run descriptors. Does not touch
 * the database — callers (the scheduler) persist these via db.createRun with
 * parentRunId set.
 */
function planShards(run, plan) {
  const totalItems = Number(plan.maxItems || 100);
  const shardSize = Math.max(1, Number(plan.shardSize || totalItems));
  const shardCount = Math.max(1, Math.ceil(totalItems / shardSize));

  const shards = [];
  for (let i = 0; i < shardCount; i++) {
    const offset = i * shardSize;
    const remaining = totalItems - offset;
    shards.push({
      shardIndex: i,
      shardCount,
      maxItems: Math.min(shardSize, remaining),
      offset
    });
  }
  return shards;
}

/**
 * Aggregates a parent's finished/failed children into the parent run's final
 * counts, returning the aggregate summary. Caller decides the parent's final
 * status (e.g. 'done' if at least one shard succeeded, 'failed' if all failed).
 */
function aggregateShardResults(childRuns) {
  const summary = {
    totalShards: childRuns.length,
    doneShards: 0,
    failedShards: 0,
    itemsCount: 0,
    newCount: 0,
    activeCount: 0,
    droppedCount: 0
  };
  for (const child of childRuns) {
    if (child.status === 'done') summary.doneShards++;
    else if (child.status === 'failed' || child.status === 'stuck') summary.failedShards++;
    summary.itemsCount += Number(child.items_count || 0);
    summary.newCount += Number(child.new_count || 0);
    summary.activeCount += Number(child.active_count || 0);
    summary.droppedCount += Number(child.dropped_count || 0);
  }
  return summary;
}

function allShardsTerminal(childRuns) {
  return childRuns.length > 0 && childRuns.every(c => ['done', 'failed', 'stuck'].includes(c.status));
}

module.exports = { needsSharding, planShards, aggregateShardResults, allShardsTerminal };
