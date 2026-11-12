const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, PHASES } = require('../src/game');
const { CoinTable } = require('../src/poker');
const {
  BotBrain,
  BOT_STRATEGY,
  buildFieldDistribution,
  contestProbability,
  grabRetryProbability,
  percentileOf,
  preflopStrength,
  targetCoinFromStrength
} = require('../src/bot');

const C = (rank, suit) => ({ rank, suit });

function effectFor(hole, board, previousCoin = 2, opponentHole = [C(14, 'c'), C(13, 'd')]) {
  const game = new GameRoom({ players: ['H', 'B'], botIds: ['B'], random: () => 0.3 });
  game.phase = PHASES.ROUND_2_COINS;
  game.communityCards = [];
  const bot = game.players.find(player => player.id === 'B');
  const human = game.players.find(player => player.id === 'H');
  bot.holeCards = hole;
  human.holeCards = opponentHole;
  bot.coinHistory = [previousCoin];
  const brain = new BotBrain('B');
  brain.observeState(game, bot, 0);
  brain.ensurePool(game, bot);
  game.communityCards = board;
  brain.prepareRound(game, bot, 0, () => 0.5);
  return brain;
}

function roundOneRange(holder) {
  const players = ['H', 'B', 'C', 'D'];
  const game = new GameRoom({ players, botIds: ['B'], random: () => 0.3 });
  game.start();
  const bot = game.players.find(player => player.id === 'B');
  bot.holeCards = [C(7, 's'), C(2, 'h')];
  const owners = { 1: 'H', 2: 'B', 3: 'C', 4: 'D' };
  for (const [coin, owner] of Object.entries(owners)) game.moveCoin(Number(coin), owner);
  const brain = new BotBrain('B');
  brain.observeState(game, bot, 0);
  return { game, bot, brain };
}

function meanRangeTarget(brain, game, bot, targetPlayerId) {
  const distribution = brain.getDistribution(game, bot, []);
  const snapshots = brain.getCandidateSnapshots(game, []);
  const weights = brain.weights.get(targetPlayerId) || [];
  let mean = 0;
  for (let index = 0; index < weights.length; index += 1) {
    mean += weights[index] * targetCoinFromStrength(percentileOf(distribution, snapshots[index]), game.players.length);
  }
  return mean;
}

test('two-card preflop strength stays compatible and three-card hands order sensibly', () => {
  assert.ok(preflopStrength([C(14, 's'), C(14, 'h')]) > preflopStrength([C(13, 's'), C(13, 'h')]));
  assert.ok(preflopStrength([C(13, 's'), C(13, 'h')]) > preflopStrength([C(14, 's'), C(13, 'h')]));
  assert.ok(preflopStrength([C(14, 's'), C(13, 'h')]) > preflopStrength([C(7, 's'), C(2, 'h')]));
  assert.ok(preflopStrength([C(14, 's'), C(14, 'h'), C(13, 'c')]) > preflopStrength([C(14, 's'), C(13, 'h'), C(12, 'c')]));
  assert.ok(preflopStrength([C(14, 's'), C(14, 'h'), C(13, 'c')]) > preflopStrength([C(14, 's'), C(10, 'h'), C(2, 'c')]));
});

test('field distributions produce comparable percentiles', () => {
  const distribution = buildFieldDistribution({
    holeCards: [C(7, 's'), C(2, 'h')],
    board: [],
    handCardCount: 2,
    handUsageRule: 'any',
    includeJokers: false
  });
  assert.equal(distribution.kind, 'preflop');
  assert.equal(distribution.values.length, 1225);
  assert.ok(percentileOf(distribution, preflopStrength([C(14, 's'), C(14, 'h')])) > 0.99);
  assert.ok(percentileOf(distribution, preflopStrength([C(7, 's'), C(2, 'h')])) < 0.1);
  assert.ok(percentileOf(distribution, preflopStrength([C(14, 's'), C(14, 'h')])) > percentileOf(distribution, preflopStrength([C(2, 's'), C(3, 'h')])));
});

test('the reveal effect follows the field rank rather than absolute hand growth', () => {
  const sharedBoard = effectFor([C(2, 's'), C(4, 'h')], [C(14, 's'), C(14, 'h'), C(13, 'c')], 2);
  assert.equal(sharedBoard.improved, false, 'AAK improves everyone, so 2-4 does not climb');
  assert.equal(sharedBoard.mode, 'hold');
  assert.equal(sharedBoard.target, 2);

  const pairedHole = effectFor([C(4, 's'), C(3, 'h')], [C(14, 's'), C(14, 'h'), C(4, 'c')], 2);
  assert.equal(pairedHole.improved, true, 'the flop pairs the hole card 4');
  assert.equal(pairedHole.mode, 'climb');
  assert.equal(pairedHole.target, 1);

  const bigHand = effectFor([C(14, 's'), C(13, 'h')], [C(14, 'h'), C(14, 'd'), C(13, 'c')], 2);
  assert.equal(bigHand.improved, true);
  assert.equal(bigHand.mode, 'climb');
});

test('round-one contest probability follows strength and backup quality', () => {
  assert.ok(contestProbability(0.9, 1, 2, 4) > contestProbability(0.7, 1, 2, 4));
  assert.equal(contestProbability(0.9, 2, 1, 4), 0, 'a better free backup is taken without a fight');
  assert.ok(contestProbability(0.9, 1, 2, 4) <= 1);
  assert.equal(contestProbability(0.15, 1, 2, 4), 0, 'a hand below the backup band retreats');
});

test('failed grabs retry with a decreasing probability', () => {
  assert.equal(grabRetryProbability(1), BOT_STRATEGY.grabRetryBase);
  assert.ok(grabRetryProbability(2) < grabRetryProbability(1));
  assert.ok(grabRetryProbability(3) < grabRetryProbability(2));
  assert.ok(grabRetryProbability(20) >= 0);
});

