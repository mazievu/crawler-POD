const db = require('./database');
const registry = require('./channels/registry');
const { BackendRouter } = require('./router/backend-router');
const { normalizeItems } = require('./normalize');
const doctorModule = require('./doctor');

const router = new BackendRouter({ registry, doctor: doctorModule });

async function executeRun(runId, platform, query, options = {}) {
  try {
    db.updateRun(runId, { status: 'running' });

    const channel = registry.getChannel(platform);
    if (!channel) throw new Error(`Unknown channel: ${platform}`);

    // Route and Run
    const result = await router.run(platform, query, options);

    // Save metadata early in case of normalization failure
    db.updateRun(runId, {
      activeBackend: result.activeBackend,
      backendKind: result.backendKind,
      backendStatus: result.backendStatus,
      backendVersion: result.backendVersion,
      backendRunId: result.backendRunId,
      apifyDatasetId: result.datasetId, // Map for backward compatibility
      healthSnapshot: JSON.stringify(result.healthSnapshot || {})
    });

    if (result.raw.rawStatus !== 'SUCCEEDED') {
      throw new Error(`Backend run failed with status: ${result.raw.rawStatus}`);
    }

    // Normalize items based on channel's primary intelligence type or configured normalizer
    const normalizerName = channel.normalizer;
    const normalizedItems = normalizeItems(normalizerName, result.items || [], { platform, query });
    // Image-only collection is intentional: every stored post/listing must
    // have a visual asset that can be shown in the product intelligence UI.
    const itemsWithImages = normalizedItems.filter((item) => item.image);
    const skippedWithoutImages = normalizedItems.length - itemsWithImages.length;

    // Save to DB
    const dbCounts = db.insertSnapshots(runId, platform, query, itemsWithImages);
    
    db.updateRun(runId, {
      status: 'done',
      ...dbCounts
    });

    console.log(`Run ${runId} completed via ${result.activeBackend}: ${itemsWithImages.length} items with images (${skippedWithoutImages} skipped, ${dbCounts.newItems} new)`);

  } catch (err) {
    console.error(`Run ${runId} failed:`, err);
    db.updateRun(runId, { status: 'failed', errorMessage: err.message });
  }
}

module.exports = { executeRun, router };
