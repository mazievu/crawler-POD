function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
  const match = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return 0;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(match[1]) * multiplier) || 0;
}

function parseDate(v) {
  if (!v) return new Date().toISOString();
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const { extractImage } = require('../image-utils');

module.exports = function normalizeSocialPost(raw, context = { platform: 'social_post' }) {
  const url = raw.url || raw.permalink || raw.link || raw.twitterUrl || (raw.id_str ? `https://x.com/i/web/status/${raw.id_str}` : (raw.id ? `https://x.com/i/web/status/${raw.id}` : '')) || '';
  const title = raw.title || raw.text || raw.full_text || raw.message || raw.message_rich || raw.caption || raw.description || '';
  
  let author = '';
  if (typeof raw.author === 'object' && raw.author) {
    author = raw.author.name || raw.author.username || raw.author.userName || raw.author.screen_name || raw.author.nickName || '';
  } else if (typeof raw.user === 'object' && raw.user) {
    author = raw.user.name || raw.user.screen_name || raw.user.username || '';
  } else {
    author = raw.author || raw.username || raw.userName || raw.screen_name || raw.pinnerUsername || raw.authorName || '';
  }

  // Bug found live (user report: "why can't I get images?"): the branches
  // below used to fall back to each PLATFORM's generic site favicon
  // (redditstatic.com, twimg.com icon, instagram favicon) whenever no real
  // post image was found — disguising "this post genuinely has no image"
  // (common for text-only Reddit posts) as if a real image had been
  // fetched. A favicon is not a post image; per this project's own
  // image-quality-gate rule (never a logo/favicon/placeholder), it must
  // never be assigned here. A missing author-avatar fallback is still a
  // real image and stays.
  let image = extractImage(raw);
  if (!image && context.platform !== 'twitter') {
    if (typeof raw.author === 'object' && raw.author?.profile_picture_url) {
      image = raw.author.profile_picture_url;
    } else if (typeof raw.author === 'object' && raw.author?.profilePicture) {
      image = raw.author.profilePicture;
    }
  }

  return {
    uid: `${context.platform}:${raw.id || raw.id_str || raw.post_id || url || title}`,
    type: 'social_post',
    platform: context.platform,
    author: String(author).substring(0, 100),
    title: String(title).substring(0, 200),
    body: raw.body || raw.content || raw.full_text || raw.text || raw.message_rich || raw.message || raw.caption || raw.selfText || '',
    url: url,
    image,
    likes: parseNum(raw.likes || raw.likeCount || raw.likesCount || raw.favorite_count || raw.favoriteCount || raw.favorites || raw.upvotes || raw.score || raw.reactions_count || raw.reactionCounts || raw.totalReactionCount || raw.reactions || raw.diggCount || 0),
    comments: parseNum(raw.comments || raw.commentCount || raw.commentsCount || raw.replyCount || raw.reply_count || raw.replies || raw.conversation_count || raw.num_comments || raw.numComments || raw.comments_count || 0),
    shares: parseNum(raw.shares || raw.shareCount || raw.sharesCount || raw.retweetCount || raw.retweet_count || raw.retweets || raw.repostCount || raw.reshare_count || raw.repin_count || raw.repinCount || raw.saves || 0),
    views: parseNum(raw.views || raw.viewCount || raw.viewsCount || raw.impressions || raw.impression_count || raw.view_count || raw.playCount || raw.video_view_count || 0),
    publishedAt: parseDate(raw.publishedAt || raw.createdAt || raw.created_at || raw.createTimeISO || raw.timestamp),
    raw: raw
  };
};
