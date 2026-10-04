const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { evaluateFiveCards } = require('../src/poker');
const { getHighlights } = require('../public/hand-highlights');

const c = (rank, suit = 's') => ({ rank, suit });
const hand = cards => evaluateFiveCards(cards);
function roles(cards) { return getHighlights(hand(cards)).map(item => item.meta.role); }
function assertNoUndefined(value) {
  if (value === undefined || value === null) assert.fail('highlight contains an empty field');
  if (Array.isArray(value)) return value.forEach(assertNoUndefined);
  if (typeof value === 'object') return Object.values(value).forEach(assertNoUndefined);
}

test('returns five stable descriptors with complete metadata', () => {
  const result = getHighlights(hand([c(14, 's'), c(13, 'h'), c(10, 'd'), c(7, 'c'), c(2, 's')]));
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(item => item.class), ['high-card', 'high-card', 'high-card', 'high-card', 'high-card']);
  result.forEach(assertNoUndefined);
});

test('high card, pair, two pair, trips, full house, and quads identify groups', () => {
  assert.deepEqual(roles([c(14, 's'), c(13, 'h'), c(10, 'd'), c(7, 'c'), c(2, 's')]), ['high-card', 'kicker', 'kicker', 'kicker', 'kicker']);
  assert.deepEqual(roles([c(9, 's'), c(9, 'h'), c(14, 'd'), c(7, 'c'), c(2, 's')]), ['pair', 'pair', 'kicker', 'kicker', 'kicker']);
  assert.deepEqual(roles([c(14, 's'), c(14, 'h'), c(9, 'd'), c(9, 'c'), c(2, 's')]), ['two-pair-high', 'two-pair-high', 'two-pair-low', 'two-pair-low', 'kicker']);
  assert.deepEqual(roles([c(8, 's'), c(8, 'h'), c(8, 'd'), c(14, 'c'), c(2, 's')]), ['trips', 'trips', 'trips', 'kicker', 'kicker']);
  assert.deepEqual(roles([c(7, 's'), c(7, 'h'), c(7, 'd'), c(4, 'c'), c(4, 's')]), ['full-house-trips', 'full-house-trips', 'full-house-trips', 'full-house-pair', 'full-house-pair']);
  assert.deepEqual(roles([c(6, 's'), c(6, 'h'), c(6, 'd'), c(6, 'c'), c(14, 's')]), ['quads', 'quads', 'quads', 'quads', 'kicker']);
});

test('straight, flush, and both category 8 straight flush variants classify every card', () => {
  const straight = getHighlights(hand([c(14, 's'), c(5, 'h'), c(4, 'd'), c(3, 'c'), c(2, 's')]));
  assert.equal(straight[0].class, 'straight');
  assert.ok(straight.every(item => item.meta.role === 'sequence' && item.meta.sequenceHigh === 5));
  const flush = getHighlights(hand([c(14, 'h'), c(10, 'h'), c(7, 'h'), c(4, 'h'), c(2, 'h')]));
  assert.ok(flush.every(item => item.class === 'flush' && item.meta.role === 'flush'));
  const royal = getHighlights(hand([c(14, 's'), c(13, 's'), c(12, 's'), c(11, 's'), c(10, 's')]));
  const straightFlush = getHighlights(hand([c(9, 's'), c(8, 's'), c(7, 's'), c(6, 's'), c(5, 's')]));
  assert.ok(royal.every(item => item.class === 'straight-flush' && item.meta.sequenceHigh === 14));
  assert.ok(straightFlush.every(item => item.class === 'straight-flush' && item.meta.sequenceHigh === 9));
});

test('browser global exposes the same local API as CommonJS', () => {
  const context = vm.createContext({ window: {} });
  const source = fs.readFileSync(path.join(__dirname, '../public/hand-highlights.js'), 'utf8');
  vm.runInContext(source, context);
  assert.deepEqual(Object.keys(context.window.HandHighlights).sort(), ['CATEGORY_CLASSES', 'getHighlights']);
  const browserResult = context.window.HandHighlights.getHighlights(hand([c(11), c(11, 'h'), c(4, 'd'), c(3, 'c'), c(2, 's')]));
  assert.equal(browserResult.length, 5);
  assert.equal(browserResult[0].meta.role, 'pair');
});

test('invalid hand input is rejected without broken highlight data', () => {
  assert.throws(() => getHighlights(null), TypeError);
  assert.throws(() => getHighlights({ category: 9, cards: [] }), TypeError);
  assert.throws(() => getHighlights({ category: 1, cards: [c(2), c(2, 'h')] }), TypeError);
  assert.throws(() => getHighlights({ category: 1, cards: [c(2), c(2, 'h'), c(4), c(5), { rank: 20, suit: 's' }] }), TypeError);
});
