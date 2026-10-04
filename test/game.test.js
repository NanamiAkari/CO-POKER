const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, PHASES } = require('../src/game');

test('runs all four coin rounds and reveals community cards progressively', () => {
  const room = new GameRoom({ players: ['a', 'b'], random: () => 0.5 });
  room.start();
  assert.equal(room.phase, PHASES.ROUND_1_COINS);
  room.moveCoin(1, 'a');
  room.moveCoin(2, 'b');
  assert.equal(room.communityCards.length, 3);
  assert.equal(room.phase, PHASES.ROUND_2_COINS);
  room.moveCoin(1, 'b');
  room.moveCoin(2, 'a');
  assert.equal(room.communityCards.length, 4);
  room.moveCoin(1, 'a');
  room.moveCoin(2, 'b');
  assert.equal(room.communityCards.length, 5);
  room.moveCoin(1, 'b');
  room.moveCoin(2, 'a');
  assert.ok([PHASES.FINAL_REVEAL, PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(room.phase));
  assert.equal(room.players.every(player => player.finalHand), true);
});

test('settles adjacent comparisons and treats ties as passing', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  room.phase = PHASES.FINAL_REVEAL;
  room.players[0].currentCoin = 1;
  room.players[1].currentCoin = 2;
  room.players[0].finalHand = { category: 2, tiebreak: [14, 10, 2] };
  room.players[1].finalHand = { category: 2, tiebreak: [14, 10, 2] };
  const result = room.settle();
  assert.equal(result.success, true);
  assert.equal(result.comparisons[0].passed, true);
  assert.equal(room.successCount, 1);
});

test('does not allow coin changes after final round', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  room.phase = PHASES.FINAL_REVEAL;
  assert.throws(() => room.moveCoin(1, 'a'), /closed/);
});

test('automatically settles after the fourth coin round', () => {
  const room = new GameRoom({ players: ['a', 'b'], random: () => 0.4 });
  room.start();
  for (let round = 0; round < 4; round += 1) {
    room.moveCoin(1, 'a');
    room.moveCoin(2, 'b');
    if (round < 3) assert.match(room.phase, /^ROUND_[2-4]_COINS$/);
  }
  assert.ok([PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(room.phase));
  assert.ok(room.lastResult);
  assert.equal(room.lastResult.comparisons.length, 1);
});

test('allows a rematch after the game-over threshold', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  room.phase = PHASES.GAME_OVER;
  room.successCount = 3;
  room.confirmRematch('a');
  room.confirmRematch('b');
  assert.equal(room.phase, PHASES.ROUND_1_COINS);
  assert.equal(room.successCount, 0);
  assert.equal(room.failureCount, 0);
});

test('ordinary rematch preserves counters and requires each player confirmation', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  room.phase = PHASES.SETTLEMENT;
  room.successCount = 1;
  room.failureCount = 2;
  room.confirmRematch('a');
  room.confirmRematch('a');
  assert.equal(room.phase, PHASES.SETTLEMENT);
  assert.equal(room.rematchConfirmed.size, 1);
  room.confirmRematch('b');
  assert.equal(room.phase, PHASES.ROUND_1_COINS);
  assert.equal(room.successCount, 1);
  assert.equal(room.failureCount, 2);
  assert.equal(room.rematchConfirmed.size, 0);
});

test('history visibility hides both top-level and per-player histories', () => {
  for (const visibility of ['all', 'self', 'none']) {
    const room = new GameRoom({ players: ['a', 'b'], historyVisibility: visibility });
    room.start();
    room.moveCoin(1, 'a');
    room.moveCoin(2, 'b');
    const view = room.getPlayerView('a');
    assert.deepEqual(view.coinHistory, visibility === 'none' ? [] : [1]);
    assert.deepEqual(view.players[0].coinHistory, visibility === 'none' ? [] : [1]);
    assert.deepEqual(view.players[1].coinHistory, visibility === 'all' ? [2] : []);
  }
});

test('estimated hand uses only own cards and revealed community cards', () => {
  for (const handUsageRule of ['any', 'all-hole']) {
    const room = new GameRoom({ players: ['a', 'b'], handCardCount: 3, handUsageRule });
    room.start();
    assert.equal(room.getPlayerView('a').ownEstimatedHand, null);
    room.players[0].holeCards = [{rank:14,suit:'s'}, {rank:14,suit:'h'}, {rank:2,suit:'c'}];
    room.communityCards = [{rank:13,suit:'s'}, {rank:11,suit:'h'}, {rank:7,suit:'c'}];
    const estimate = room.getPlayerView('a').ownEstimatedHand;
    assert.equal(estimate.categoryName, '一对');
    const visible = [...room.players[0].holeCards, ...room.communityCards];
    assert.equal(estimate.cards.length, 5);
    assert.ok(estimate.cards.every(card => visible.some(v => v.rank === card.rank && v.suit === card.suit)));
    if (handUsageRule === 'all-hole') assert.ok(estimate.cards.some(card => card.rank === 2));
    else assert.ok(!estimate.cards.some(card => card.rank === 2));
  }
});

test('settled coins stay immutable and explicitly ended games cannot rematch', () => {
  const room = new GameRoom({ players: ['a', 'b'] }); room.start();
  for (let round = 0; round < 4; round++) { room.moveCoin(1, 'a'); room.moveCoin(2, 'b'); }
  assert.throws(() => room.returnCoin(1, 'a'), /closed/);
  assert.equal(room.players[0].currentCoin, 1);
  room.endGame();
  assert.throws(() => room.confirmRematch('a'), /closed/);
  assert.throws(() => room.start(), /closed/);
});

test('invalid stealing request cannot partially return the callers existing coin', () => {
  const room = new GameRoom({ players: ['a', 'b', 'c'] }); room.start();
  room.moveCoin(1, 'a'); room.moveCoin(2, 'b');
  assert.throws(() => room.moveCoin(2, 'a', 'c'), /Invalid source/);
  assert.equal(room.coinTable.owners.get(1), 'a');
  assert.equal(room.coinTable.owners.get(2), 'b');
  assert.deepEqual([...room.coinTable.area], [3]);
});

test('treats coin 1 as strongest: weaker hands appear before stronger hands', () => {
  const room = new GameRoom({ players: ['high-card', 'pair'] });
  room.phase = PHASES.FINAL_REVEAL;
  room.players[0].currentCoin = 2;
  room.players[1].currentCoin = 1;
  room.players[0].finalHand = { category: 0, tiebreak: [14, 11, 9, 6, 3] };
  room.players[1].finalHand = { category: 1, tiebreak: [2, 14, 11, 9] };
  assert.equal(room.settle().success, true);
});

test('supports rematch confirmation, spectators, history visibility, and replay events', () => {
  const room = new GameRoom({ players: ['a', 'b'], spectatorSlots: 1, historyVisibility: 'all' });
  room.addSpectator('watcher');
  assert.throws(() => room.addSpectator('watcher2'), /full/);
  room.start();
  room.moveCoin(1, 'a');
  room.moveCoin(2, 'b');
  assert.equal(room.getPlayerView('a').players[1].coinHistory.length, 1);
  room.endGame = room.endGame.bind(room);
  room.phase = PHASES.SETTLEMENT;
  room.confirmRematch('a');
  assert.equal(room.phase, PHASES.SETTLEMENT);
  room.confirmRematch('b');
  assert.equal(room.phase, PHASES.ROUND_1_COINS);
  assert.ok(room.getReplay().some(event => event.type === 'SPECTATOR_JOINED'));
  assert.ok(room.getReplay().some(event => event.type === 'GAME_STARTED'));
});
