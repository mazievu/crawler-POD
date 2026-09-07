const test = require('node:test');
const assert = require('node:assert/strict');
const { ProductRanker } = require('../src/ranking/product-ranker');

test('ProductRanker without explicit business weights reports isProvisional=true (P1-1)', () => {
  const ranker = new ProductRanker({}, { silenceProvisionalWarning: true });
  assert.equal(ranker.getStatus().isProvisional, true);

  const businessRanker = new ProductRanker({}, { businessWeights: { soldWeight: 5 }, silenceProvisionalWarning: true });
  assert.equal(businessRanker.getStatus().isProvisional, false);
  assert.equal(businessRanker.getWeights().soldWeight, 5);

  const explicitCtorRanker = new ProductRanker({ likesWeight: 1 });
  assert.equal(explicitCtorRanker.getStatus().isProvisional, false);
});

test('ProductRanker calculates default rank scores accurately', () => {
  const ranker = new ProductRanker();
  const item = {
    delta_sold: 50,
    delta_likes: 200,
    delta_comments: 30,
    delta_shares: 10,
    delta_views: 5000,
    current_rating: 4.8,
    delta_24h_views: 1000
  };

  const score = ranker.calculateRankScore(item);
  assert.ok(score > 0, 'Rank score should be positive');

  // Higher sold and engagement yields higher rank
  const lowerItem = { delta_sold: 5, delta_likes: 10, current_rating: 3.5 };
  const lowerScore = ranker.calculateRankScore(lowerItem);
  assert.ok(score > lowerScore, 'Higher engagement item must have higher rank score');
});

test('ProductRanker supports customizable weight matrices', () => {
  const ranker = new ProductRanker({ soldWeight: 10.0, likesWeight: 0.1 });
  const soldHeavy = { delta_sold: 100, delta_likes: 0 };
  const likesHeavy = { delta_sold: 0, delta_likes: 1000 };

  const scoreSold = ranker.calculateRankScore(soldHeavy);
  const scoreLikes = ranker.calculateRankScore(likesHeavy);

  assert.ok(scoreSold > scoreLikes, 'Under sold-weighted profile, soldHeavy must rank higher');
});

test('ProductRanker ranks lists of items in descending score order', () => {
  const ranker = new ProductRanker();
  const list = [
    { title: 'Low', delta_sold: 1, delta_likes: 5 },
    { title: 'High', delta_sold: 100, delta_likes: 500 },
    { title: 'Medium', delta_sold: 20, delta_likes: 50 }
  ];

  const ranked = ranker.rankList(list);
  assert.equal(ranked[0].title, 'High');
  assert.equal(ranked[1].title, 'Medium');
  assert.equal(ranked[2].title, 'Low');
});
