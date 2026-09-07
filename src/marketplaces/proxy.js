const SUPPORTED_PROTOCOLS = new Set(['socks5', 'http', 'https']);

function validateProxy(input = {}) {
  const label = String(input.label || input.id || '').trim();
  const protocol = String(input.protocol || 'socks5').toLowerCase().trim();
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  const username = input.username == null ? '' : String(input.username);
  const password = input.password == null ? '' : String(input.password);

  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Unsupported proxy protocol: ${protocol}. Must be socks5, http, or https`);
  }
  if (!host || host.length > 253 || /[\s/@]/.test(host)) {
    throw new Error(`${protocol.toUpperCase()} proxy host is invalid`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${protocol.toUpperCase()} proxy port must be between 1 and 65535`);
  }
  if (username.length > 256 || password.length > 512) {
    throw new Error(`${protocol.toUpperCase()} proxy credentials are too long`);
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new Error(`${protocol.toUpperCase()} proxy username and password must be provided together`);
  }

  return {
    id: input.id || label,
    label: label || `${host}:${port}`,
    protocol,
    host,
    port,
    username,
    password,
    enabled: input.enabled !== false
  };
}

function validateSocks5Proxy(input = {}) {
  const label = String(input.label || '').trim();
  if (!label || label.length > 100) throw new Error('Proxy label must be between 1 and 100 characters');
  return validateProxy({ ...input, protocol: 'socks5', label });
}

function buildProxyUrl(proxy) {
  const normalized = validateProxy(proxy);
  const host = normalized.host.includes(':') && !normalized.host.startsWith('[')
    ? `[${normalized.host}]`
    : normalized.host;
  const credentials = normalized.username
    ? `${encodeURIComponent(normalized.username)}:${encodeURIComponent(normalized.password)}@`
    : '';
  return `${normalized.protocol}://${credentials}${host}:${normalized.port}`;
}

function buildSocks5ProxyUrl(proxy) {
  return buildProxyUrl({ ...proxy, protocol: 'socks5' });
}

function proxyMetadata(proxy) {
  return {
    id: proxy.id,
    label: proxy.label || `${proxy.host}:${proxy.port}`,
    protocol: proxy.protocol || 'socks5',
    host: proxy.host,
    port: proxy.port,
    enabled: proxy.enabled !== false,
    created_at: proxy.created_at,
    updated_at: proxy.updated_at,
  };
}

function toPlaywrightProxy(proxy) {
  if (!proxy) return null;
  const normalized = validateProxy(proxy);
  const server = `${normalized.protocol}://${normalized.host}:${normalized.port}`;
  if (normalized.username && normalized.password) {
    return { server, username: normalized.username, password: normalized.password };
  }
  return { server };
}

module.exports = {
  SUPPORTED_PROTOCOLS,
  validateProxy,
  validateSocks5Proxy,
  buildProxyUrl,
  buildSocks5ProxyUrl,
  proxyMetadata,
  toPlaywrightProxy
};
