// Toidispy Posts Scraper
// Chạy trong browser context via CDP
/* eslint-env browser */

function scrapePosts() {
  const cards = document.querySelectorAll('.p-item-col');
  const items = [];

  cards.forEach(card => {
    const authorEl = card.querySelector('.fw-500.text-primary');
    const timeEl = card.querySelector('[title="Created time"]');
    const isAd = !!card.querySelector('.bg-success');
    const domainLinks = card.querySelectorAll('a[href*="redirect?type=ap"]');
    const domain = domainLinks.length > 0 ? domainLinks[0].textContent.trim() : '';
    const pageIdLink = card.querySelectorAll('a[href*="redirect?type=ap"]');
    const pageId = pageIdLink.length > 1 ? pageIdLink[1].textContent.trim() : '';
    const imageEl = card.querySelector('.p-carousel-item-img');
    const imageUrl = imageEl ? imageEl.style.backgroundImage.replace(/url\("?|"?\)/g, '') : '';

    // Get engagement stats
    const reactionSection = card.querySelector('.item-reactions');
    let reactions = 0, comments = 0, shares = 0;
    if (reactionSection) {
      const lines = reactionSection.innerText.split('\n').map(l => l.trim()).filter(l => l && l !== '--');
      if (lines.length >= 3) {
        reactions = parseInt(lines[0]) || 0;
        comments = parseInt(lines[1]) || 0;
        shares = parseInt(lines[2]) || 0;
      }
    }

    // Get tracking IDs
    const allLinks = Array.from(card.querySelectorAll('a[href*="redirect?type=ap"]'));
    const pixelId = allLinks.find(l => l.textContent.match(/^G-[A-Z0-9-]+$/))?.textContent || '';
    const gtmId = allLinks.find(l => l.textContent.match(/^GTM-[A-Z0-9-]+$/))?.textContent || '';
    const googleAdsId = allLinks.find(l => l.textContent.match(/^AW-\d+$/))?.textContent || '';

    items.push({
      author: authorEl ? authorEl.textContent.trim() : '',
      time: timeEl ? timeEl.textContent.trim() : '',
      isAd,
      reactions,
      comments,
      shares,
      domain,
      pageId,
      imageUrl,
      pixelId,
      gtmId,
      googleAdsId
    });
  });

  return items;
}

// Export for use in CDP context
if (typeof module !== 'undefined') {
  module.exports = { scrapePosts };
}
