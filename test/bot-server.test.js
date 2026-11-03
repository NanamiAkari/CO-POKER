const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/server');

const BOT_TEST_OPTIONS = { coinDelayMs: 0, rematchDelayMs: 0, skipDelayMs: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const server = createServer({ port: 0, botOptions: BOT_TEST_OPTIONS });
  const address = await server.listen();
  t.after(() => server.close());
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const pending = [];
    const queue = [];
    ws.on('message', raw => {
      const value = JSON.parse(raw.toString());
      const index = pending.findIndex(waiter => waiter.type === value.type);
      if (index >= 0) {
        const waiter = pending.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else queue.push(value);
    });
    await new Promise(resolve => ws.once('open', resolve));
    const next = type => {
      const index = queue.findIndex(value => value.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 2500);
        pending.push(waiter);
      });
    };
    const request = (payload, type) => {
      const response = next(type);
      ws.send(JSON.stringify(payload));
      return response;
    };
    return { ws, next, request, clear: () => { queue.length = 0; } };
  };
  return { server, connect };
}

test('host adds and removes named bots before the start and guests cannot manage them', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const created = await host.request({ type: 'CREATE_ROOM', playerId: 'host' }, 'ROOM_CREATED');
  const roomId = created.roomId;

  const first = await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  assert.deepEqual(first.state.players.map(player => player.id), ['host', 'Robot Jack']);
  assert.deepEqual(first.state.bots, ['Robot Jack']);
  assert.ok(first.state.players.every(player => !('isBot' in player)), 'the wire state must not mark bots');

  const second = await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  assert.deepEqual(second.state.bots, ['Robot Jack', 'Robot Sam']);
  const third = await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  assert.deepEqual(third.state.bots, ['Robot Jack', 'Robot Sam', 'Robot Daniel']);
  assert.equal(third.state.players.length, 4);

  const guest = await f.connect();
  const joined = await guest.request({ type: 'JOIN_ROOM', playerId: 'guest', roomId }, 'ROOM_STATE');
  await host.next('ROOM_STATE');
  assert.deepEqual(joined.state.bots, [], 'only the host receives the bot roster');
  assert.ok(joined.state.players.some(player => player.id === 'Robot Jack'));

  const denied = await guest.request({ type: 'ADD_BOT', roomId }, 'ERROR');
  assert.match(denied.message, /Only host/);
  const deniedRemoval = await guest.request({ type: 'REMOVE_BOT', roomId, botId: 'Robot Jack' }, 'ERROR');
  assert.match(deniedRemoval.message, /Only host/);

  const removed = await host.request({ type: 'REMOVE_BOT', roomId, botId: 'Robot Sam' }, 'ROOM_STATE');
  await guest.next('ROOM_STATE');
  assert.deepEqual(removed.state.bots, ['Robot Jack', 'Robot Daniel']);
  assert.ok(!removed.state.players.some(player => player.id === 'Robot Sam'));

  const reAdded = await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  await guest.next('ROOM_STATE');
  assert.deepEqual(reAdded.state.bots, ['Robot Jack', 'Robot Daniel', 'Robot Sam']);

  await host.request({ type: 'START_GAME', roomId }, 'GAME_STARTED');
  await guest.next('GAME_STARTED');
  const afterStart = await host.request({ type: 'ADD_BOT', roomId }, 'ERROR');
  assert.match(afterStart.message, /before the game starts/);
});

test('bot names do not collide with players or spectators already in the room', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const created = await host.request({ type: 'CREATE_ROOM', playerId: 'Robot Jack', options: { spectatorSlots: 1 } }, 'ROOM_CREATED');
  const roomId = created.roomId;
  const spectator = await f.connect();
  await spectator.request({ type: 'JOIN_ROOM', playerId: 'Robot Sam', role: 'SPECTATOR', roomId }, 'ROOM_STATE');
  await host.next('ROOM_STATE');
  const added = await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  assert.deepEqual(added.state.bots, ['Robot Daniel']);
  const intruder = await f.connect();
  const denied = await intruder.request({ type: 'JOIN_ROOM', playerId: 'Robot Daniel', roomId }, 'ERROR');
  assert.match(denied.message, /already in use/);
});

