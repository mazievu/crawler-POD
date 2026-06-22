/**
 * Toidispy Filter Configuration
 * Mirror chính xác các filter trên toidispy.com (CDP inspected June 2026)
 *
 * Source: live CDP inspection of app.toidispy.com/posts & /libraries
 */

// ==================== POSTS FILTERS ====================

const POSTS_FILTERS = {
  keyword: {
    id: 'keyword',
    label: 'Keyword',
    type: 'text',
    placeholder: 'Enter keywords',
    required: true,
    order: 1,
  },
  pageId: {
    id: 'pageId',
    label: 'Page ID / Domain / Pixel',
    type: 'text',
    placeholder: 'Page id, domain, pixel',
    required: false,
    order: 2,
  },
  platforms: {
    id: 'platforms',
    label: 'Platform',
    type: 'multi-select',
    required: false,
    options: [
      { value: 'TeeChip', label: 'TeeChip' },
      { value: 'Viralstyle', label: 'Viralstyle' },
      { value: 'Shopbase', label: 'Shopbase' },
      { value: 'SenPrints', label: 'SenPrints' },
      { value: 'GearLaunch', label: 'GearLaunch' },
      { value: 'PODSach', label: 'PODSach' },
      { value: 'Shoplazza', label: 'Shoplazza' },
      { value: 'Shineon', label: 'Shineon' },
      { value: 'LatteX', label: 'LatteX' },
      { value: 'Mayzing', label: 'Mayzing' },
      { value: 'Teezily', label: 'Teezily' },
      { value: 'MerchKing', label: 'MerchKing' },
      { value: 'Teespring', label: 'Teespring' },
      { value: 'Moteefe', label: 'Moteefe' },
      { value: 'GearBubble', label: 'GearBubble' },
      { value: 'BurgerPrints', label: 'BurgerPrints' },
      { value: 'Shopify', label: 'Shopify' },
      { value: 'Woo', label: 'Woo' },
      { value: 'Amazon', label: 'Amazon' },
      { value: 'Etsy', label: 'Etsy' },
      { value: 'Merchize', label: 'Merchize' },
      { value: 'PrintsHub', label: 'PrintsHub' },
      { value: 'Other', label: 'Other' },
    ],
    order: 3,
  },
  categories: {
    id: 'categories',
    label: 'Category',
    type: 'multi-select',
    required: false,
    options: [
      { value: 'T-shirt', label: 'T-shirt' },
      { value: 'sweatshirt', label: 'sweatshirt' },
      { value: 'ugly sweater', label: 'ugly sweater' },
      { value: 'hoodie', label: 'hoodie' },
      { value: 'jersey', label: 'jersey' },
      { value: 'hawaiian shirt', label: 'hawaiian shirt' },
      { value: 'jacket', label: 'jacket' },
      { value: 'polo shirt', label: 'polo shirt' },
      { value: 'pajamas', label: 'pajamas' },
      { value: 'sign', label: 'sign' },
      { value: 'flag', label: 'flag' },
      { value: 'poster - canvas', label: 'poster - canvas' },
      { value: 'mug', label: 'mug' },
      { value: 'glass', label: 'glass' },
      { value: 'tumbler', label: 'tumbler' },
      { value: 'bedding', label: 'bedding' },
      { value: 'doormat', label: 'doormat' },
      { value: 'laundry', label: 'laundry' },
      { value: 'plaque', label: 'plaque' },
      { value: 'jewelry', label: 'jewelry' },
      { value: 'ornament', label: 'ornament' },
      { value: 'crocs', label: 'crocs' },
      { value: 'shoe', label: 'shoe' },
      { value: 'message card', label: 'message card' },
      { value: 'cap', label: 'cap' },
      { value: 'bag', label: 'bag' },
      { value: 'car decor', label: 'car decor' },
      { value: 'candle', label: 'candle' },
      { value: 'wallet', label: 'wallet' },
      { value: 'watch', label: 'watch' },
      { value: 'clock', label: 'clock' },
      { value: 'sticker', label: 'sticker' },
      { value: 'phone case', label: 'phone case' },
    ],
    order: 4,
  },
  created: {
    id: 'created',
    label: 'Created',
    type: 'date-presets',
    required: false,
    default: '',
    presets: [
      { value: 'today', label: 'Today' },
      { value: '7d', label: 'Last 7 Days' },
      { value: '30d', label: 'Last 30 Days' },
      { value: '3m', label: 'Last 3 Months' },
      { value: '6m', label: 'Last 6 Months' },
    ],
    hasCustomRange: true,
    order: 5,
  },
  following: {
    id: 'following',
    label: 'Following',
    type: 'checkbox',
    required: false,
    default: false,
    order: 6,
  },
  reactionsMin: {
    id: 'reactionsMin',
    label: 'Reactions',
    type: 'number',
    min: 0,
    placeholder: 'Reactions',
    order: 7,
  },
  commentsMin: {
    id: 'commentsMin',
    label: 'Comments',
    type: 'number',
    min: 0,
    placeholder: 'Comments',
    order: 8,
  },
  sharesMin: {
    id: 'sharesMin',
    label: 'Shares',
    type: 'number',
    min: 0,
    placeholder: 'Shares',
    order: 9,
  },
  type: {
    id: 'type',
    label: 'Type',
    type: 'select',
    required: false,
    default: '',
    options: [
      { value: '', label: 'Type' },
      { value: 'image', label: 'Photo' },
      { value: 'video', label: 'Video' },
      { value: 'link', label: 'Link' },
    ],
    order: 10,
  },
  sort: {
    id: 'sort',
    label: 'Sort by',
    type: 'select',
    required: false,
    default: '',
    options: [
      { value: '', label: 'Latest' },
      { value: 'trending', label: 'Trending' },
      { value: 'created_time_desc', label: 'Newest' },
      { value: 'created_time_asc', label: 'Oldest' },
      { value: 'reactions', label: 'Reaction' },
      { value: 'comments', label: 'Comment' },
      { value: 'shares', label: 'Share' },
      { value: 'pe_today', label: 'Today Engagement' },
    ],
    order: 11,
  },
};

