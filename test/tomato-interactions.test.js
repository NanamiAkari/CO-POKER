const test = require('node:test');
const assert = require('node:assert/strict');
const TomatoInteractions = require('../public/tomato-interactions');

function clock() {
  let now = 1000, serial = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++serial; tasks.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      const due = now + ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= due).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; tasks.delete(next[0]); next[1].fn();
      }
      now = due;
    }
  };
}

test('sendTomato emits an independent TOMATO_THROW action', () => {
  const sent = [], timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, send: payload => sent.push(payload), setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  const action = controller.sendTomato('Bob');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'TOMATO_THROW');
  assert.equal(sent[0].roomId, 'ABC123');
  assert.deepEqual(sent[0].action, action);
  assert.equal(action.fromPlayerId, 'Alice');
  assert.equal(action.toPlayerId, 'Bob');
  assert.equal(controller.sendTomato('Alice'), false);
  assert.equal(controller.sendTomato(''), false);
});

test('sendTomato unwraps Vue-style ref getters', () => {
  const sent = [];
  const roomId = {}; Object.defineProperty(roomId, 'value', { get: () => 'REF123' });
  const playerId = {}; Object.defineProperty(playerId, 'value', { get: () => 'Alice' });
  const controller = TomatoInteractions.create({ roomId, playerId, send: payload => sent.push(payload) });
  assert.equal(controller.sendTomato('Bob').fromPlayerId, 'Alice');
  assert.equal(sent[0].roomId, 'REF123');
});

test('handleTomatoMessage validates room and deduplicates action ids', () => {
  const timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  const message = { type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-1', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 1000 } };
  assert.deepEqual(controller.handleTomatoMessage(message), message.action);
  assert.equal(controller.handleTomatoMessage(message), false);
  assert.equal(controller.handleTomatoMessage({ ...message, roomId: 'OTHER', action: { ...message.action, actionId: 'throw-2' } }), false);
  assert.deepEqual(controller.handleTomatoMessage({ ...message, action: { ...message.action, actionId: 'throw-3', fromPlayerId: 'Alice', toPlayerId: 'Bob' } }), { ...message.action, actionId: 'throw-3', fromPlayerId: 'Alice', toPlayerId: 'Bob' });
  assert.equal(controller.tomatoFlights.length, 2);
});

test('flights clean up after the flight and impact windows and reset cancels them', () => {
  const timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, flightMs: 900, impactMs: 240, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  controller.handleTomatoMessage({ type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-1', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 1000 } });
  assert.equal(controller.tomatoFlights.length, 1);
  timer.advance(899);
  assert.equal(controller.tomatoFlights.length, 1);
  timer.advance(341);
  assert.equal(controller.tomatoFlights.length, 0);
  controller.handleTomatoMessage({ type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-2', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 2200 } });
  controller.reset();
  assert.equal(controller.tomatoFlights.length, 0);
});
