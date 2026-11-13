const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, PHASES } = require('../src/game');
const { CoinTable } = require('../src/poker');
const { BOT_NAMES, BotBrain, BotDriver, chooseBotCoin } = require('../src/bot');

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

test('each bot gets its own coin timer when the action gap is disabled', () => {
  const game = new GameRoom({ players: ['human', 'Robot Jack', 'Robot Sam'], botIds: ['Robot Jack', 'Robot Sam'], random: () => 0 });
  const room = { game, hostId: 'human' };
  game.phase = PHASES.ROUND_1_COINS;
  game.coinTable = new CoinTable(['human', 'Robot Jack', 'Robot Sam']);
  game.communityCards = [];
  const jack = game.players.find(player => player.id === 'Robot Jack');
  const sam = game.players.find(player => player.id === 'Robot Sam');
  const timers = [];
  const actions = [];
  let driver;
  driver = new BotDriver({
    room,
    onChange: payload => { actions.push(payload.coinAction); driver.sync(); },
    random: () => 0,
    setTimeoutFn: callback => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
    coinDelayMs: 0,
    coinActionGapMs: 0
  });

  driver.sync();
  assert.equal(timers.length, 2, 'each bot gets its own coin timer');
  timers.shift()();
  assert.notEqual(jack.currentCoin, null);
  assert.equal(sam.currentCoin, null, 'the second timer can still be pending');
  timers.shift()();
  assert.notEqual(sam.currentCoin, null);
  assert.deepEqual(actions.map(action => action.toPlayerId), ['Robot Jack', 'Robot Sam']);
  assert.ok(actions.every(action => action.type === 'MOVE' && action.fromPlayerId === null));
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
    coinActionGapMs: 0,
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


function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutFn: () => {},
    next() {
      const item = timers.shift();
      if (item) item.callback();
      return item;
    }
  };
}

function roundTwoSetup() {
  const C = (rank, suit) => ({ rank, suit });
  const game = new GameRoom({ players: ['H', 'B', 'C'], botIds: ['B', 'C'], random: () => 0.2 });
  game.start();
  const human = game.players.find(player => player.id === 'H');
  const holdBot = game.players.find(player => player.id === 'B');
  const climbBot = game.players.find(player => player.id === 'C');
  holdBot.holeCards = [C(2, 's'), C(5, 'h')];
  climbBot.holeCards = [C(4, 's'), C(3, 'h')];
  human.holeCards = [C(14, 'd'), C(13, 'd')];
  game.moveCoin(1, 'C');
  game.moveCoin(2, 'B');
  game.moveCoin(3, 'H');
  game.communityCards = [C(14, 's'), C(14, 'h'), C(4, 'c')];
  return { game, human, holdBot, climbBot };
}

test('round two lets unchanged bots take their previous coin before changed bots climb', () => {
  const { game, holdBot, climbBot } = roundTwoSetup();
  const fake = fakeTimers();
  const actions = [];
  let driver;
  driver = new BotDriver({
    room: { game, hostId: 'H' },
    onChange: payload => { if (payload?.coinAction) actions.push(payload.coinAction); driver.sync(); },
    random: () => 0,
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    coinDelayMs: 0,
    coinActionGapMs: 0,
    changeWaitMs: 500,
    changeWaitMaxMs: 2000
  });
  driver.sync();
  assert.equal(driver.brains.get('B').mode, 'hold');
  assert.equal(driver.brains.get('B').target, 2);
  assert.equal(driver.brains.get('C').mode, 'climb');
  assert.equal(driver.brains.get('C').target, 1);
  assert.equal(fake.timers.length, 2);
  const holdTimer = fake.timers.find(item => item.delay === 0);
  const climbTimer = fake.timers.find(item => item.delay >= 500);
  assert.ok(holdTimer && climbTimer, 'hold bots schedule earlier than climb bots');
  holdTimer.callback();
  assert.equal(holdBot.currentCoin, 2);
  assert.deepEqual(actions[0], { type: 'MOVE', coin: 2, fromPlayerId: null, toPlayerId: 'B' });
  climbTimer.callback();
  assert.equal(climbBot.currentCoin, 1);
  assert.deepEqual(actions[1], { type: 'MOVE', coin: 1, fromPlayerId: null, toPlayerId: 'C' });
  driver.stop();
});

