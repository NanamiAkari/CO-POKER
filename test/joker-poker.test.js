const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeck, evaluateFiveCards, compareHands, findBestHand } = require('../src/poker');

const c = (rank, suit) => ({ rank, suit });
const red = () => ({ joker: 'red' });
const black = () => ({ joker: 'black' });
const cardKey = card => `${card.rank}${card.suit}`;

function assertLegalResolvedHand(hand) {
  assert.equal(hand.cards.length, 5);
  assert.equal(new Set(hand.cards.map(cardKey)).size, 5);
  for (const card of hand.cards) {
    assert.ok(card.rank >= 2 && card.rank <= 14);
    if (card.joker === 'red') assert.ok(['d', 'h'].includes(card.suit));
    if (card.joker === 'black') assert.ok(['c', 's'].includes(card.suit));
  }
}

test('the optional deck adds exactly one physical red and one black joker', () => {
  assert.equal(createDeck().length, 52);
  assert.equal(createDeck({ includeJokers: false }).length, 52);
  const deck = createDeck({ includeJokers: true });
  assert.equal(deck.length, 54);
  assert.deepEqual(deck.filter(card => card.joker), [red(), black()]);
  assert.equal(new Set(deck.map(card => card.joker || cardKey(card))).size, 54);
  deck[52].joker = 'changed';
  assert.deepEqual(createDeck({ includeJokers: true })[52], red());
});

test('only a joker of the matching color can complete a royal flush', () => {
  for (const suit of ['d', 'h', 'c', 's']) {
    const natural = [10, 11, 12, 13].map(rank => c(rank, suit));
    const matching = ['d', 'h'].includes(suit) ? red() : black();
    const opposite = matching.joker === 'red' ? black() : red();
    const royal = evaluateFiveCards([...natural, matching]);
    assert.equal(royal.categoryName, '皇家同花顺');
    assert.deepEqual(royal.cards[4], { rank: 14, suit, joker: matching.joker });
    assert.equal(evaluateFiveCards([...natural, opposite]).category, 4);
    assertLegalResolvedHand(royal);
  }
});

test('a joker cannot copy either occupied suit of its own color', () => {
  const blackAces = [c(14, 'c'), c(14, 's'), c(9, 'h'), c(2, 'd')];
  assert.deepEqual(evaluateFiveCards([...blackAces, black()]).tiebreak, [14, 9, 2]);
  assert.equal(evaluateFiveCards([...blackAces, black()]).category, 2);
  assert.equal(evaluateFiveCards([...blackAces, red()]).category, 3);
  const redAces = [c(14, 'd'), c(14, 'h'), c(9, 's'), c(2, 'c')];
  assert.equal(evaluateFiveCards([...redAces, red()]).category, 2);
  assert.equal(evaluateFiveCards([...redAces, black()]).category, 3);
});

test('two jokers can complete four of a kind but never duplicate a card or create five of a kind', () => {
  const four = evaluateFiveCards([c(14, 'h'), c(14, 's'), c(13, 'h'), red(), black()]);
  assert.equal(four.category, 7);
  assert.deepEqual(four.tiebreak, [14, 13]);
  assertLegalResolvedHand(four);
  for (const joker of [red(), black()]) {
    const allAces = evaluateFiveCards(['c', 'd', 'h', 's'].map(suit => c(14, suit)).concat(joker));
    assert.equal(allAces.category, 7);
    assert.deepEqual(allAces.tiebreak, [14, 13]);
    assertLegalResolvedHand(allAces);
  }
});

test('jokers support ace-low straights, and opposite colors cannot form one flush', () => {
  const wheel = evaluateFiveCards([c(14, 's'), c(2, 'h'), c(3, 'd'), red(), black()]);
  assert.equal(wheel.category, 4);
  assert.deepEqual(wheel.tiebreak, [5]);
  assertLegalResolvedHand(wheel);
  const highStraight = evaluateFiveCards([c(10, 'h'), c(11, 'h'), c(12, 'h'), red(), black()]);
  assert.equal(highStraight.category, 4);
  assert.deepEqual(highStraight.tiebreak, [14]);
});

test('a shared board joker resolves independently for each player', () => {
  const joker = red();
  const board = [joker, c(10, 'h'), c(11, 'h'), c(2, 'c'), c(3, 'd')];
  const royal = findBestHand([c(12, 'h'), c(13, 'h')], board);
  const aces = findBestHand([c(14, 'c'), c(14, 's')], board);
  assert.equal(royal.category, 8);
  assert.equal(royal.cards.find(card => card.joker).suit, 'h');
  assert.equal(aces.category, 3);
  assert.equal(aces.cards.find(card => card.joker).suit, 'd');
  assert.deepEqual(joker, red());
});

