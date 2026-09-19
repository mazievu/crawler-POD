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
 * Multi-keyword fan-out (TASK-2).
 *
 * A submitted Run carrying N keywords is not one crawl of an N-keyword string —
 * it is N independent Tasks (§4: "Task = đơn vị công việc độc lập bên trong
 * Run ... ví dụ product, listing URL, capture URL, query"). A query is already
 * named in the rules as a Task unit, so this adds no new concept: it splits a
 * parent Run into one child Run per keyword, exactly the way planShards()
 * splits it into one child Run per size shard, and the SAME scheduler
 * admission path (pool slot + RAM reservation per child) then gives each
 * keyword its own Worker.
 */
function needsKeywordFanOut(plan) {
  const keywords = plan && plan.options ? plan.options.keywords : null;
  return Array.isArray(keywords) && keywords.length > 1;
}

/**
 * Splits a parent run into one child descriptor per keyword. Like planShards()
 * this touches no database — the scheduler persists these via db.createRun with
 * parentRunId set.
 *
 * maxItems SEMANTICS (rules §5.4) — PER KEYWORD, not divided across keywords:
 *
 *   planShards() divides maxItems because its shards partition ONE result set:
 *   items 0..99 and 100..199 of the same query are the same list, so the parts
 *   must add up to N.
 *
 *   Keywords are DIFFERENT result sets. There is nothing to partition. The
 *   existing single-keyword contract is "return up to maxItems for this query",
 *   and each keyword here IS such a query, so each keeps the full budget.
 *   Dividing instead would make the depth of every keyword depend on how many
 *   other keywords the user happened to type (maxItems=20 over 4 keywords
 *   would become a top-5 crawl), silently changing the meaning of a number the
 *   user set. Upper bound for the whole submission is therefore
 *   maxItems x keywordCount — surfaced in the UI before the user submits.
 */
function planKeywordTasks(run, plan) {
  const keywords = plan.options.keywords;
  const maxItems = Number(plan.maxItems || (run && run.max_items) || 0) || 1;
  return keywords.map((keyword, index) => ({
    keyword,
    keywordIndex: index,
    keywordCount: keywords.length,
    maxItems
  }));
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

module.exports = { needsSharding, planShards, needsKeywordFanOut, planKeywordTasks, aggregateShardResults, allShardsTerminal };
