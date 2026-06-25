/**
 * Public web-page reader.
 *
 * Uses Jina Reader as a free fallback for arbitrary public URLs. This returns
 * readable Markdown/text, not platform-specific structured product metrics.
 */

const DEFAULT_READER_BASE = process.env.JINA_READER_URL || 'https://r.jina.ai/';

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new Error('url is required');
  if (/^https?:\/\//i.test(value)) return value;
  return 'https://' + value;
}

function buildJinaReaderUrl(url, base = DEFAULT_READER_BASE) {
  const normalizedBase = base.endsWith('/') ? base : base + '/';
  return normalizedBase + normalizeUrl(url);
}

function titleFromMarkdown(markdown, fallbackUrl) {
  const firstHeading = String(markdown || '').split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('# '));
  if (firstHeading) return firstHeading.replace(/^#\s+/, '').trim().slice(0, 200);
  return fallbackUrl;
}

async function readPublicWebPage(url, options = {}) {
  const normalizedUrl = normalizeUrl(url);
  const readerUrl = buildJinaReaderUrl(normalizedUrl, options.readerBase || DEFAULT_READER_BASE);
  const response = await fetch(readerUrl, {
    headers: {
      'Accept': 'text/plain',
      'User-Agent': 'Mozilla/5.0 ApifyCollector/1.0',
    },
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });

  if (!response.ok) {
    throw new Error('Jina Reader error: ' + response.status);
  }

  const markdown = await response.text();
  return {
    items: [{
      platform: 'web',
      title: titleFromMarkdown(markdown, normalizedUrl),
      url: normalizedUrl,
      content: markdown,
      source: 'jina-reader',
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0,
    }],
  };
}

module.exports = {
  normalizeUrl,
  buildJinaReaderUrl,
  readPublicWebPage,
};
