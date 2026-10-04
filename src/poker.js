const SUITS = ['c', 'd', 'h', 's'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function createDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ suit, rank })));
}

function shuffle(deck, random = Math.random) {
  const result = deck.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function combinations(cards, size) {
  const result = [];
  function visit(start, picked) {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let i = start; i <= cards.length - (size - picked.length); i += 1) {
      picked.push(cards[i]);
      visit(i + 1, picked);
      picked.pop();
    }
  }
  visit(0, []);
  return result;
}

function evaluateFiveCards(cards) {
  if (cards.length !== 5) throw new Error('Exactly five cards are required');
  const counts = new Map();
  cards.forEach(card => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ranks = cards.map(card => card.rank).sort((a, b) => b - a);
  const unique = [...new Set(ranks)];
  let straightHigh = null;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique.join(',') === '14,5,4,3,2') straightHigh = 5;
  }
  const flush = cards.every(card => card.suit === cards[0].suit);
  let category;
  let tiebreak;
  if (straightHigh && flush) [category, tiebreak] = [8, [straightHigh]];
  else if (groups[0][1] === 4) [category, tiebreak] = [7, [groups[0][0], groups[1][0]]];
  else if (groups[0][1] === 3 && groups[1][1] === 2) [category, tiebreak] = [6, [groups[0][0], groups[1][0]]];
  else if (flush) [category, tiebreak] = [5, ranks];
  else if (straightHigh) [category, tiebreak] = [4, [straightHigh]];
  else if (groups[0][1] === 3) [category, tiebreak] = [3, [groups[0][0], ...groups.slice(1).map(group => group[0]).sort((a, b) => b - a)]];
  else if (groups[0][1] === 2 && groups[1][1] === 2) [category, tiebreak] = [2, [Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]]];
  else if (groups[0][1] === 2) [category, tiebreak] = [1, [groups[0][0], ...groups.slice(1).map(group => group[0]).sort((a, b) => b - a)]];
  else [category, tiebreak] = [0, ranks];
  const categoryName = category === 8 && tiebreak[0] === 14 ? '皇家同花顺' : CATEGORY_NAMES[category];
  return { category, categoryName, tiebreak, cards: cards.slice() };
}

function compareHands(a, b) {
  if (a.category !== b.category) return Math.sign(a.category - b.category);
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i += 1) {
    if ((a.tiebreak[i] || 0) !== (b.tiebreak[i] || 0)) return Math.sign((a.tiebreak[i] || 0) - (b.tiebreak[i] || 0));
  }
  return 0;
}

function findBestHand(holeCards, communityCards, handUsageRule = 'any') {
  const available = holeCards.concat(communityCards);
  const candidates = handUsageRule === 'all-hole'
    ? combinations(communityCards, 5 - holeCards.length).map(extra => holeCards.concat(extra))
    : combinations(available, 5);
  if (!candidates.length) throw new Error('Not enough cards to form a hand');
  return candidates.map(evaluateFiveCards).reduce((best, current) => compareHands(current, best) > 0 ? current : best);
}

class CoinTable {
  constructor(playerIds) {
    this.area = new Set(playerIds.map((_, index) => index + 1));
    this.owners = new Map();
    this.playerIds = new Set(playerIds);
  }

  move(coin, toPlayer, fromPlayer = null) {
    if (!this.playerIds.has(toPlayer)) throw new Error('Unknown target player');
    if (this.owners.has(coin) && this.owners.get(coin) === toPlayer) return;
    const existing = [...this.owners.entries()].find(([, owner]) => owner === toPlayer);
    if (existing && !this.owners.has(coin)) throw new Error('Player already owns a coin');
    if (existing) this.returnCoin(existing[0], toPlayer);
    if (this.owners.has(coin)) {
      if (fromPlayer && this.owners.get(coin) !== fromPlayer) throw new Error('Invalid source player');
      this.owners.delete(coin);
    } else if (!this.area.delete(coin)) throw new Error('Coin is not available');
    this.owners.set(coin, toPlayer);
  }

  returnCoin(coin, player) {
    if (this.owners.get(coin) !== player) throw new Error('Player does not own this coin');
    this.owners.delete(coin);
    this.area.add(coin);
  }

  isComplete() { return this.area.size === 0 && this.owners.size === this.playerIds.size; }
}

module.exports = { createDeck, shuffle, evaluateFiveCards, compareHands, findBestHand, CoinTable, CATEGORY_NAMES };