test('an unchanged bot robbed by a front retreater moves to the next coin', () => {
  const { game, holdBot } = roundTwoSetup();
  game.moveCoin(2, 'B');
  game.moveCoin(1, 'C');
  const fake = fakeTimers();
  const actions = [];
  let driver;
  driver = new BotDriver({
    room: { game, hostId: 'H' },
    onChange: payload => { if (payload?.coinAction) actions.push(payload.coinAction); driver.sync(); },
    random: () => 0,
    setTimeoutFn: fake.setTimeoutFn,
    clearTimeoutFn: fake.clearTimeoutFn,
    coinDelayMs: 0,
    coinActionGapMs: 0,
    changeWaitMs: 0,
    changeWaitMaxMs: 0
  });
  driver.sync();
  assert.equal(fake.timers.length, 0, 'both bots already hold coins');
  assert.equal(driver.brains.get('B').mode, 'hold');
  assert.equal(holdBot.currentCoin, 2);
  // C (previous coin 1) retreats onto B's coin 2.
  game.moveCoin(2, 'C', 'B');
  driver.sync();
  assert.equal(holdBot.currentCoin, null);
  assert.equal(fake.timers.length, 1, 'the robbed hold bot gets a reaction timer');
  fake.next();
  assert.equal(holdBot.currentCoin, 3);
  assert.deepEqual(actions[0], { type: 'MOVE', coin: 3, fromPlayerId: null, toPlayerId: 'B' });
  driver.stop();
});

test('failed grabs retry the same coin with a decreasing chance, then move down', () => {
  const game = new GameRoom({ players: ['H', 'B', 'C'], botIds: ['B'], random: () => 0.2 });
  game.phase = PHASES.ROUND_2_COINS;
  game.coinTable = new CoinTable(['H', 'B', 'C']);
  const bot = game.players.find(player => player.id === 'B');
  bot.holeCards = [{ rank: 14, suit: 's' }, { rank: 14, suit: 'h' }];
  bot.coinHistory = [2];
  game.players.find(player => player.id === 'C').coinHistory = [1];
  game.moveCoin(1, 'C');
  const brain = new BotBrain('B');
  brain.mode = 'climb';
  brain.target = 1;
  brain.planReady = true;
  brain.lastSteal = { coin: 1, victimId: 'C' };
  brain.pendingTheft = { coin: 1 };
  const first = brain.nextAction(game, bot, () => 0);
  assert.equal(brain.failuresByCoin.get(1), 1);
  assert.equal(first.coin, 1, 'first failure retries coin 1');
  brain.lastSteal = { coin: 1, victimId: 'C' };
  brain.pendingTheft = { coin: 1 };
  const second = brain.nextAction(game, bot, () => 0);
  assert.equal(brain.failuresByCoin.get(1), 2);
  assert.equal(second.coin, 1, 'second failure can still retry');
  brain.lastSteal = { coin: 1, victimId: 'C' };
  brain.pendingTheft = { coin: 1 };
  const third = brain.nextAction(game, bot, () => 0);
  assert.equal(brain.failuresByCoin.get(1), 3);
  assert.equal(third.coin, 2, 'after the retry cap the bot moves to the next coin');
});


test('bot coin actions are separated by the global action gap', () => {
  const game = new GameRoom({ players: ['A', 'B'], botIds: ['A', 'B'], random: () => 0.5 });
  game.phase = PHASES.ROUND_1_COINS;
  game.coinTable = new CoinTable(['A', 'B']);
  game.communityCards = [];
  const timers = [];
  const actions = [];
  let now = 1000;
  let driver;
  driver = new BotDriver({
    room: { game, hostId: 'A' },
    onChange: payload => { if (payload?.coinAction) actions.push(payload.coinAction); driver.sync(); },
    random: () => 0,
    now: () => now,
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutFn: () => {},
    coinDelayMs: 0,
    coinActionGapMs: 500,
    changeWaitMs: 0,
    changeWaitMaxMs: 0
  });
  driver.sync();
  assert.equal(timers.length, 2, 'both bots schedule their first choice');
  timers.shift().callback();
  assert.equal(actions.length, 1, 'the first bot acts immediately');
  const second = timers.shift();
  second.callback();
  assert.equal(actions.length, 1, 'the second bot waits for the global gap');
  assert.ok(timers.some(item => item.delay === 500), 'the second action is rescheduled for the remaining gap');
  now = 1500;
  timers.shift().callback();
  assert.equal(actions.length, 2, 'the second bot acts after 500ms');
  driver.stop();
});
