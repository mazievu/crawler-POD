function validateSocks5Proxy(input = {}) {
  const label = String(input.label || '').trim();
  const host = String(input.host || '').trim();
  const port = Number(input.port);
  const username = input.username == null ? '' : String(input.username);
  const password = input.password == null ? '' : String(input.password);

  if (!label || label.length > 100) throw new Error('Proxy label must be between 1 and 100 characters');
  if (!host || host.length > 253 || /[\s/@]/.test(host)) throw new Error('SOCKS5 proxy host is invalid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOCKS5 proxy port must be between 1 and 65535');
  if (username.length > 256 || password.length > 512) throw new Error('SOCKS5 proxy credentials are too long');
  if (Boolean(username) !== Boolean(password)) throw new Error('SOCKS5 proxy username and password must be provided together');

  return { label, protocol: 'socks5', host, port, username, password };
}

function buildSocks5ProxyUrl(proxy) {
  const normalized = validateSocks5Proxy(proxy);
  const host = normalized.host.includes(':') && !normalized.host.startsWith('[')
    ? `[${normalized.host}]`
    : normalized.host;
  const credentials = normalized.username
    ? `${encodeURIComponent(normalized.username)}:${encodeURIComponent(normalized.password)}@`
    : '';
  return `socks5://${credentials}${host}:${normalized.port}`;
}

function proxyMetadata(proxy) {
  return {
    id: proxy.id,
    label: proxy.label,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    created_at: proxy.created_at,
    updated_at: proxy.updated_at,
  };
}

module.exports = { validateSocks5Proxy, buildSocks5ProxyUrl, proxyMetadata };
