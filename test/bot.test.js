const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, PHASES } = require('../src/game');
const { CoinTable } = require('../src/poker');
const { BOT_NAMES, BotDriver, chooseBotCoin } = require('../src/bot');

function botRoom() {
  const game = new GameRoom({ players: ['human', 'Robot Jack'], botIds: ['Robot Jack'], random: () => 0 });
  const bot = game.players.find(player => player.id === 'Robot Jack');
  game.phase = PHASES.ROUND_1_COINS;
  game.coinTable = new CoinTable(['human', 'Robot Jack']);
  game.communityCards = [];
  return { game, bot };
}

test('bot names start with the requested three and provide seven seats', () => {
  assert.deepEqual(BOT_NAMES.slice(0, 3), ['Robot Jack', 'Robot Sam', 'Robot Daniel']);
  assert.equal(BOT_NAMES.length, 7);
  assert.equal(new Set(BOT_NAMES).size, 7);
});

test('bots choose a free coin from their own hand strength', () => {
  const strong = botRoom();
  strong.bot.holeCards = [{ rank: 14, suit: 's' }, { rank: 14, suit: 'h' }];
  assert.equal(chooseBotCoin(strong.game, strong.bot, () => 0), 1);

  const weak = botRoom();
  weak.bot.holeCards = [{ rank: 7, suit: 's' }, { rank: 2, suit: 'h' }];
  assert.equal(chooseBotCoin(weak.game, weak.bot, () => 0), 2);

  weak.game.coinTable.move(1, 'human');
  assert.equal(chooseBotCoin(weak.game, weak.bot, () => 0), 2);

  weak.game.coinTable.move(2, 'Robot Jack');
  assert.equal(chooseBotCoin(weak.game, weak.bot, () => 0), null);
});

test('bot coin actions are serialized one bot at a time in seat order', () => {
  const game = new GameRoom({ players: ['human', 'Robot Jack', 'Robot Sam'], botIds: ['Robot Jack', 'Robot Sam'], random: () => 0 });
  const room = { game, hostId: 'human' };
  game.phase = PHASES.ROUND_1_COINS;
  game.coinTable = new CoinTable(['human', 'Robot Jack', 'Robot Sam']);
  game.communityCards = [];
  const jack = game.players.find(player => player.id === 'Robot Jack');
  const sam = game.players.find(player => player.id === 'Robot Sam');
  const timers = [];
  let driver;
  driver = new BotDriver({
    room,
    onChange: () => { driver.sync(); },
    random: () => 0,
    setTimeoutFn: callback => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
    coinDelayMs: 0
  });

  driver.sync();
  assert.equal(timers.length, 1, 'only one bot may be waiting to take a coin');
  timers.shift()();
  assert.notEqual(jack.currentCoin, null);
  assert.equal(sam.currentCoin, null, 'the second bot waits for the first action to finish');
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.notEqual(sam.currentCoin, null);
  assert.equal(timers.length, 0);
  driver.stop();
});

test('bot driver takes a coin, confirms after the host, and joins a skip vote', () => {
  const { game, bot } = botRoom();
  const room = { game, hostId: 'human' };
  const timers = [];
  const driver = new BotDriver({
    room,
    onChange: () => {},
    random: () => 0,
    setTimeoutFn: callback => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
    coinDelayMs: 0,
    rematchDelayMs: 0,
    skipDelayMs: 0
  });

  driver.sync();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.notEqual(bot.currentCoin, null);

  game.phase = PHASES.GAME_OVER;
  game.rematchConfirmed.add('human');
  driver.sync();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(game.phase, PHASES.ROUND_1_COINS);
  assert.equal(game.rematchConfirmed.size, 0);

  game.phase = PHASES.SETTLEMENT;
  game.lastResult = { success: true, comparisons: [] };
  game.comparisonSkipVotes.add('human');
  driver.sync();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(game.comparisonSkip, true);

  driver.stop();
});
