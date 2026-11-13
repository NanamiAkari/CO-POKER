const { findBestHand, compareHands, createDeck } = require('./poker');

// Seven names are enough for a host plus seven bots. Names are the only
// visible distinction, so they are also the bot player ids.
const BOT_NAMES = Object.freeze([
  'Robot Jack',
  'Robot Sam',
  'Robot Daniel',
  'Robot Mike',
  'Robot Alex',
  'Robot Chris',
  'Robot Ben'
]);

const COIN_PHASES = new Set(['ROUND_1_COINS', 'ROUND_2_COINS', 'ROUND_3_COINS', 'ROUND_4_COINS']);
const COIN_PHASE_ORDER = ['ROUND_1_COINS', 'ROUND_2_COINS', 'ROUND_3_COINS', 'ROUND_4_COINS'];
const REMATCH_PHASES = new Set(['SETTLEMENT', 'GAME_OVER']);
const PHASE_BOARD_LENGTHS = Object.freeze({
  ROUND_1_COINS: 0,
  ROUND_2_COINS: 3,
  ROUND_3_COINS: 4,
  ROUND_4_COINS: 5
});
const CATEGORY_STRENGTH = [0.08, 0.38, 0.62, 0.76, 0.84, 0.9, 0.95, 0.98, 1];
const BOT_STRATEGY = Object.freeze({
  effectThreshold: 0.05,
  rangeCandidates: 192,
  rangeCandidatesThree: 128,
  rangeCandidatesJoker: 96,
  rangePriorBlend: 0.15,
  rangeSigma: 1.5,
  fieldSamples: 480,
  jokerSamples: 240,
  defenderSamples: 240,
  grabRetryBase: 0.55,
  grabRetryDecay: 0.5,
  maxGrabRetries: 2,
  changeWaitMs: 900,
  changeWaitMaxMs: 2400,
  coinActionGapMs: 500
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cardRank(card) {
  if (!card || card.joker) return 15;
  return card.rank || 2;
}

function cardKey(card) {
  if (!card) return '';
  if (card.joker) return `joker:${card.joker}`;
  return `${card.rank}/${card.suit}`;
}

function handKey(cards) {
  return cards.map(cardKey).sort().join('|');
}

// Keep the existing two-card heuristic exactly as it was. Three-card games add
// a small third-card contribution; jokers get a modest wildcard bonus.
function preflopStrength(holeCards = []) {
  const ranks = holeCards.map(cardRank).sort((a, b) => b - a);
  if (!ranks.length) return 0.5;
  const high = ((ranks[0] || 2) + (ranks[1] || 2)) / 28;
  const pair = ranks.length >= 2 && ranks[0] === ranks[1];
  const suited = holeCards.length >= 2 && holeCards[0]?.suit && holeCards[0].suit === holeCards[1].suit;
  const connected = ranks.length >= 2 && Math.abs(ranks[0] - ranks[1]) <= 1;
  let strength = pair ? 0.7 + high * 0.2 : 0.15 + high * 0.45 + (suited ? 0.04 : 0) + (connected ? 0.03 : 0);
  if (ranks.length >= 3) {
    strength += ((ranks[2] || 2) / 14) * 0.08;
    if (ranks[0] === ranks[2]) strength += 0.1;
    else if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) strength += 0.05;
    const suits = new Set(holeCards.map(card => card.suit).filter(Boolean));
    if (suits.size === 1) strength += 0.06;
    else if (suits.size === 2) strength += 0.02;
  }
  const jokers = holeCards.filter(card => card.joker).length;
  if (jokers) strength += jokers * 0.05;
  return clamp(strength, 0, 1);
}

function estimateStrength(game, player) {
  const holeCards = player?.holeCards || [];
  const communityCards = game?.communityCards || [];
  const cards = holeCards.concat(communityCards);
  if (cards.length >= 5) {
    const hand = findBestHand(holeCards, communityCards, game.handUsageRule);
    const category = CATEGORY_STRENGTH[hand.category] ?? 0;
    const kicker = (hand.tiebreak?.[0] || 2) / 14;
    return Math.min(1, Math.max(0, category + kicker * 0.06));
  }
  return preflopStrength(holeCards);
}

function targetCoinFromStrength(strength, count) {
  if (!Number.isInteger(count) || count <= 1) return 1;
  const target = Math.round(1 + (1 - clamp(strength, 0, 1)) * (count - 1));
  return clamp(target, 1, count);
}

function coinStrength(coin, count) {
  if (!Number.isInteger(count) || count <= 1) return 1;
  return clamp(1 - (coin - 1) / (count - 1), 0, 1);
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(seedText) {
  return mulberry32(hashString(seedText));
}

function boardKey(board = []) {
  return board.length ? board.map(cardKey).join('|') : 'preflop';
}

function deckWithout(holeCards = [], board = [], includeJokers = false) {
  const known = new Set(holeCards.concat(board).map(cardKey));
  return createDeck({ includeJokers }).filter(card => !known.has(cardKey(card)));
}

function combinations(cards, size, limit = Infinity) {
  const result = [];
  function visit(start, picked) {
    if (result.length >= limit) return;
    if (picked.length === size) { result.push(picked.slice()); return; }
    for (let index = start; index <= cards.length - (size - picked.length); index += 1) {
      picked.push(cards[index]);
      visit(index + 1, picked);
      picked.pop();
    }
  }
  visit(0, []);
  return result;
}

function sampleHoleHands(rest, size, count, random, existing = new Set()) {
  const result = [];
  if (!Array.isArray(rest) || rest.length < size || count <= 0) return result;
  const seen = new Set(existing);
  const maxAttempts = Math.max(200, count * 30);
  let attempts = 0;
  while (result.length < count && attempts < maxAttempts) {
    attempts += 1;
    const picked = [];
    const used = new Set();
    while (picked.length < size && used.size < rest.length) {
      const index = Math.floor(random() * rest.length);
      if (used.has(index)) continue;
      used.add(index);
      picked.push(rest[index]);
    }
    if (picked.length !== size) break;
    const key = handKey(picked);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(picked);
  }
  return result;
}

function summarizeHand(holeCards, board, handUsageRule) {
  const hand = findBestHand(holeCards, board, handUsageRule);
  return { category: hand.category, tiebreak: hand.tiebreak.slice() };
}

function handSnapshot(holeCards, board, handUsageRule) {
  if (!board.length) return { kind: 'preflop', value: preflopStrength(holeCards) };
  return { kind: 'made', value: summarizeHand(holeCards, board, handUsageRule) };
}

function compareSnapshots(left, right) {
  if (!left || !right) return 0;
  if (left.kind === 'preflop' && right.kind === 'preflop') {
    return Math.sign((left.value || 0) - (right.value || 0));
  }
  if (left.kind === 'made' && right.kind === 'made') return compareHands(left.value, right.value);
  const leftScore = left.kind === 'preflop' ? left.value : (CATEGORY_STRENGTH[left.value.category] || 0);
  const rightScore = right.kind === 'preflop' ? right.value : (CATEGORY_STRENGTH[right.value.category] || 0);
  return Math.sign(leftScore - rightScore);
}

function sortDistribution(distribution) {
  if (!distribution?.values?.length) return distribution;
  if (distribution.kind === 'preflop') distribution.values.sort((a, b) => a - b);
  else distribution.values.sort((a, b) => compareHands(a, b));
  return distribution;
}

function lowerBound(values, target, compare) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare(values[middle], target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(values, target, compare) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compare(values[middle], target) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function percentileOf(distribution, handOrValue) {
  const values = distribution?.values || [];
  if (!values.length) return 0.5;
  if (distribution.kind === 'preflop') {
    const value = typeof handOrValue === 'number' ? handOrValue : handOrValue?.value ?? 0;
    const compare = (left, right) => left - right;
    const lower = lowerBound(values, value, compare);
    const upper = upperBound(values, value, compare);
    return (lower + (upper - lower) / 2) / values.length;
  }
  const hand = handOrValue?.kind === 'made' ? handOrValue.value : handOrValue;
  if (!hand || !Number.isInteger(hand.category)) return 0.5;
  const compare = (left, right) => compareHands(left, right);
  const lower = lowerBound(values, hand, compare);
  const upper = upperBound(values, hand, compare);
  return (lower + (upper - lower) / 2) / values.length;
}

function rangeCandidateCount(handCardCount, includeJokers, strategy = BOT_STRATEGY) {
  if (includeJokers) return strategy.rangeCandidatesJoker;
  if (handCardCount === 3) return strategy.rangeCandidatesThree;
  return strategy.rangeCandidates;
}

function buildFieldDistribution({ holeCards, board, handCardCount, handUsageRule, includeJokers, strategy = BOT_STRATEGY }) {
  const rest = deckWithout(holeCards, board, includeJokers);
  const sampleCount = includeJokers ? strategy.jokerSamples : strategy.fieldSamples;
  const exact = handCardCount === 2 && !includeJokers;
  const hands = exact
    ? combinations(rest, handCardCount)
    : sampleHoleHands(rest, handCardCount, sampleCount, seededRandom(`${handKey(holeCards)}|${boardKey(board)}|${handCardCount}|${includeJokers}`));
  const values = hands.map(hand => board.length ? summarizeHand(hand, board, handUsageRule) : preflopStrength(hand));
  return sortDistribution({
    kind: board.length ? 'made' : 'preflop',
    values,
    boardLength: board.length
  });
}

function rangePoolFor({ holeCards, board = [], handCardCount, includeJokers, strategy = BOT_STRATEGY, seed = '' }) {
  const count = rangeCandidateCount(handCardCount, includeJokers, strategy);
  const rest = deckWithout(holeCards, board, includeJokers);
  const random = seededRandom(`${seed}|${handKey(holeCards)}|${boardKey(board)}|${handCardCount}|${includeJokers}`);
  return sampleHoleHands(rest, handCardCount, count, random);
}

function normalizeWeights(weights) {
  const length = weights?.length || 0;
  if (!length) return [];
  const sum = weights.reduce((total, value) => total + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  if (!(sum > 0)) return new Array(length).fill(1 / length);
  return weights.map(value => (Number.isFinite(value) && value > 0 ? value : 0) / sum);
}

function blendWeights(weights, blend = 0.15) {
  const normalized = normalizeWeights(weights);
  if (!normalized.length) return normalized;
  const uniform = 1 / normalized.length;
  return normalized.map(value => (1 - blend) * value + blend * uniform);
}

function bestFreeCoin(target, freeCoins, random = Math.random) {
  const free = [...freeCoins].sort((a, b) => a - b);
  if (!free.length) return null;
  if (!Number.isInteger(target)) return free[0];
  const distance = coin => Math.abs(coin - target);
  const best = Math.min(...free.map(distance));
  const closest = free.filter(coin => distance(coin) === best);
  return closest[Math.floor(random() * closest.length)] ?? closest[0];
}

// Compatibility helper retained for existing callers/tests. It intentionally
// only considers public-area coins.
function chooseBotCoin(game, bot, random = Math.random) {
  const free = [...game.coinTable.area];
  if (!free.length) return null;
  const strength = estimateStrength(game, bot);
  return bestFreeCoin(targetCoinFromStrength(strength, game.players.length), free, random);
}

function chooseTargetCoin(game, bot) {
  return targetCoinFromStrength(estimateStrength(game, bot), game.players.length);
}

function contestProbability(strength, takenCoin, backupCoin, count) {
  const taken = coinStrength(takenCoin, count);
  const backup = coinStrength(backupCoin, count);
  if (!(taken > backup)) return 0;
  return clamp((clamp(strength, 0, 1) - backup) / (taken - backup), 0, 1);
}

function grabRetryProbability(failures, strategy = BOT_STRATEGY) {
  const attempt = Math.max(1, Number(failures) || 1);
  return clamp(strategy.grabRetryBase * Math.pow(strategy.grabRetryDecay, attempt - 1), 0, 0.85);
}

function maxCoinActions(playerCount) {
  return Math.max(6, Math.min(12, 2 * playerCount));
}

function previousBoardLengthForPhase(phase) {
  const index = COIN_PHASE_ORDER.indexOf(phase);
  if (index <= 1) return 0;
  return PHASE_BOARD_LENGTHS[COIN_PHASE_ORDER[index - 1]] ?? 0;
}

function currentRoundBoardLength(game) {
  return PHASE_BOARD_LENGTHS[game.phase] ?? game.communityCards.length;
}

class BotBrain {
  constructor(botId, strategy = {}) {
    this.botId = botId;
    this.strategy = { ...BOT_STRATEGY, ...strategy };
    this.dealStartSequence = null;
    this.lastReplaySequence = 0;
    this.lastReplayIndex = -1;
    this.pendingMoves = [];
    this.pool = [];
    this.poolVersion = 0;
    this.poolSize = 0;
    this.weights = new Map();
    this.lastFinalCoin = new Map();
    this.distributions = new Map();
    this.ownSnapshots = new Map();
    this.candidateSnapshots = new Map();
    this.phase = null;
    this.planReady = false;
    this.mode = null;
    this.target = null;
    this.preferredCoin = null;
    this.previousCoin = null;
    this.fieldBefore = 0.5;
    this.fieldAfter = 0.5;
    this.improved = false;
    this.observedCoin = null;
    this.lastHeldCoin = null;
    this.pendingTheft = null;
    this.lastSteal = null;
    this.failuresByCoin = new Map();
    this.actionCount = 0;
    this.round1Contests = 0;
    this.round1Backup = null;
    this.round1Failed = false;
    this.roundStartedAt = 0;
    this.rangeFilteredBoardLength = 0;
  }

  resetDeal(game, bot, startSequence = 0, startIndex = -1) {
    this.dealStartSequence = startSequence;
    this.lastReplaySequence = startSequence;
    this.lastReplayIndex = startIndex;
    this.pendingMoves = [];
    this.pool = [];
    this.poolVersion += 1;
    this.poolSize = 0;
    this.weights = new Map();
    this.lastFinalCoin = new Map();
    this.distributions.clear();
    this.ownSnapshots.clear();
    this.candidateSnapshots.clear();
    this.phase = null;
    this.planReady = false;
    this.mode = null;
    this.target = null;
    this.preferredCoin = null;
    this.previousCoin = null;
    this.observedCoin = bot?.currentCoin ?? null;
    this.lastHeldCoin = null;
    this.pendingTheft = null;
    this.lastSteal = null;
    this.failuresByCoin.clear();
    this.actionCount = 0;
    this.round1Contests = 0;
    this.round1Backup = null;
    this.round1Failed = false;
    this.roundStartedAt = 0;
    this.rangeFilteredBoardLength = 0;
    this.ensurePool(game, bot);
  }

  ensurePool(game, bot) {
    if (!game || !bot || this.pool.length) return this.pool.length;
    const handCardCount = game.handCardCount || 2;
    this.poolSize = rangeCandidateCount(handCardCount, Boolean(game.includeJokers), this.strategy);
    this.pool = rangePoolFor({
      holeCards: bot.holeCards,
      board: game.communityCards,
      handCardCount,
      includeJokers: Boolean(game.includeJokers),
      strategy: this.strategy,
      seed: `${this.botId}|${handKey(bot.holeCards)}|${handCardCount}|deal`
    });
    this.poolVersion += 1;
    this.rangeFilteredBoardLength = game.communityCards.length;
    const opponents = game.players.filter(player => player.id !== bot.id);
    for (const opponent of opponents) {
      if (!this.weights.has(opponent.id)) {
        this.weights.set(opponent.id, normalizeWeights(new Array(this.pool.length).fill(1)));
      }
    }
    return this.pool.length;
  }

  observeReplay(game, bot) {
    this.ensurePool(game, bot);
    const events = Array.isArray(game.replayEvents) ? game.replayEvents : (typeof game.getReplay === 'function' ? game.getReplay() : []);
    let latestStartIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'GAME_STARTED') { latestStartIndex = index; break; }
    }
    if (latestStartIndex >= 0) {
      const latestStart = events[latestStartIndex];
      if (latestStart.sequence !== this.dealStartSequence) {
        this.resetDeal(game, bot, latestStart.sequence, latestStartIndex);
      }
    }
    for (let index = Math.max(0, this.lastReplayIndex + 1); index < events.length; index += 1) {
      const event = events[index];
      if (event.sequence <= this.lastReplaySequence) continue;
      if (event.type === 'COIN_MOVED') this.pendingMoves.push({ type: 'moved', ...event.payload });
      else if (event.type === 'COIN_RETURNED') this.pendingMoves.push({ type: 'returned', ...event.payload });
      else if (event.type === 'ROUND_COMPLETED') {
        const phase = event.payload?.phase;
        if (phase && phase !== 'ROUND_4_COINS') {
          this.updateRangeWeights(game, bot, phase, event.payload.coinHistory || [], this.pendingMoves);
        }
        this.pendingMoves = [];
      }
      this.lastReplaySequence = event.sequence;
    }
    this.lastReplayIndex = events.length - 1;
  }

  observeState(game, bot, now = Date.now()) {
    if (!game || !bot) return;
    this.observeReplay(game, bot);
    if (this.phase !== game.phase) {
      this.phase = game.phase;
      this.planReady = false;
      this.mode = null;
      this.target = null;
      this.preferredCoin = null;
      this.observedCoin = bot.currentCoin;
      this.lastHeldCoin = null;
      this.pendingTheft = null;
      this.lastSteal = null;
      this.failuresByCoin.clear();
      this.actionCount = 0;
      this.round1Contests = 0;
      this.round1Backup = null;
      this.round1Failed = false;
      this.roundStartedAt = now;
      return;
    }
    const current = bot.currentCoin;
    if (this.observedCoin !== null && current === null) {
      if (!this.pendingTheft) this.pendingTheft = { coin: this.observedCoin };
    }
    if (current !== null) this.lastHeldCoin = current;
    this.observedCoin = current;
  }

  getDistribution(game, bot, board) {
    const key = boardKey(board);
    if (this.distributions.has(key)) return this.distributions.get(key);
    const distribution = buildFieldDistribution({
      holeCards: bot.holeCards,
      board,
      handCardCount: game.handCardCount,
      handUsageRule: game.handUsageRule,
      includeJokers: Boolean(game.includeJokers),
      strategy: this.strategy
    });
    this.distributions.set(key, distribution);
    return distribution;
  }

  getOwnSnapshot(game, bot, board) {
    const key = boardKey(board);
    if (this.ownSnapshots.has(key)) return this.ownSnapshots.get(key);
    const snapshot = handSnapshot(bot.holeCards, board, game.handUsageRule);
    this.ownSnapshots.set(key, snapshot);
    return snapshot;
  }

  getCandidateSnapshots(game, board) {
    const key = `${boardKey(board)}:${this.poolVersion}`;
    if (this.candidateSnapshots.has(key)) return this.candidateSnapshots.get(key);
    const snapshots = this.pool.map(hand => handSnapshot(hand, board, game.handUsageRule));
    this.candidateSnapshots.set(key, snapshots);
    return snapshots;
  }

  fieldScore(game, bot, board) {
    const own = this.getOwnSnapshot(game, bot, board);
    const snapshots = this.getCandidateSnapshots(game, board);
    let total = 0;
    let opponents = 0;
    for (const opponent of game.players) {
      if (opponent.id === bot.id) continue;
      const weights = this.weights.get(opponent.id);
      if (!weights?.length || !snapshots.length) continue;
      const normalized = normalizeWeights(weights);
      let win = 0;
      for (let index = 0; index < snapshots.length; index += 1) {
        const comparison = compareSnapshots(own, snapshots[index]);
        if (comparison > 0) win += normalized[index] || 0;
        else if (comparison === 0) win += (normalized[index] || 0) * 0.5;
      }
      total += win;
      opponents += 1;
    }
    return opponents ? total / opponents : 0.5;
  }

  filterPoolForBoard(game, bot, board) {
    if (!this.pool.length) return;
    const boardCards = new Set(board.map(cardKey));
    const kept = [];
    const keptIndexes = [];
    this.pool.forEach((candidate, index) => {
      if (candidate.some(card => boardCards.has(cardKey(card)))) return;
      kept.push(candidate);
      keptIndexes.push(index);
    });
    const handCardCount = game.handCardCount || 2;
    const targetCount = this.poolSize || rangeCandidateCount(handCardCount, Boolean(game.includeJokers), this.strategy);
    const existing = new Set(kept.map(handKey));
    const rest = deckWithout(bot.holeCards, board, Boolean(game.includeJokers));
    const additions = sampleHoleHands(
      rest,
      handCardCount,
      Math.max(0, targetCount - kept.length),
      seededRandom(`${this.botId}|${boardKey(board)}|${this.poolVersion}|topup`),
      existing
    );
    const nextPool = kept.concat(additions);
    const oldWeights = this.weights;
    const nextWeights = new Map();
    for (const [playerId, weights] of oldWeights) {
      const keptWeights = keptIndexes.map(index => weights[index] ?? 0);
      const mean = keptWeights.length ? keptWeights.reduce((sum, value) => sum + value, 0) / keptWeights.length : 1 / Math.max(1, nextPool.length);
      const additionsWeights = additions.map(() => Math.max(mean * 0.5, 1 / Math.max(1, nextPool.length) * this.strategy.rangePriorBlend));
      nextWeights.set(playerId, blendWeights(keptWeights.concat(additionsWeights), this.strategy.rangePriorBlend));
    }
    this.pool = nextPool;
    this.poolVersion += 1;
    this.weights = nextWeights;
    this.candidateSnapshots.clear();
    this.rangeFilteredBoardLength = board.length;
  }

  updateRangeWeights(game, bot, phase, coinHistory, moves) {
    const finalCoins = new Map((coinHistory || []).map(item => [item.playerId, item.coin]));
    const completedLength = PHASE_BOARD_LENGTHS[phase] ?? 0;
    const completedBoard = game.communityCards.slice(0, completedLength);
    const priorLength = previousBoardLengthForPhase(phase);
    const priorBoard = game.communityCards.slice(0, priorLength);
    const completedDistribution = this.getDistribution(game, bot, completedBoard);
    const priorDistribution = this.getDistribution(game, bot, priorBoard);
    const completedSnapshots = this.getCandidateSnapshots(game, completedBoard);
    const priorSnapshots = this.getCandidateSnapshots(game, priorBoard);
    const playerCount = game.players.length;
    const sigma = this.strategy.rangeSigma;
    for (const opponent of game.players) {
      if (opponent.id === bot.id) continue;
      const weights = this.weights.get(opponent.id);
      if (!weights?.length) continue;
      const finalCoin = finalCoins.get(opponent.id);
      if (!Number.isInteger(finalCoin)) continue;
      const previousCoin = this.lastFinalCoin.get(opponent.id);
      const initiatedSteals = (moves || []).filter(move => move.type === 'moved' && move.toPlayer === opponent.id && move.fromPlayer).length;
      const wasStolen = (moves || []).filter(move => move.type === 'moved' && move.fromPlayer === opponent.id && move.toPlayer !== opponent.id).length;
      const displaced = wasStolen > 0 && initiatedSteals === 0;
      // A displaced player's final coin is not necessarily their own read of
      // their hand. Use their previous coin as the behavior reference instead
      // of concluding they are weak because someone else pushed them down.
      const coinReference = displaced && Number.isInteger(previousCoin) ? previousCoin : finalCoin;
      const next = weights.map((weight, index) => {
        const completedHand = completedSnapshots[index];
        const percentile = percentileOf(completedDistribution, completedHand);
        const target = targetCoinFromStrength(percentile, playerCount);
        const coinFit = Math.exp(-((target - coinReference) ** 2) / (2 * sigma * sigma));
        let improved = false;
        if (completedLength > 0) {
          const priorPercentile = percentileOf(priorDistribution, priorSnapshots[index]);
          improved = percentile - priorPercentile >= this.strategy.effectThreshold;
        }
        let behavior = 1;
        if (completedLength > 0) {
          if (previousCoin !== undefined) {
            if (finalCoin < previousCoin) behavior = improved ? 1.5 : 0.55;
            else if (finalCoin > previousCoin) behavior = improved ? 0.7 : 1.1;
            else behavior = improved ? 0.75 : 1.2;
          }
          if (initiatedSteals > 0) behavior *= improved ? 1.25 : 0.85;
          if (displaced) behavior = 1;
        } else if (initiatedSteals > 0) {
          behavior = percentile >= 0.5 ? 1.2 : 0.85;
        }
        return (weight || 0) * coinFit * behavior;
      });
      this.weights.set(opponent.id, blendWeights(next, this.strategy.rangePriorBlend));
    }
    for (const player of game.players) {
      const coin = finalCoins.get(player.id);
      if (Number.isInteger(coin)) this.lastFinalCoin.set(player.id, coin);
    }
  }

  prepareRound(game, bot, now = Date.now(), random = Math.random) {
    this.observeState(game, bot, now);
    this.ensurePool(game, bot);
    if (this.planReady) return;
    this.actionCount = 0;
    this.roundStartedAt = this.roundStartedAt || now;
    if (game.phase === 'ROUND_1_COINS') {
      this.mode = 'round1';
      this.target = chooseTargetCoin(game, bot);
      this.preferredCoin = this.target;
      this.planReady = true;
      return;
    }
    const currentBoard = game.communityCards.slice();
    const priorLength = previousBoardLengthForPhase(game.phase);
    const priorBoard = currentBoard.slice(0, priorLength);
    const before = this.fieldScore(game, bot, priorBoard);
    if (this.rangeFilteredBoardLength < currentBoard.length) this.filterPoolForBoard(game, bot, currentBoard);
    const after = this.fieldScore(game, bot, currentBoard);
    const improved = after - before >= this.strategy.effectThreshold;
    const previousCoin = bot.coinHistory.length ? bot.coinHistory[bot.coinHistory.length - 1] : null;
    this.fieldBefore = before;
    this.fieldAfter = after;
    this.improved = improved;
    this.mode = improved ? 'climb' : 'hold';
    this.previousCoin = previousCoin;
    this.target = improved ? 1 : (Number.isInteger(previousCoin) ? previousCoin : chooseTargetCoin(game, bot));
    this.preferredCoin = this.target;
    this.planReady = true;
  }

  defenderRetreatProbability(game, victim, robberId, stolenCoin) {
    const currentBoard = game.communityCards.slice();
    const priorLength = previousBoardLengthForPhase(game.phase);
    const priorBoard = currentBoard.slice(0, priorLength);
    const victimHand = this.getOwnSnapshot(game, victim, currentBoard);
    const completedDistribution = this.getDistribution(game, victim, currentBoard);
    const priorDistribution = this.getDistribution(game, victim, priorBoard);
    const candidateSnapshots = this.getCandidateSnapshots(game, currentBoard);
    const priorSnapshots = this.getCandidateSnapshots(game, priorBoard);
    const weights = normalizeWeights(this.weights.get(robberId) || []);
    let improvedWeight = 0;
    let threatWeight = 0;
    let totalBeat = 0;
    for (let index = 0; index < candidateSnapshots.length; index += 1) {
      const weight = weights[index] || 0;
      if (!(weight > 0)) continue;
      const afterPercentile = percentileOf(completedDistribution, candidateSnapshots[index]);
      const beforePercentile = percentileOf(priorDistribution, priorSnapshots[index]);
      const improved = afterPercentile - beforePercentile >= this.strategy.effectThreshold;
      const beats = compareSnapshots(candidateSnapshots[index], victimHand) > 0;
      if (beats) totalBeat += weight;
      if (improved) {
        improvedWeight += weight;
        if (beats) threatWeight += weight;
      }
    }
    if (improvedWeight > 1e-9) return clamp((threatWeight + 0.02) / (improvedWeight + 0.04), 0.05, 0.95);
    return clamp((totalBeat + 0.02) / (1 + 0.04), 0.05, 0.95);
  }

  resolveTheft(game, bot, random) {
    const theft = this.pendingTheft;
    this.pendingTheft = null;
    if (!theft) return;
    const holder = game.players.find(player => player.currentCoin === theft.coin);
    if (!holder || holder.id === bot.id) {
      if (this.target === null || this.target === theft.coin) this.target = theft.coin;
      return;
    }
    if (this.mode === 'round1') {
      const free = [...game.coinTable.area];
      const storedBackup = Number.isInteger(this.round1Backup) && free.includes(this.round1Backup) ? this.round1Backup : null;
      const backup = storedBackup ?? bestFreeCoin(this.preferredCoin ?? theft.coin, free, random);
      if (this.round1Contests < 1 && free.length) {
        const strength = estimateStrength(game, bot);
        const probability = contestProbability(strength, theft.coin, backup, game.players.length);
        if (random() < probability) {
          this.round1Contests += 1;
          this.round1Backup = backup;
          this.target = theft.coin;
          return;
        }
      }
      this.round1Failed = true;
      this.target = Number.isInteger(backup) ? backup : bestFreeCoin(theft.coin, free, random);
      return;
    }
    if (this.lastSteal && this.lastSteal.coin === theft.coin && this.lastSteal.victimId === holder.id) {
      const failures = (this.failuresByCoin.get(theft.coin) || 0) + 1;
      this.failuresByCoin.set(theft.coin, failures);
      const retry = failures <= this.strategy.maxGrabRetries && random() < grabRetryProbability(failures, this.strategy);
      this.lastSteal = null;
      this.target = retry ? theft.coin : (theft.coin + 1 <= game.players.length ? theft.coin + 1 : bestFreeCoin(theft.coin, game.coinTable.area, random));
      return;
    }
    const robberPrevious = this.lastFinalCoin.get(holder.id);
    const frontRetreat = Number.isInteger(robberPrevious) && robberPrevious < theft.coin;
    this.lastSteal = null;
    if (this.mode === 'hold' && frontRetreat) {
      this.target = theft.coin + 1 <= game.players.length ? theft.coin + 1 : bestFreeCoin(theft.coin, game.coinTable.area, random);
      return;
    }
    const retreatProbability = this.defenderRetreatProbability(game, bot, holder.id, theft.coin);
    if (random() < retreatProbability) {
      this.target = theft.coin + 1 <= game.players.length ? theft.coin + 1 : bestFreeCoin(theft.coin, game.coinTable.area, random);
    } else {
      this.target = theft.coin;
    }
  }

  takeBestFree(game, random = Math.random) {
    const free = [...game.coinTable.area];
    if (!free.length) return null;
    const target = Number.isInteger(this.target) ? this.target : (Number.isInteger(this.preferredCoin) ? this.preferredCoin : null);
    const coin = bestFreeCoin(target, free, random);
    return Number.isInteger(coin) ? { coin, fromPlayerId: null } : null;
  }

  nextAction(game, bot, random = Math.random) {
    if (bot.currentCoin !== null) {
      this.pendingTheft = null;
      return null;
    }
    if (this.pendingTheft) this.resolveTheft(game, bot, random);
    if (this.actionCount >= maxCoinActions(game.players.length)) {
      return this.takeBestFree(game, random);
    }
    if (this.mode === 'round1') {
      const free = [...game.coinTable.area];
      const target = Number.isInteger(this.target) ? this.target : this.preferredCoin;
      if (!Number.isInteger(target)) return this.takeBestFree(game, random);
      if (free.includes(target)) return { coin: target, fromPlayerId: null };
      const backup = bestFreeCoin(target, free, random);
      if (this.round1Failed) {
        return Number.isInteger(backup) ? { coin: backup, fromPlayerId: null } : this.takeBestFree(game, random);
      }
      if (!free.length) return { coin: target, fromPlayerId: game.coinTable.owners.get(target) || null };
      if (Number.isInteger(backup) && backup < target) return { coin: backup, fromPlayerId: null };
      if (this.round1Contests >= 1) {
        return Number.isInteger(backup) ? { coin: backup, fromPlayerId: null } : this.takeBestFree(game, random);
      }
      const probability = contestProbability(estimateStrength(game, bot), target, backup, game.players.length);
      if (random() < probability) {
        this.round1Contests += 1;
        this.round1Backup = backup;
        return { coin: target, fromPlayerId: game.coinTable.owners.get(target) || null };
      }
      return Number.isInteger(backup) ? { coin: backup, fromPlayerId: null } : this.takeBestFree(game, random);
    }
    if (!Number.isInteger(this.target) || this.target < 1 || this.target > game.players.length) {
      return this.takeBestFree(game, random);
    }
    if (game.coinTable.area.has(this.target)) return { coin: this.target, fromPlayerId: null };
    const holder = game.coinTable.owners.get(this.target);
    if (holder && holder !== bot.id) return { coin: this.target, fromPlayerId: holder };
    return this.takeBestFree(game, random);
  }

  onActionTaken(coin, fromPlayerId) {
    this.actionCount += 1;
    this.observedCoin = coin;
    this.lastHeldCoin = coin;
    this.target = coin;
    if (fromPlayerId) this.lastSteal = { coin, victimId: fromPlayerId };
    else this.lastSteal = null;
  }
}

class BotDriver {
  constructor({
    room,
    onChange,
    onError = error => console.error('[bot] action failed:', error),
    random = Math.random,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    coinDelayMs = 450,
    rematchDelayMs = 450,
    skipDelayMs = 300,
    strategy = {},
    changeWaitMs = null,
    changeWaitMaxMs = null,
    coinActionGapMs = null
  }) {
    this.room = room;
    this.onChange = onChange;
    this.onError = onError;
    this.random = random;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.coinDelayMs = coinDelayMs;
    this.rematchDelayMs = rematchDelayMs;
    this.skipDelayMs = skipDelayMs;
    this.strategy = { ...BOT_STRATEGY, ...strategy };
    this.changeWaitMs = changeWaitMs ?? this.strategy.changeWaitMs ?? 900;
    this.changeWaitMaxMs = changeWaitMaxMs ?? this.strategy.changeWaitMaxMs ?? 2400;
    this.coinActionGapMs = coinActionGapMs ?? this.strategy.coinActionGapMs ?? 500;
    this.lastCoinActionAt = null;
    this.timers = new Map();
    this.brains = new Map();
    this.errorCounts = new Map();
    this.stopped = false;
  }

  brainFor(bot) {
    if (!this.brains.has(bot.id)) this.brains.set(bot.id, new BotBrain(bot.id, this.strategy));
    return this.brains.get(bot.id);
  }

  schedule(key, baseDelay, action, jitter = true) {
    if (this.stopped || this.timers.has(key)) return;
    const delay = Math.max(0, Math.floor(baseDelay + (jitter ? this.random() * baseDelay : 0)));
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(key);
      if (this.stopped) return;
      try { action(); } catch (error) { this.onError(error); }
    }, delay);
    this.timers.set(key, timer);
  }

  sync() {
    if (this.stopped || !this.room.game) return;
    const game = this.room.game;
    const bots = game.players.filter(player => player.isBot);
    if (!bots.length) return;
    const now = this.now();
    for (const bot of bots) {
      try { this.brainFor(bot).observeState(game, bot, now); } catch (error) { this.onError(error); }
    }

    if (COIN_PHASES.has(game.phase)) {
      for (const bot of bots) {
        try { this.brainFor(bot).prepareRound(game, bot, now, this.random); } catch (error) { this.onError(error); }
      }
      const holdBots = bots.filter(bot => this.brainFor(bot).mode === 'hold');
      for (const bot of bots) {
        if (bot.currentCoin !== null) continue;
        const phase = game.phase;
        const key = `coin:${bot.id}:${phase}`;
        if (this.timers.has(key)) continue;
        const brain = this.brainFor(bot);
        const baseDelay = this.coinDelayMs + (brain.mode === 'climb' ? this.changeWaitMs : 0);
        this.schedule(key, baseDelay, () => this.act(bot, phase, key, holdBots));
      }
    }

    if (REMATCH_PHASES.has(game.phase)) {
      const phase = game.phase;
      const hostConfirmed = game.rematchConfirmed.has(this.room.hostId);
      if (hostConfirmed) {
        for (const bot of bots) {
          if (game.rematchConfirmed.has(bot.id)) continue;
          this.schedule(`rematch:${bot.id}:${phase}`, this.rematchDelayMs, () => {
            if (this.room.game !== game || game.phase !== phase || game.rematchConfirmed.has(bot.id)) return;
            if (!game.rematchConfirmed.has(this.room.hostId)) return;
            game.confirmRematch(bot.id);
            this.onChange();
          });
        }
      }
      if (game.lastResult && game.comparisonSkipVotes.size > 0 && !game.comparisonSkip) {
        for (const bot of bots) {
          if (game.comparisonSkipVotes.has(bot.id)) continue;
          this.schedule(`skip:${bot.id}:${phase}`, this.skipDelayMs, () => {
            if (this.room.game !== game || game.phase !== phase || game.comparisonSkip || game.comparisonSkipVotes.has(bot.id)) return;
            game.requestComparisonSkip(bot.id);
            this.onChange();
          });
        }
      }
    }
  }

  act(bot, phase, key, holdBots) {
    const game = this.room.game;
    if (!game || game.phase !== phase || bot.currentCoin !== null) return;
    const now = this.now();
    // Keep every bot coin action visible: after any bot action, wait at least
    // the configured gap before another bot may move a coin. The gap is global
    // across bots, so seven bots no longer empty the table in one burst.
    if (this.lastCoinActionAt !== null && this.coinActionGapMs > 0) {
      const sinceLast = now - this.lastCoinActionAt;
      if (sinceLast < this.coinActionGapMs) {
        this.schedule(key, this.coinActionGapMs - sinceLast, () => this.act(bot, phase, key, holdBots), false);
        return;
      }
    }
    const brain = this.brainFor(bot);
    brain.observeState(game, bot, now);
    brain.prepareRound(game, bot, now, this.random);
    if (brain.mode === 'climb') {
      const holdPending = holdBots.some(other => other.id !== bot.id && other.currentCoin === null);
      if (holdPending && now - brain.roundStartedAt < this.changeWaitMaxMs) {
        this.schedule(key, this.changeWaitMs, () => this.act(bot, phase, key, holdBots));
        return;
      }
    }
    const action = brain.nextAction(game, bot, this.random);
    if (!action || !Number.isInteger(action.coin)) return;
    if (bot.currentCoin === action.coin) return;
    const owner = game.coinTable.owners.get(action.coin) || null;
    if (owner === bot.id) return;
    try {
      game.moveCoin(action.coin, bot.id, owner);
      brain.onActionTaken(action.coin, owner);
      this.errorCounts.delete(key);
      this.lastCoinActionAt = this.now();
      this.onChange({ coinAction: { type: 'MOVE', coin: action.coin, fromPlayerId: owner, toPlayerId: bot.id } });
    } catch (error) {
      this.onError(error);
      const errors = (this.errorCounts.get(key) || 0) + 1;
      this.errorCounts.set(key, errors);
      if (errors <= 2) this.schedule(key, this.coinDelayMs, () => this.act(bot, phase, key, holdBots));
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimeoutFn(timer);
    this.timers.clear();
  }
}

module.exports = {
  BOT_NAMES,
  BOT_STRATEGY,
  BotBrain,
  BotDriver,
  buildFieldDistribution,
  chooseBotCoin,
  chooseTargetCoin,
  coinStrength,
  contestProbability,
  estimateStrength,
  fieldScoreForBrain: (brain, game, bot, board) => brain.fieldScore(game, bot, board),
  grabRetryProbability,
  percentileOf,
  preflopStrength,
  rangePoolFor,
  targetCoinFromStrength
};
