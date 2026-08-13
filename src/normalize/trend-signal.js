module.exports = function normalizeTrendSignal(raw, context) {
  const keyword = raw.keyword || raw.topic || context.query || '';
  
  return {
    uid: `${context.platform}:${keyword}:${new Date().toISOString().split('T')[0]}`,
    type: 'trend_signal',
    platform: context.platform,
    keyword: keyword,
    velocity: raw.velocity || raw.growthRate || 0,
    volume: raw.volume || raw.mentions || 0,
    sentiment: raw.sentiment || 'neutral',
    signalDate: raw.date || new Date().toISOString(),
    raw: raw
  };
};
