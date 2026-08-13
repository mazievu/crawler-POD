function parseNum(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

const { extractImage } = require('../image-utils');

module.exports = function normalizeSocialPost(raw, context) {
  const url = raw.url || raw.permalink || raw.link || '';
  const title = raw.title || raw.text || raw.message || raw.description || '';
  const author = typeof raw.author === 'object' ? raw.author?.name : (raw.author || raw.username || '');
  
  const image = extractImage(raw);
  
  return {
    uid: `${context.platform}:${url || title}`,
    type: 'social_post',
    platform: context.platform,
    author: String(author).substring(0, 100),
    title: String(title).substring(0, 200),
    body: raw.body || raw.content || raw.message_rich || '',
    url: url,
    image,
    likes: parseNum(raw.likes || raw.likeCount || raw.upvotes || raw.reactions_count || 0),
    comments: parseNum(raw.comments || raw.commentCount || raw.num_comments || raw.comments_count || 0),
    shares: parseNum(raw.shares || raw.shareCount || raw.retweetCount || raw.reshare_count || 0),
    views: parseNum(raw.views || raw.viewCount || raw.video_view_count || 0),
    publishedAt: raw.publishedAt || raw.createdAt || (raw.timestamp ? new Date(raw.timestamp * 1000).toISOString() : new Date().toISOString()),
    raw: raw
  };
};
