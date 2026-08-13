const QUANTITY_LABEL = /^(quantity|qty|số lượng)$/i;

function normalizeVariantMode(value) {
  return value === 'all' ? 'all' : 'base';
}

function normalizeMaxVariants(value, fallback = 150) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(250, Math.max(1, parsed));
}

function enumerateEtsyVariants(groups, maxVariants = 150) {
  const usable = (Array.isArray(groups) ? groups : [])
    .filter((group) => group && typeof group.selector === 'string' && group.selector)
    .filter((group) => !QUANTITY_LABEL.test(String(group.label || '').trim()))
    .map((group) => ({
      label: String(group.label || 'Option').trim(),
      selector: group.selector,
      options: (Array.isArray(group.options) ? group.options : [])
        .filter((option) => option && option.value != null && String(option.value).trim() && !option.disabled)
        .map((option) => ({
          label: String(group.label || 'Option').trim(),
          selector: group.selector,
          value: String(option.value),
          text: String(option.text || option.label || option.value).trim(),
        })),
    }))
    .filter((group) => group.options.length > 0);

  if (!usable.length) return { combinations: [], totalCombinations: 0, truncated: false };
  const totalCombinations = usable.reduce((total, group) => total * group.options.length, 1);
  const limit = normalizeMaxVariants(maxVariants);
  const combinations = [];

  function visit(index, selected) {
    if (combinations.length >= limit) return;
    if (index === usable.length) {
      combinations.push(selected);
      return;
    }
    for (const option of usable[index].options) {
      visit(index + 1, [...selected, option]);
      if (combinations.length >= limit) return;
    }
  }

  visit(0, []);
  return { combinations, totalCombinations, truncated: totalCombinations > combinations.length };
}

function parseMoney(value, currency) {
  const raw = String(value || '').replace(/[^0-9,.-]/g, '');
  if (!raw) return 0;
  if (/^(VND|JPY|KRW)$/i.test(currency)) return Number(raw.replace(/[.,]/g, '')) || 0;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? ',' : '.';
    normalized = raw.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.');
  } else if (lastComma !== -1) {
    normalized = /,\d{3}$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else if (lastDot !== -1 && /\.\d{3}$/.test(raw)) {
    normalized = raw.replace(/\./g, '');
  }
  return Number(normalized) || 0;
}

function extractEtsyPriceText(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const token = '(?:\\b[A-Z]{3}\\s*[0-9][0-9,.\\s]*|[$€£]\\s*[0-9][0-9,.\\s]*|[0-9][0-9,.\\s]*₫)';
  const labeled = new RegExp(`(?:Now|Sale)?\\s*Price:\\s*(${token})(?:\\s*Original\\s*Price:\\s*(${token}))?`, 'i').exec(source);
  if (!labeled) return source;
  return [labeled[1].trim(), labeled[2]?.trim()].filter(Boolean).join(' ');
}

function parseVisibleEtsyPrice(text) {
  const displayText = String(text || '').replace(/\s+/g, ' ').trim();
  const matches = [...displayText.matchAll(/(?:\b([A-Z]{3})\s*|([$€£])\s*)([0-9][0-9,\.\s]*)|([0-9][0-9,\.\s]*)\s*₫/g)];
  if (!matches.length) return null;
  const currencyFor = (match) => match[1] || ({ '$': 'USD', '€': 'EUR', '£': 'GBP' }[match[2]] || (match[4] ? 'VND' : ''));
  const amountFor = (match) => match[3] || match[4];
  const currency = currencyFor(matches[0]);
  const salePrice = parseMoney(amountFor(matches[0]), currency);
  const original = matches.slice(1).find((match) => currencyFor(match) === currency);
  const originalPrice = original ? parseMoney(amountFor(original), currency) : 0;
  return { salePrice, originalPrice, currency, displayText };
}

function summarizeVariantPrices(variants) {
  const priced = (Array.isArray(variants) ? variants : [])
    .map((variant) => variant?.price)
    .filter((price) => price && Number(price.salePrice) > 0 && price.currency);
  if (!priced.length) return {};
  const currency = priced[0].currency;
  const sameCurrency = priced.filter((price) => price.currency === currency);
  const sales = sameCurrency.map((price) => Number(price.salePrice));
  const originals = sameCurrency.map((price) => Number(price.originalPrice)).filter((price) => price > 0);
  const priceMin = Math.min(...sales);
  const priceMax = Math.max(...sales);
  return {
    price: priceMin,
    currency,
    priceMin,
    priceMax,
    ...(originals.length ? { originalPriceMin: Math.min(...originals), originalPriceMax: Math.max(...originals) } : {}),
    priceType: priceMin === priceMax ? 'variant_fixed' : 'variant_range',
    variantCount: sameCurrency.length,
  };
}

module.exports = { enumerateEtsyVariants, extractEtsyPriceText, normalizeMaxVariants, normalizeVariantMode, parseVisibleEtsyPrice, summarizeVariantPrices };
