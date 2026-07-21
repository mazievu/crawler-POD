const crypto = require('node:crypto');

function createCaptureJobQueue({ runCapture, idFactory = () => crypto.randomUUID() } = {}) {
  if (typeof runCapture !== 'function') throw new Error('runCapture must be a function');
  const jobs = new Map();

  function snapshot(job) {
    return { id: job.id, status: job.status, result: job.result, error: job.error };
  }

  function enqueue(input) {
    const job = { id: idFactory(), status: 'running', result: null, error: null };
    jobs.set(job.id, job);
    Promise.resolve()
      .then(() => runCapture(input))
      .then((result) => { job.status = 'completed'; job.result = result; })
      .catch((error) => { job.status = 'failed'; job.error = String(error?.message || 'Capture failed'); });
    return snapshot(job);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? snapshot(job) : null;
  }

  return { enqueue, get };
}

module.exports = { createCaptureJobQueue };