test('round-one coin choices narrow each opponent range', () => {
  const strongHolder = roundOneRange('H');
  const strongMean = meanRangeTarget(strongHolder.brain, strongHolder.game, strongHolder.bot, 'H');
  assert.ok(strongMean < 2.5, `coin 1 holder should be believed stronger, got ${strongMean}`);
  const weakHolder = roundOneRange('D');
  const weakMean = meanRangeTarget(weakHolder.brain, weakHolder.game, weakHolder.bot, 'D');
  assert.ok(weakMean > 2.5, `coin 4 holder should be believed weaker, got ${weakMean}`);
});

test('revealed community cards are removed from the opponent range pool', () => {
  const game = new GameRoom({ players: ['H', 'B'], botIds: ['B'], random: () => 0.3 });
  game.phase = PHASES.ROUND_2_COINS;
  game.communityCards = [];
  const bot = game.players.find(player => player.id === 'B');
  bot.holeCards = [C(7, 's'), C(2, 'h')];
  const brain = new BotBrain('B');
  brain.observeState(game, bot, 0);
  brain.ensurePool(game, bot);
  const board = [C(14, 's'), C(13, 'h'), C(12, 'c')];
  game.communityCards = board;
  brain.filterPoolForBoard(game, bot, board);
  assert.ok(brain.pool.length > 0);
  const boardKeys = new Set(board.map(card => `${card.rank}/${card.suit}`));
  assert.ok(brain.pool.every(hand => hand.every(card => !boardKeys.has(`${card.rank}/${card.suit}`))));
  for (const weights of brain.weights.values()) {
    const sum = weights.reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test('the range cache resets on a new deal', () => {
  const { game, bot, brain } = roundOneRange('H');
  const before = meanRangeTarget(brain, game, bot, 'H');
  assert.ok(before < 2.5);
  game.phase = PHASES.SETTLEMENT;
  game.start();
  brain.observeState(game, bot, 0);
  assert.equal(brain.lastFinalCoin.size, 0);
  const weights = brain.weights.get('H');
  assert.ok(weights.length > 0);
  const max = Math.max(...weights);
  const min = Math.min(...weights);
  assert.ok(max - min < 1e-9, 'new deal starts from a uniform range');
});

test('defender retreat probability rises with a strong robber range', () => {
  const game = new GameRoom({ players: ['H', 'B'], botIds: ['B'], random: () => 0.3 });
  game.phase = PHASES.ROUND_2_COINS;
  game.communityCards = [C(14, 's'), C(13, 'h'), C(12, 'c')];
  const victim = game.players.find(player => player.id === 'H');
  const robber = game.players.find(player => player.id === 'B');
  victim.holeCards = [C(14, 'h'), C(14, 'd')];
  robber.holeCards = [C(11, 's'), C(10, 'h')];
  const brain = new BotBrain('H');
  brain.observeState(game, victim, 0);
  brain.ensurePool(game, victim);
  brain.pool = [[C(11, 's'), C(10, 'h')], [C(2, 's'), C(3, 'h')]];
  brain.poolVersion += 1;
  brain.candidateSnapshots.clear();
  brain.weights.set('B', [1, 0]);
  const strong = brain.defenderRetreatProbability(game, victim, 'B', 1);
  brain.weights.set('B', [0, 1]);
  const weak = brain.defenderRetreatProbability(game, victim, 'B', 1);
  assert.ok(strong > 0.7, `strong range should make the victim retreat often, got ${strong}`);
  assert.ok(weak < 0.2, `weak range should make the victim reclaim, got ${weak}`);
});


test('round-two range updates compare the flop against the preflop range', () => {
  const game = new GameRoom({ players: ['H', 'B'], botIds: ['B'], random: () => 0.3 });
  game.phase = PHASES.ROUND_2_COINS;
  game.communityCards = [C(14, 's'), C(13, 'h'), C(12, 'c')];
  const bot = game.players.find(player => player.id === 'B');
  const human = game.players.find(player => player.id === 'H');
  bot.holeCards = [C(2, 's'), C(2, 'h')];
  human.holeCards = [C(11, 's'), C(10, 'h')];
  const brain = new BotBrain('B', { rangeSigma: 100 });
  brain.observeState(game, bot, 0);
  brain.ensurePool(game, bot);
  brain.pool = [[C(11, 's'), C(10, 'h')], [C(2, 's'), C(3, 'h')]];
  brain.poolVersion += 1;
  brain.candidateSnapshots.clear();
  brain.weights.set('H', [0.5, 0.5]);
  brain.lastFinalCoin.set('H', 2);
  brain.updateRangeWeights(game, bot, PHASES.ROUND_2_COINS, [
    { playerId: 'H', coin: 1 },
    { playerId: 'B', coin: 2 }
  ], []);
  const [improvedWeight, weakWeight] = brain.weights.get('H');
  assert.ok(improvedWeight > weakWeight * 1.5, `a moved-up player should upweight the improved candidate, got ${improvedWeight} vs ${weakWeight}`);
});


test('bot decisions do not depend on the opponents actual hole cards', () => {
  const board = [C(14, 's'), C(14, 'h'), C(13, 'c')];
  const first = effectFor([C(2, 's'), C(4, 'h')], board, 2, [C(14, 'c'), C(13, 'd')]);
  const second = effectFor([C(2, 's'), C(4, 'h')], board, 2, [C(2, 'c'), C(3, 'd')]);
  assert.equal(first.improved, second.improved);
  assert.equal(first.mode, second.mode);
  assert.equal(first.target, second.target);
  assert.equal(first.fieldAfter, second.fieldAfter);
});
