const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const { encryptText, decryptText } = require('../src/security/encrypted-store');
const { parseMarketplaceHtml } = require('../src/marketplaces/html-parser');
const { assertMarketplaceUrl } = require('../src/marketplaces/validation');

const PRODUCT_HTML = {
  amazon: `<!doctype html><html><head><script type="application/ld+json">{
    "@context":"https://schema.org", "@type":"Product", "name":"Acme Wireless Headphones",
    "sku":"B012345678", "image":"https://images.example.test/headphones.jpg",
    "brand":{"@type":"Brand","name":"Acme"},
    "offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD","availability":"https://schema.org/InStock"},
    "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"1,234"}
  }</script></head><body></body></html>`,
  ebay: `<!doctype html><html><head><script type="application/ld+json">{
    "@context":"https://schema.org", "@type":"Product", "name":"Vintage Camera",
    "image":["https://images.example.test/camera.jpg"],
    "offers":{"@type":"Offer","price":"125.00","priceCurrency":"USD","availability":"https://schema.org/InStock"},
    "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"82"}
  }</script></head><body></body></html>`,
  etsy: `<!doctype html><html><head><script type="application/ld+json">{
    "@context":"https://schema.org", "@type":"Product", "name":"Handmade Ceramic Mug",
    "sku":"123456789", "image":"https://images.example.test/mug.jpg",
    "offers":{"@type":"Offer","price":"28.50","priceCurrency":"USD","availability":"https://schema.org/InStock"},
    "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"310"}
  }</script></head><body></body></html>`,
};

test('encrypts a saved browser session and rejects a modified payload', () => {
  const encrypted = encryptText(JSON.stringify({ cookies: [{ name: 'session', value: 'secret' }] }));

  assert.notEqual(encrypted, '{"cookies":[{"name":"session","value":"secret"}]}');
  assert.equal(decryptText(encrypted), '{"cookies":[{"name":"session","value":"secret"}]}');
  assert.throws(() => decryptText(`${encrypted}x`), /decrypt/i);
});

for (const [platform, html] of Object.entries(PRODUCT_HTML)) {
  test(`${platform} HTML parser extracts usable product metrics`, () => {
    const result = parseMarketplaceHtml({
      platform,
      url: platform === 'amazon'
        ? 'https://www.amazon.com/dp/B012345678'
        : platform === 'ebay'
          ? 'https://www.ebay.com/itm/987654321'
          : 'https://www.etsy.com/listing/123456789/ceramic-mug',
      html,
    });

    assert.deepEqual(result, {
      platform,
      title: platform === 'amazon' ? 'Acme Wireless Headphones' : platform === 'ebay' ? 'Vintage Camera' : 'Handmade Ceramic Mug',
      url: platform === 'amazon' ? 'https://www.amazon.com/dp/B012345678' : platform === 'ebay' ? 'https://www.ebay.com/itm/987654321' : 'https://www.etsy.com/listing/123456789/ceramic-mug',
      listingId: platform === 'amazon' ? 'B012345678' : platform === 'ebay' ? '987654321' : '123456789',
      image: platform === 'amazon' ? 'https://images.example.test/headphones.jpg' : platform === 'ebay' ? 'https://images.example.test/camera.jpg' : 'https://images.example.test/mug.jpg',
      price: platform === 'ebay' ? 125 : platform === 'etsy' ? 28.5 : 49.99,
      currency: 'USD',
      rating: platform === 'ebay' ? 4.9 : platform === 'etsy' ? 4.8 : 4.6,
      reviewCount: platform === 'ebay' ? 82 : platform === 'etsy' ? 310 : 1234,
      availability: 'in_stock',
      brand: platform === 'amazon' ? 'Acme' : '',
    });
  });
}

test('capture only accepts URLs belonging to the selected marketplace', () => {
  assert.doesNotThrow(() => assertMarketplaceUrl('amazon', 'https://www.amazon.com/dp/B012345678'));
  assert.doesNotThrow(() => assertMarketplaceUrl('ebay', 'https://www.ebay.co.uk/itm/987654321'));
  assert.doesNotThrow(() => assertMarketplaceUrl('etsy', 'https://www.etsy.com/listing/123456789/ceramic-mug'));
  assert.throws(() => assertMarketplaceUrl('amazon', 'https://attacker.example/amazon.com'), /does not belong/i);
  assert.throws(() => assertMarketplaceUrl('shopify', 'https://example.test'), /Unsupported marketplace/i);
});
