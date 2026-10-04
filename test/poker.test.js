const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeck, evaluateFiveCards, compareHands, findBestHand, CoinTable } = require('../src/poker');

const c = (rank, suit = 's') => ({ rank, suit });

test('creates a standard 52-card deck', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(card => `${card.rank}${card.suit}`)).size, 52);
});

test('evaluates and compares standard poker hands', () => {
  assert.equal(evaluateFiveCards([c(14), c(13), c(12), c(11), c(10)]).categoryName, '皇家同花顺');
  assert.equal(evaluateFiveCards([c(14, 's'), c(5, 'h'), c(4, 'd'), c(3, 'c'), c(2, 's')]).categoryName, '顺子');
  const pair = evaluateFiveCards([c(14), c(14, 'h'), c(9), c(7), c(2)]);
  const twoPair = evaluateFiveCards([c(14), c(14, 'h'), c(9), c(9, 'h'), c(2)]);
  assert.equal(compareHands(twoPair, pair), 1);
});

test('finds the best hand in arbitrary and all-hole modes', () => {
  const hole = [c(14, 's'), c(13, 's')];
  const board = [c(12, 's'), c(11, 's'), c(10, 's'), c(2, 'd'), c(3, 'c')];
  assert.equal(findBestHand(hole, board, 'any').categoryName, '皇家同花顺');
  assert.equal(findBestHand(hole, board, 'all-hole').cards.length, 5);
  assert.equal(findBestHand(hole, board, 'all-hole').cards.filter(card => hole.includes(card)).length, 2);
});

test('supports coin pickup, stealing, return, and completion', () => {
  const table = new CoinTable(['a', 'b', 'c']);
  table.move(1, 'a');
  table.move(1, 'b', 'a');
  table.move(2, 'a');
  table.move(3, 'c');
  assert.equal(table.isComplete(), true);
  table.returnCoin(2, 'a');
  assert.equal(table.isComplete(), false);
});

test('prevents a player from replacing a coin by clicking the public coin area', () => {
  const table = new CoinTable(['a', 'b']);
  table.move(1, 'a');
  assert.throws(() => table.move(2, 'a'), /already owns/);
});