test('any and all-hole modes honor physical joker inclusion with two or three hole cards', () => {
  const board = [c(10, 'h'), c(11, 'h'), c(12, 'h'), c(13, 'h'), c(14, 'h')];
  for (const hole of [[black(), c(2, 'c')], [black(), c(2, 'c'), c(2, 'd')]]) {
    const any = findBestHand(hole, board, 'any');
    assert.equal(any.category, 8);
    assert.equal(any.cards.some(card => card.joker), false);
    const all = findBestHand(hole, board, 'all-hole');
    assert.equal(all.category, hole.length === 2 ? 1 : 3);
    assert.equal(all.cards.filter(card => card.joker).length, 1);
    for (const physical of hole.filter(card => !card.joker)) assert.ok(all.cards.includes(physical));
    assertLegalResolvedHand(all);
  }
});

test('a wildcard may represent a card elsewhere in the pool but not in its selected five', () => {
  const hole = [red(), c(14, 's'), c(9, 's')];
  const board = [c(14, 'h'), c(14, 'c'), c(14, 'd'), c(4, 's'), c(2, 's')];
  const hand = findBestHand(hole, board, 'all-hole');
  assert.equal(hand.category, 7);
  assert.ok(board.some(card => cardKey(card) === cardKey(hand.cards.find(card => card.joker))));
  assertLegalResolvedHand(hand);
});

test('joker hands tie by normal poker ranks, and equivalent natural combinations are preferred', () => {
  const hearts = [10, 11, 12, 13].map(rank => c(rank, 'h'));
  const jokerRoyal = evaluateFiveCards([...hearts, red()]);
  const naturalRoyal = evaluateFiveCards([10, 11, 12, 13, 14].map(rank => c(rank, 's')));
  assert.equal(compareHands(jokerRoyal, naturalRoyal), 0);
  const best = findBestHand([black(), c(2, 'd')], naturalRoyal.cards);
  assert.equal(best.cards.filter(card => card.joker).length, 0);
});

test('joker evaluation is deterministic and leaves frozen physical inputs unchanged', () => {
  const hole = Object.freeze([Object.freeze(red()), Object.freeze(black()), Object.freeze(c(8, 'c'))]);
  const board = Object.freeze([c(14, 's'), c(13, 'h'), c(9, 'c'), c(6, 's'), c(2, 'd')].map(Object.freeze));
  const before = JSON.stringify({ hole, board });
  const first = findBestHand(hole, board);
  assert.deepEqual(findBestHand(hole, board), first);
  assert.equal(JSON.stringify({ hole, board }), before);
  assertLegalResolvedHand(first);
});

// Deliberately use all 26 legal card faces per joker as an independent oracle
// for the optimized rank-only search, including adversarial suit collisions.
test('optimized joker resolution agrees with exhaustive legal substitutions', () => {
  const examples = [
    [c(14, 's'), c(2, 'h'), c(3, 'd'), red(), black()],
    [c(14, 'h'), c(14, 's'), c(13, 'h'), red(), black()],
    [c(14, 'c'), c(14, 's'), c(9, 'h'), c(2, 'd'), black()],
    [c(10, 'h'), c(11, 'h'), c(12, 'h'), c(13, 'h'), red()],
    [c(10, 'h'), c(11, 'h'), c(12, 'h'), red(), black()],
    [c(14, 'd'), c(8, 'd'), c(6, 'd'), c(2, 'd'), red()],
    [c(6, 'c'), c(6, 'd'), c(6, 'h'), red(), black()],
    [c(14, 'h'), c(14, 'd'), c(14, 's'), red(), black()],
  ];
  const deck = createDeck();
  let seed = 2749;
  for (let sample = 0; sample < 32; sample += 1) {
    const natural = [];
    while (natural.length < 3) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const card = deck[seed % deck.length];
      if (!natural.includes(card)) natural.push(card);
    }
    examples.push([...natural, red(), black()]);
  }
  for (const physical of examples) {
    let expected;
    function visit(cards) {
      const index = cards.findIndex(card => card.joker);
      if (index === -1) {
        const evaluated = evaluateFiveCards(cards);
        if (!expected || compareHands(evaluated, expected) > 0) expected = evaluated;
        return;
      }
      const suits = cards[index].joker === 'red' ? ['d', 'h'] : ['c', 's'];
      for (const replacement of deck) {
        if (!suits.includes(replacement.suit)) continue;
        if (cards.some(card => !card.joker && cardKey(card) === cardKey(replacement))) continue;
        const candidate = cards.slice();
        candidate[index] = replacement;
        visit(candidate);
      }
    }
    visit(physical);
    const actual = evaluateFiveCards(physical);
    assert.equal(compareHands(actual, expected), 0, JSON.stringify(physical));
    assertLegalResolvedHand(actual);
  }
});

test('rejects unknown or duplicate physical jokers', () => {
  assert.throws(() => evaluateFiveCards([c(2, 'c'), c(3, 'h'), c(4, 's'), red(), red()]), /Duplicate joker/);
  assert.throws(() => evaluateFiveCards([c(2, 'c'), c(3, 'h'), c(4, 's'), c(5, 'd'), { joker: 'blue' }]), /Unknown joker/);
});
