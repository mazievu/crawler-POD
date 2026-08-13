class BaseBackend {
  constructor(options = {}) {
    this.name = options.name;
    this.kind = options.kind;
  }

  async probe(channel, backendConfig) {
    throw new Error('probe() not implemented');
  }

  async run(channel, backendConfig, query, options = {}) {
    throw new Error('run() not implemented');
  }

  async normalize(channel, rawItems) {
    return rawItems;
  }

  getHealthHint(error) {
    return {
      message: error?.message || 'Unknown backend error',
      action: 'Check backend configuration'
    };
  }
}

module.exports = BaseBackend;