// ==================== ADS LIBRARY FILTERS ====================

const ADS_FILTERS = {
  keyword: {
    id: 'keyword',
    label: 'Keyword',
    type: 'text',
    placeholder: 'Enter keywords',
    required: true,
    order: 1,
  },
  pageId: {
    id: 'pageId',
    label: 'Page ID / Domain / Pixel',
    type: 'text',
    placeholder: 'Page id, domain, pixel',
    required: false,
    order: 2,
  },
  platforms: {
    id: 'platforms',
    label: 'Platform',
    type: 'multi-select',
    required: false,
    options: POSTS_FILTERS.platforms.options,
    order: 3,
  },
  categories: {
    id: 'categories',
    label: 'Category',
    type: 'multi-select',
    required: false,
    options: POSTS_FILTERS.categories.options,
    order: 4,
  },
  created: {
    id: 'created',
    label: 'Created',
    type: 'date-presets',
    required: false,
    default: '',
    presets: POSTS_FILTERS.created.presets,
    hasCustomRange: true,
    order: 5,
  },
  following: {
    id: 'following',
    label: 'Following',
    type: 'checkbox',
    required: false,
    default: false,
    order: 6,
  },
  adsetMin: {
    id: 'adsetMin',
    label: 'Adset number',
    type: 'number',
    min: 0,
    placeholder: 'Adset number',
    order: 7,
  },
  type: {
    id: 'type',
    label: 'Type',
    type: 'select',
    required: false,
    default: '',
    options: [
      { value: '', label: 'Type' },
      { value: 'image', label: 'Photo' },
      { value: 'video', label: 'Video' },
    ],
    order: 8,
  },
  status: {
    id: 'status',
    label: 'Status',
    type: 'select',
    required: false,
    default: '',
    options: [
      { value: '', label: 'Status' },
      { value: '1', label: 'Active' },
      { value: '0', label: 'Inactive' },
    ],
    order: 9,
  },
  sort: {
    id: 'sort',
    label: 'Sort by',
    type: 'select',
    required: false,
    default: '',
    options: [
      { value: '', label: 'Latest' },
      { value: 'created_time', label: 'Created Time' },
      { value: 'started_time', label: 'Started Time' },
      { value: 'ads_count', label: 'Total Adset' },
      { value: 'ads_today', label: 'Today Adset' },
    ],
    order: 10,
  },
};

// ==================== CARD DATA SCHEMAS ====================

