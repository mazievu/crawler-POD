const CURRENCY_MAP = {
  '$': 'USD',
  'USD': 'USD',
  'US$': 'USD',
  '₫': 'VND',
  'VND': 'VND',
  'VNĐ': 'VND',
  '€': 'EUR',
  'EUR': 'EUR',
  '£': 'GBP',
  'GBP': 'GBP',
  '¥': 'JPY',
  'JPY': 'JPY',
  'C$': 'CAD',
  'CA$': 'CAD',
  'CAD': 'CAD',
  'A$': 'AUD',
  'AU$': 'AUD',
  'AUD': 'AUD',
  'NZ$': 'NZD',
  'NZD': 'NZD',
  'SGD': 'SGD',
  'S$': 'SGD',
  'HKD': 'HKD',
  'HK$': 'HKD',
  'THB': 'THB',
  '฿': 'THB',
  'MYR': 'MYR',
  'RM': 'MYR',
  'IDR': 'IDR',
  'RP': 'IDR',
  'PHP': 'PHP',
  '₱': 'PHP',
  'INR': 'INR',
  '₹': 'INR',
  'KRW': 'KRW',
  '₩': 'KRW',
  'CNY': 'CNY',
  'RMB': 'CNY'
};

function normalizeCurrencyCode(raw) {
  if (!raw) return 'USD';
  const text = String(raw).trim();
  const upper = text.toUpperCase();
  return CURRENCY_MAP[upper] || CURRENCY_MAP[text] || upper;
}

class FxService {
  constructor(options = {}) {
    this.providerUrl = options.providerUrl || process.env.FX_PROVIDER_URL || 'https://open.er-api.com/v6/latest/USD';
    this.apiKey = options.apiKey || process.env.FX_API_KEY || null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.cachedUsdRates = null;
    this.cachedUsdRatesTime = 0;
    this.cacheTtlMs = Number(options.cacheTtlMs) || 3600000; // 1 hour default
  }

  async getUsdRates() {
    const now = Date.now();
    if (this.cachedUsdRates && (now - this.cachedUsdRatesTime < this.cacheTtlMs)) {
      return this.cachedUsdRates;
    }

    try {
      const url = this.providerUrl;
      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await this.fetchImpl(url, { headers });
      if (!res.ok) throw new Error(`FX Provider HTTP ${res.status}`);
      const data = await res.json();

      const rates = data.rates || data.conversion_rates || {};
      if (!rates || typeof rates !== 'object' || Object.keys(rates).length === 0) {
        throw new Error('FX Provider returned invalid or empty rates');
      }

      this.cachedUsdRates = rates;
      this.cachedUsdRatesTime = now;
      return rates;
    } catch (err) {
      console.warn('[FxService] Failed to fetch latest USD rates from provider:', err.message);
      throw err;
    }
  }

  /**
   * Get conversion multiplier from `fromCurrency` to USD.
   * e.g. from VND -> USD returns ~0.00003839 (1/26044)
   */
  async getRate(fromCurrency, toCurrency = 'USD') {
    const from = normalizeCurrencyCode(fromCurrency);
    const to = normalizeCurrencyCode(toCurrency);
    if (from === to) return 1.0;

    if (to === 'USD') {
      const rates = await this.getUsdRates();
      const directRate = rates[from];
      if (!directRate || typeof directRate !== 'number' || directRate <= 0) {
        throw new Error(`Rate unavailable for currency ${from}`);
      }
      return 1.0 / directRate;
    }

    throw new Error(`Converting to ${to} is currently not supported (target must be USD)`);
  }

  /**
   * Convert an amount from source currency to USD
   */
  convertToUsd(amount, fromCurrency, options = {}) {
    const numericAmount = typeof amount === 'number'
      ? amount
      : parseFloat(String(amount || '0').replace(/,/g, '')) || 0;
    const sourceCurrency = normalizeCurrencyCode(fromCurrency);

    if (sourceCurrency === 'USD' || !numericAmount || numericAmount <= 0) {
      return {
        price: numericAmount,
        currency: 'USD',
        source_price: numericAmount,
        source_currency: sourceCurrency || 'USD',
        fx_rate: 1.0,
        fx_at: new Date().toISOString()
      };
    }

    if (options.runRatesCache && options.runRatesCache.has(sourceCurrency)) {
      const rate = options.runRatesCache.get(sourceCurrency);
      const rawConverted = numericAmount * rate;
      const usdPrice = Math.round(rawConverted * 100) / 100;
      return {
        price: usdPrice,
        currency: 'USD',
        source_price: numericAmount,
        source_currency: sourceCurrency,
        fx_rate: rate,
        fx_at: new Date().toISOString()
      };
    }

    return (async () => {
      try {
        const rate = await this.getRate(sourceCurrency, 'USD');
        if (options.runRatesCache) {
          options.runRatesCache.set(sourceCurrency, rate);
        }

        const rawConverted = numericAmount * rate;
        const usdPrice = Math.round(rawConverted * 100) / 100;

        return {
          price: usdPrice,
          currency: 'USD',
          source_price: numericAmount,
          source_currency: sourceCurrency,
          fx_rate: rate,
          fx_at: new Date().toISOString()
        };
      } catch (err) {
        console.warn(`[FxService] FX conversion failed for ${numericAmount} ${sourceCurrency}: ${err.message}`);
        return {
          price: numericAmount,
          currency: sourceCurrency,
          source_price: numericAmount,
          source_currency: sourceCurrency,
          fx_rate: null,
          fx_at: new Date().toISOString(),
          fx_error: 'FX_CONVERSION_FAILED'
        };
      }
    })();
  }
}

/**
 * Creates an in-run FX context ensuring all items in a single Run share
 * the exact same crawl-time FX rates without redundant API calls.
 */
function createRunFxContext(service = getFxService()) {
  const runRatesCache = new Map();
  return {
    runRatesCache,
    getRate: (from, to) => service.getRate(from, to),
    convertToUsd: (amount, from) => service.convertToUsd(amount, from, { runRatesCache })
  };
}

let singleton = null;
function getFxService() {
  if (!singleton) singleton = new FxService();
  return singleton;
}

module.exports = {
  FxService,
  getFxService,
  createRunFxContext,
  normalizeCurrencyCode
};
