const BaseBackend = require('./base.backend');

class MockBackend extends BaseBackend {
  constructor() {
    super({ name: 'mock', kind: 'mock' });
  }

  async probe(channel, backendConfig) {
    if (backendConfig.failProbe) {
      throw new Error('Mock probe failure');
    }
    return { status: 'ok', version: '1.0.0' };
  }

  async run(channel, backendConfig, query, options = {}) {
    return {
      backend: this.name,
      backendKind: this.kind,
      backendRunId: 'mock-run-123',
      datasetId: 'mock-dataset-456',
      items: [{ id: 1, text: 'Mock item 1' }],
      rawStatus: 'SUCCEEDED',
      healthSnapshot: { mock: true }
    };
  }

  getHealthHint(error) {
    return { message: error.message, action: 'Check mock configuration' };
  }
}

module.exports = MockBackend;