const POSTS_CARD_SCHEMA = {
  pageName:   { label: 'Page Name',   selector: 'a.fw-500.text-primary',           type: 'text' },
  timeAgo:    { label: 'Time',        selector: 'a[title="Created time"]',          type: 'text' },
  isAd:       { label: 'Ad',          selector: '.bg-success',                       type: 'bool' },
  reactions:  { label: '👍 Reactions', selector: '.item-reactions div:nth-child(1)', type: 'number' },
  comments:   { label: '💬 Comments',  selector: '.item-reactions div:nth-child(2)', type: 'number' },
  shares:     { label: '🔄 Shares',    selector: '.item-reactions div:nth-child(3)', type: 'number' },
  domain:     { label: 'Domain',      selector: 'a[href*="redirect?type=ap"]:not([href*="G-"]):not([href*="GTM-"]):not([href*="AW-"]):not([href*="UA-"]):not([href*="GT-"])', type: 'text' },
  pageId:     { label: 'Page ID',     selector: 'a[href*="redirect?type=ap"] ~ a[href*="redirect?type=ap"]', type: 'text' },
  pixelId:    { label: 'Pixel ID',    selector: 'a[href*="redirect"][href*="G-"]',  type: 'text', optional: true },
  gtmId:      { label: 'GTM ID',      selector: 'a[href*="redirect"][href*="GTM-"]', type: 'text', optional: true },
  googleAdsId:{ label: 'Google Ads',  selector: 'a[href*="redirect"][href*="AW-"]', type: 'text', optional: true },
  imageUrl:   { label: 'Image',       selector: '.p-carousel-item-img',             type: 'background-image' },
};

const ADS_CARD_SCHEMA = {
  pageName:   { label: 'Page Name',   selector: 'a.fw-500.text-primary',           type: 'text' },
  timeAgo:    { label: 'Time',        selector: 'a[title="Created time"]',          type: 'text' },
  adCount:    { label: 'Ad Count',    selector: '',                                 type: 'text' }, // parsed from text
  adId:       { label: 'Ad ID',       selector: 'small',                            type: 'text' },
  domain:     { label: 'Domain',      selector: 'a[href*="redirect?type=aa"]:not([href*="AW-"]):not([href*="UA-"]):not([href*="GT-"])', type: 'text' },
  pageId:     { label: 'Page ID',     selector: 'a[href*="redirect?type=aa"]:nth-child(2)', type: 'text' },
  imageUrl:   { label: 'Image',       selector: '.p-carousel-item-img',             type: 'background-image' },
};

// ==================== DEFAULT VALUES ====================

const DEFAULT_POSTS_FILTERS = {
  keyword: '',
  pageId: '',
  platforms: [],
  categories: [],
  created: '',
  following: false,
  reactionsMin: 0,
  commentsMin: 0,
  sharesMin: 0,
  type: '',
  sort: '',
};

const DEFAULT_ADS_FILTERS = {
  keyword: '',
  pageId: '',
  platforms: [],
  categories: [],
  created: '',
  following: false,
  adsetMin: 0,
  type: '',
  status: '',
  sort: '',
};

// ==================== HELPERS ====================

function getFilterConfig(section) {
  return section === 'ads' ? ADS_FILTERS : POSTS_FILTERS;
}

function getDefaultFilters(section) {
  return section === 'ads'
    ? { ...DEFAULT_ADS_FILTERS }
    : { ...DEFAULT_POSTS_FILTERS };
}

function validateFilters(filters, section) {
  const errors = [];
  if (!filters.keyword?.trim()) errors.push('Keyword is required');
  if (filters.reactionsMin < 0) errors.push('Reactions min must be >= 0');
  if (filters.commentsMin < 0) errors.push('Comments min must be >= 0');
  if (filters.sharesMin < 0) errors.push('Shares min must be >= 0');
  if (section === 'ads' && filters.adsetMin < 0) errors.push('Adset number must be >= 0');
  return { valid: errors.length === 0, errors };
}

function getFiltersForUI(section) {
  const config = getFilterConfig(section);
  return Object.values(config).sort((a, b) => a.order - b.order);
}

module.exports = {
  POSTS_FILTERS,
  ADS_FILTERS,
  POSTS_CARD_SCHEMA,
  ADS_CARD_SCHEMA,
  DEFAULT_POSTS_FILTERS,
  DEFAULT_ADS_FILTERS,
  getFilterConfig,
  getDefaultFilters,
  validateFilters,
  getFiltersForUI,
};
