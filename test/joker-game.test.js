const test = require('node:test');
const assert = require('node:assert/strict');
const { GameRoom, PHASES } = require('../src/game');
const { compareHands } = require('../src/poker');

// Keep the regular cards in order while shuffling one joker into the first
// player's hand and the other into the first unrevealed community position.
function jokerDealRandom(handCardCount, holeJoker) {
  let index = 53;
  return () => {
    const destination = index === 53 ? (holeJoker === 'black' ? 0 : 2 * handCardCount)
      : index === 52 ? (holeJoker === 'red' ? 0 : 2 * handCardCount) : index;
    return (destination + 0.5) / (--index + 2);
  };
}

test('joker room option is off by default and requires a real boolean', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  room.start();
  assert.equal(room.includeJokers, false);
  assert.equal(room.deck.length, 48);
  assert.ok([...room.deck, ...room.players.flatMap(player => player.holeCards)].every(card => !card.joker));
  for (const includeJokers of [null, 'true', 'false', 0, 1, [], {}]) {
    assert.throws(() => new GameRoom({ players: ['a', 'b'], includeJokers }), /includeJokers must be a boolean/);
  }
});

test('joker setting changes only between full games, resets votes, and persists across rematches', () => {
  const room = new GameRoom({ players: ['a', 'b'] });
  assert.throws(() => room.updateOptions({ includeJokers: true }), /after game over/);
  room.phase = PHASES.GAME_OVER;
  room.rematchConfirmed.add('a');
  for (const includeJokers of [null, undefined, 'true', 0]) {
    assert.throws(() => room.updateOptions({ includeJokers }), /includeJokers must be a boolean/);
    assert.equal(room.includeJokers, false);
    assert.deepEqual([...room.rematchConfirmed], ['a']);
  }
  assert.equal(room.updateOptions({ includeJokers: true }).includeJokers, true);
  assert.deepEqual([...room.rematchConfirmed], []);
  assert.equal(room.updateOptions({ historyVisibility: 'self' }).includeJokers, true);
  const event = room.getReplay().find(entry => entry.type === 'ROOM_OPTIONS_UPDATED');
  assert.equal(event.payload.options.includeJokers, true);
  room.confirmRematch('a'); room.confirmRematch('b');
  assert.equal(room.deck.length, 50);
  assert.equal([...room.deck, ...room.players.flatMap(player => player.holeCards)].filter(card => card.joker).length, 2);
  room.phase = PHASES.SETTLEMENT;
  room.confirmRematch('a'); room.confirmRematch('b');
  assert.equal(room.deck.length, 50);
  room.phase = PHASES.GAME_OVER;
  room.updateOptions({ includeJokers: false });
  room.confirmRematch('a'); room.confirmRematch('b');
  assert.equal(room.deck.length, 48);
});

for (const [handCardCount, handUsageRule] of [[2, 'any'], [3, 'any'], [3, 'all-hole']]) {
  for (const holeJoker of ['red', 'black']) {
    test(`deals ${holeJoker} joker privately and the other publicly: ${handCardCount} cards / ${handUsageRule}`, () => {
      const communityJoker = holeJoker === 'red' ? 'black' : 'red';
      const room = new GameRoom({ players: ['a', 'b'], handCardCount, handUsageRule, includeJokers: true, random: jokerDealRandom(handCardCount, holeJoker) });
      room.start();
      assert.deepEqual(room.players[0].holeCards[0], { joker: holeJoker });
      assert.deepEqual(room.deck[0], { joker: communityJoker });
      assert.equal(room.deck.length, 54 - 2 * handCardCount);
      assert.deepEqual(room.getPlayerView('a').communityCards, []);
      assert.equal(room.getPlayerView('a').ownEstimatedHand, null);
      assert.ok(!JSON.stringify(room.getPlayerView('b')).includes('joker'));
      for (let round = 0; round < 3; round++) {
        room.moveCoin(1, 'a'); room.moveCoin(2, 'b');
        assert.equal(room.communityCards.length, round + 3);
        assert.deepEqual(room.communityCards[0], { joker: communityJoker });
        for (const id of ['a', 'b']) {
          const hand = room.getPlayerView(id).ownEstimatedHand;
          assert.equal(hand.cards.length, 5);
          assert.ok(hand.tiebreak.every(Number.isFinite));
          for (const card of hand.cards.filter(card => card.joker)) {
            assert.ok((card.joker === 'red' ? ['d', 'h'] : ['c', 's']).includes(card.suit));
          }
        }
      }
      if (handUsageRule === 'all-hole') {
        const hand = room.getPlayerView('a').ownEstimatedHand;
        assert.ok(hand.cards.some(card => card.joker === holeJoker));
        for (const card of room.players[0].holeCards.filter(card => !card.joker)) {
          assert.ok(hand.cards.some(selected => selected.rank === card.rank && selected.suit === card.suit && !selected.joker));
        }
      }
      const aIsStronger = compareHands(room.getPlayerView('a').ownEstimatedHand, room.getPlayerView('b').ownEstimatedHand) >= 0;
      room.moveCoin(aIsStronger ? 1 : 2, 'a'); room.moveCoin(aIsStronger ? 2 : 1, 'b');
      assert.equal(room.phase, PHASES.SETTLEMENT);
      assert.equal(room.lastResult.success, true);
      assert.equal(room.lastResult.comparisons.length, 1);
      assert.equal(room.successCount, 1);
      assert.deepEqual(room.players[0].holeCards[0], { joker: holeJoker });
      assert.deepEqual(room.communityCards[0], { joker: communityJoker });
    });
  }
}