test('seven bots fill the table and the honor ladder counts every seat', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const created = await host.request({
    type: 'CREATE_ROOM',
    playerId: 'host',
    options: { spectatorSlots: 1 }
  }, 'ROOM_CREATED');
  const roomId = created.roomId;

  for (let index = 0; index < 7; index += 1) {
    await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  }
  const full = await host.request({ type: 'ADD_BOT', roomId }, 'ERROR');
  assert.match(full.message, /full/);
  const room = f.server.manager.get(roomId);
  assert.equal(room.bots.length, 7);
  assert.deepEqual(room.bots.slice(0, 3), ['Robot Jack', 'Robot Sam', 'Robot Daniel']);

  const started = await host.request({ type: 'START_GAME', roomId }, 'GAME_STARTED');
  assert.equal(started.state.players.length, 8);
  assert.ok(started.state.players.every(player => !('isBot' in player)));

  const game = room.game;
  const deadline = Date.now() + 5000;
  while (!['SETTLEMENT', 'GAME_OVER'].includes(game.phase) && Date.now() < deadline) {
    if (game.phase.endsWith('_COINS')) {
      const self = game.players.find(player => player.id === 'host');
      if (self.currentCoin === null) {
        const free = [...game.coinTable.area][0];
        if (free !== undefined) host.ws.send(JSON.stringify({ type: 'MOVE_COIN', roomId, coin: free }));
      }
    }
    await sleep(10);
  }
  assert.ok(['SETTLEMENT', 'GAME_OVER'].includes(game.phase), 'the match reaches settlement without stalling');
  assert.equal(game.players.length, 8);
  assert.ok(game.players.filter(player => player.isBot).length === 7);
  assert.ok(game.players.every(player => player.coinHistory.length === 4));
  assert.ok(game.players.every(player => player.coinHistory.every(coin => Number.isInteger(coin))));

  const spectator = await f.connect();
  const watched = await spectator.request({ type: 'JOIN_ROOM', playerId: 'watcher', role: 'SPECTATOR', roomId }, 'ROOM_STATE');
  assert.equal(watched.state.lifetimeStats.length, 8);
  for (const botName of ['Robot Jack', 'Robot Sam', 'Robot Daniel']) {
    const stats = watched.state.lifetimeStats.find(item => item.playerId === botName);
    assert.ok(stats, `${botName} appears on the honor ladder`);
    assert.ok(stats.correct + stats.wrong >= 1);
  }
  assert.ok(watched.state.lifetimeStats.every(item => !('isBot' in item)));

  // A human skip vote is enough to wake the bots; they must then follow it.
  host.ws.send(JSON.stringify({ type: 'SKIP_COMPARISON', roomId }));
  await waitFor(() => game.comparisonSkip);
  assert.equal(game.comparisonSkipVotes.size, 8);

  // Bots only join a rematch after the host has confirmed, then the next
  // series starts without another human click.
  host.ws.send(JSON.stringify({ type: 'REMATCH', roomId }));
  await waitFor(() => game.phase === 'ROUND_1_COINS');
  assert.equal(game.successCount + game.failureCount, 1);
  assert.equal(game.rematchConfirmed.size, 0);
});

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), 'condition was not reached before the timeout');
}

test('bots accept social actions such as tomatoes like any other player', async t => {
  const f = await fixture(t);
  const host = await f.connect();
  const created = await host.request({ type: 'CREATE_ROOM', playerId: 'host' }, 'ROOM_CREATED');
  const roomId = created.roomId;
  await host.request({ type: 'ADD_BOT', roomId }, 'ROOM_STATE');
  const lobbyTomato = await host.request({ type: 'THROW_TOMATO', roomId, targetPlayerId: 'Robot Jack' }, 'TOMATO_THROW');
  assert.equal(lobbyTomato.action.toPlayerId, 'Robot Jack');

  await host.request({ type: 'START_GAME', roomId }, 'GAME_STARTED');

  const tomato = await host.request({ type: 'THROW_TOMATO', roomId, targetPlayerId: 'Robot Jack' }, 'TOMATO_THROW');
  assert.equal(tomato.action.fromPlayerId, 'host');
  assert.equal(tomato.action.toPlayerId, 'Robot Jack');

  const unknown = await host.request({ type: 'THROW_TOMATO', roomId, targetPlayerId: 'Nobody' }, 'TOMATO_ERROR');
  assert.equal(unknown.code, 'TOMATO_UNKNOWN_TARGET');

  const self = await host.request({ type: 'THROW_TOMATO', roomId, targetPlayerId: 'host' }, 'TOMATO_ERROR');
  assert.equal(self.code, 'TOMATO_SELF_TARGET');
});
