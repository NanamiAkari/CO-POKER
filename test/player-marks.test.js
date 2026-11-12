const test = require('node:test');
const assert = require('node:assert/strict');
const Vue = require('vue');
const PlayerMarks = require('../public/player-marks');

function fixture(options = {}) {
  const storageData = new Map();
  const storage = {
    getItem: key => storageData.get(key) ?? null,
    setItem: (key, value) => storageData.set(key, String(value))
  };
  const roomId = Vue.ref(options.roomId || 'ROOM1');
  const playerId = Vue.ref(options.playerId || 'A');
  const handCount = Vue.computed(() => options.handCount || 2);
  const includeJokers = Vue.computed(() => options.includeJokers === true);
  const store = PlayerMarks.create({ Vue, storage, roomId, playerId, handCount, includeJokers, now: () => 1000 });
  return { store, storage, storageData, roomId, playerId };
}

test('private marks save, prefill, overwrite and clear locally', () => {
  const { store, storageData } = fixture();
  assert.equal(store.hasMark('B'), false);
  store.openMark('B');
  assert.equal(store.markDraftEmpty.value, true);
  store.markDraft.category = '一对';
  assert.equal(store.markDraftEmpty.value, false);
  store.markDraft.cards = [{ rank: 14, suit: 's' }];
  const saved = store.saveMark();
  assert.equal(saved.category, '一对');
  assert.equal(saved.note, undefined);
  assert.deepEqual(store.guessCardsFor('B'), [{ rank: 14, suit: 's' }]);
  assert.equal(store.markSummary('B'), 'A♠');
  assert.ok(storageData.get('poker.privateMarks.v1'));

  store.openMark('B');
  assert.equal(store.markDraft.category, '一对');
  store.markDraft.category = '两对';
  store.markDraft.cards = [{ rank: 13, suit: 'h' }, { rank: 13, suit: 'c' }];
  store.saveMark();
  assert.equal(store.markFor('B').category, '两对');
  assert.deepEqual(store.guessCardsFor('B'), [{ rank: 13, suit: 'h' }, { rank: 13, suit: 'c' }]);

  store.clearMark('B');
  assert.equal(store.hasMark('B'), false);
  assert.deepEqual(store.guessCardsFor('B'), []);
});

test('marks are sanitized, capped and scoped to room and viewer', () => {
  const { store, roomId, playerId } = fixture({ handCount: 2 });
  store.openMark('B');
  store.markDraft.category = '不存在的牌型';
  store.markDraft.cards = [
    { rank: 14, suit: 's' },
    { rank: 14, suit: 's' },
    { rank: 13, suit: 'h' },
    { rank: 12, suit: 'c' },
    { rank: 99, suit: 'x' }
  ];
  const saved = store.saveMark();
  assert.equal(saved.category, '');
  assert.deepEqual(saved.cards, [{ rank: 14, suit: 's' }, { rank: 13, suit: 'h' }]);

  store.playerId = undefined;
  playerId.value = 'C';
  assert.equal(store.hasMark('B'), false, 'another viewer cannot see the first viewer\'s mark');
  playerId.value = 'A';
  assert.equal(store.hasMark('B'), true, 'the owner sees the mark again');
  roomId.value = 'ROOM2';
  assert.equal(store.hasMark('B'), false, 'a different room starts clean');
});

test('marks persist across a fresh store and clear on room reset', () => {
  const first = fixture();
  first.store.openMark('B');
  first.store.markDraft.category = '同花';
  first.store.markDraft.cards = [{ rank: 10, suit: 's' }, { rank: 9, suit: 's' }];
  first.store.saveMark();
  // Clear the watcher-only memory by creating a new store over the same refs/storage.
  const second = PlayerMarks.create({
    Vue,
    storage: first.storage,
    roomId: first.roomId,
    playerId: first.playerId,
    handCount: Vue.computed(() => 2),
    includeJokers: Vue.computed(() => false)
  });
  assert.equal(second.markFor('B').category, '同花');
  assert.deepEqual(second.guessCardsFor('B'), [{ rank: 10, suit: 's' }, { rank: 9, suit: 's' }]);
  second.resetRoom();
  const third = PlayerMarks.create({
    Vue,
    storage: first.storage,
    roomId: first.roomId,
    playerId: first.playerId,
    handCount: Vue.computed(() => 2),
    includeJokers: Vue.computed(() => false)
  });
  assert.equal(third.hasMark('B'), false);
});

test('jokers are only available when the room uses them', () => {
  const plain = fixture({ handCount: 3, includeJokers: false });
  plain.store.openMark('B');
  plain.store.toggleMarkCard({ joker: 'red' });
  assert.deepEqual(plain.store.markDraft.cards, []);
  plain.store.markDraft.category = '高牌';
  plain.store.saveMark();
  assert.equal(plain.store.markFor('B').category, '高牌');

  const jokers = fixture({ handCount: 3, includeJokers: true });
  jokers.store.openMark('B');
  assert.equal(jokers.store.toggleMarkCard({ joker: 'red' }), true);
  assert.equal(jokers.store.toggleMarkCard({ joker: 'black' }), true);
  assert.equal(jokers.store.toggleMarkCard({ joker: 'red' }), true, 'clicking the same joker removes it');
  assert.deepEqual(jokers.store.markDraft.cards, [{ joker: 'black' }]);
  assert.equal(jokers.store.toggleMarkCard({ rank: 14, suit: 's' }), true);
  assert.equal(jokers.store.markDraft.cards.length, 2);
  assert.equal(jokers.store.markDeckCards.value.length, 54);
  assert.equal(jokers.store.markHasCard({ rank: 14, suit: 's' }), true);
  assert.equal(jokers.store.markHasCard({ rank: 13, suit: 's' }), false);
  jokers.store.saveMark();
  assert.equal(jokers.store.markFor('B').cards.length, 2);
});


test('a legacy note-only mark is ignored because notes are no longer supported', () => {
  assert.equal(PlayerMarks.sanitizeMark({ note: '旧的备注内容' }, 2, false), null);
  const { store } = fixture();
  store.openMark('B');
  store.markDraft.note = '不会保存';
  assert.equal(store.saveMark(), null);
  assert.equal(store.hasMark('B'), false);
});
