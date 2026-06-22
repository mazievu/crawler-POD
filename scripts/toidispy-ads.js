// Toidispy Ads Library Scraper
// Chạy trong browser context via CDP
/* eslint-env browser */

function scrapeAdsLibrary() {
  const cards = document.querySelectorAll('.p-item-col');
  const items = [];

  cards.forEach(card => {
    const pageNameEl = card.querySelector('.fw-500.text-primary');
    const timeEl = card.querySelector('[title="Created time"]');
    const adCountEl = card.querySelector('.badge');
    const adIdEl = card.querySelector('small');

    // Get domain from links
    const allLinks = Array.from(card.querySelectorAll('a[href*="redirect?type=aa"]'));
    const domain = allLinks.find(l => !l.textContent.match(/^\d+$/))?.textContent || '';
    const pageId = allLinks.find(l => l.textContent.match(/^\d+$/))?.textContent || '';
    const adAccount = allLinks.find(l => l.textContent !== domain && l.textContent !== pageId && !l.textContent.match(/^\d+$/))?.textContent || '';

    // Get ad count
    const adCountText = adCountEl ? adCountEl.textContent.trim() : '0';
    const adCount = parseInt(adCountText) || 0;

    // Get ad ID
    const adIdText = adIdEl ? adIdEl.textContent.replace('ID:', '').trim() : '';

    // Get type (photo/video)
    const hasVideo = card.querySelector('.fa-video, video') !== null;
    const type = hasVideo ? 'video' : 'photo';

    // Get status
    const hasActive = card.querySelector('.text-success') !== null;
    const hasInactive = card.querySelector('.text-danger') !== null;
    const status = hasActive ? 'active' : hasInactive ? 'inactive' : 'unknown';

    // Get image
    const imageEl = card.querySelector('.p-carousel-item-img');
    const imageUrl = imageEl ? imageEl.style.backgroundImage.replace(/url\("?|"?\)/g, '') : '';

    items.push({
      pageName: pageNameEl ? pageNameEl.textContent.trim() : '',
      createdTime: timeEl ? timeEl.textContent.trim() : '',
      adCount,
      adId: adIdText,
      domain,
      pageId,
      adAccount,
      type,
      status,
      imageUrl
    });
  });

  return items;
}

// Export for use in CDP context
if (typeof module !== 'undefined') {
  module.exports = { scrapeAdsLibrary };
}
