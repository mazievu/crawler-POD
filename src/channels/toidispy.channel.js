const { CHANNEL_STATUS, BACKEND_KIND } = require('./schema');

module.exports = {
  name: 'toidispy',
  displayName: 'Toidispy',
  description: 'Facebook Ads Library via CDP (free, requires login)',
  queryType: 'keyword',
  icon: '🔍',
  color: '#00d4aa',

  intelligenceTypes: ["ad_creative"],

  availability: {
    status: CHANNEL_STATUS.READY,
    zeroConfig: true,
    requiresAuth: [],
    requiresLoginSession: true,
    paid: false,
    countrySupport: false,
    lastVerifiedAt: '2026-06-24'
  },

  risk: {
    tosRisk: 'medium',
    blockRisk: 'medium',
    dataReliability: 'medium'
  },

  backends: [
    
    {
      name: 'cdp',
      kind: BACKEND_KIND.CDP,
      priority: 20,
      enabled: true
    }
  ],

  normalizer: 'ad_creative'
};
