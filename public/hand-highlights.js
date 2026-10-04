(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandHighlights = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  var CATEGORY_CLASSES = Object.freeze({
    0: 'high-card',
    1: 'pair',
    2: 'two-pair',
    3: 'trips',
    4: 'straight',
    5: 'flush',
    6: 'full-house',
    7: 'quads',
    8: 'straight-flush'
  });
  var SUIT_LABELS = Object.freeze({ s: 'spade', h: 'heart', d: 'diamond', c: 'club' });
  var RANK_LABELS = Object.freeze({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' });

  function rankLabel(rank) { return RANK_LABELS[rank] || String(rank); }

  function validateCard(card, index) {
    if (!card || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14 ||
        !Object.prototype.hasOwnProperty.call(SUIT_LABELS, card.suit)) {
      throw new TypeError('Invalid card at index ' + index);
    }
  }

  function rankCounts(cards) {
    var counts = new Map();
    cards.forEach(function (card) { counts.set(card.rank, (counts.get(card.rank) || 0) + 1); });
    return counts;
  }

  function sequenceHigh(hand, cards) {
    var tiebreak = Array.isArray(hand.tiebreak) ? hand.tiebreak : [];
    if (Number.isInteger(tiebreak[0])) return tiebreak[0];
    var ranks = Array.from(new Set(cards.map(function (card) { return card.rank; }))).sort(function (a, b) { return b - a; });
    return ranks.join(',') === '14,5,4,3,2' ? 5 : ranks[0];
  }

  function roleFor(category, card, counts, cards, hand) {
    var frequency = counts.get(card.rank) || 0;
    var grouped = Array.from(counts.entries()).filter(function (entry) { return entry[1] >= 2; }).sort(function (a, b) { return b[0] - a[0]; });
    if (category === 8 || category === 5 || category === 4) {
      return { role: category === 8 ? 'sequence' : category === 5 ? 'flush' : 'sequence', primary: true, groupRank: sequenceHigh(hand, cards) };
    }
    if (category === 0) {
      var high = Math.max.apply(null, cards.map(function (item) { return item.rank; }));
      return { role: card.rank === high ? 'high-card' : 'kicker', primary: card.rank === high, groupRank: card.rank };
    }
    if (category === 1) {
      return frequency === 2 ? { role: 'pair', primary: true, groupRank: card.rank } : { role: 'kicker', primary: false, groupRank: card.rank };
    }
    if (category === 2) {
      var pairRanks = grouped.filter(function (entry) { return entry[1] === 2; }).map(function (entry) { return entry[0]; }).sort(function (a, b) { return b - a; });
      var pairIndex = pairRanks.indexOf(card.rank);
      if (pairIndex === 0) return { role: 'two-pair-high', primary: true, groupRank: card.rank };
      if (pairIndex === 1) return { role: 'two-pair-low', primary: true, groupRank: card.rank };
      return { role: 'kicker', primary: false, groupRank: card.rank };
    }
    if (category === 3) {
      return frequency === 3 ? { role: 'trips', primary: true, groupRank: card.rank } : { role: 'kicker', primary: false, groupRank: card.rank };
    }
    if (category === 6) {
      return frequency === 3 ? { role: 'full-house-trips', primary: true, groupRank: card.rank } : { role: 'full-house-pair', primary: true, groupRank: card.rank };
    }
    if (category === 7) {
      return frequency === 4 ? { role: 'quads', primary: true, groupRank: card.rank } : { role: 'kicker', primary: false, groupRank: card.rank };
    }
    throw new RangeError('Unsupported hand category: ' + category);
  }

  function getHighlights(hand) {
    if (!hand || !Number.isInteger(hand.category) || !Object.prototype.hasOwnProperty.call(CATEGORY_CLASSES, hand.category)) {
      throw new TypeError('Expected a hand with category 0–8');
    }
    if (!Array.isArray(hand.cards) || hand.cards.length !== 5) throw new TypeError('Expected exactly five hand cards');
    hand.cards.forEach(validateCard);
    var category = hand.category;
    var categoryClass = CATEGORY_CLASSES[category];
    var counts = rankCounts(hand.cards);
    var sequence = category === 4 || category === 8 ? sequenceHigh(hand, hand.cards) : 0;
    return hand.cards.map(function (card, index) {
      var role = roleFor(category, card, counts, hand.cards, hand);
      var meta = {
        category: category,
        categoryClass: categoryClass,
        role: role.role,
        rank: card.rank,
        rankLabel: rankLabel(card.rank),
        suit: card.suit,
        suitLabel: SUIT_LABELS[card.suit],
        index: index,
        groupRank: role.groupRank,
        sequenceHigh: sequence,
        primary: role.primary,
        kicker: !role.primary
      };
      return { card: { rank: card.rank, suit: card.suit }, class: categoryClass, meta: meta };
    });
  }

  return Object.freeze({ getHighlights: getHighlights, CATEGORY_CLASSES: CATEGORY_CLASSES });
});
