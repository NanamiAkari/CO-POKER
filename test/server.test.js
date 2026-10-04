const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/server');
const open = ws => new Promise(resolve => ws.once('open', resolve));
const message = ws => new Promise(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))));

async function fixture(t, serverOptions = {}) {
  const server = createServer({ ...serverOptions, port: 0 });
  const address = await server.listen();
  t.after(() => server.close());
  const connect = async (clientOptions = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`, clientOptions);
    const pending = [], queue = [];
    ws.on('message', raw => {
      const value = JSON.parse(raw.toString());
      const index = pending.findIndex(waiter => waiter.type === value.type);
      if (index >= 0) { const waiter = pending.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); }
      else queue.push(value);
    });
    await open(ws);
    const next = type => {
      const index = queue.findIndex(value => value.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: null };
        waiter.timer = setTimeout(() => { pending.splice(pending.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${type}`)); }, 2000);
        pending.push(waiter);
      });
    };
    return { ws, next, clear: () => { queue.length = 0; }, request: (payload, type) => { const response = next(type); ws.send(JSON.stringify(payload)); return response; } };
  };
  const room = async options => {
    const host = await connect();
    const created = await host.request({ type: 'CREATE_ROOM', playerId: 'a', options }, 'ROOM_CREATED');
    const guest = await connect();
    await guest.request({ type: 'JOIN_ROOM', playerId: 'b', roomId: created.roomId }, 'ROOM_STATE');
    await host.next('ROOM_STATE');
    return { host, guest, roomId: created.roomId };
  };
  const start = async ({ host, guest, roomId }) => {
    const result = await host.request({ type: 'START_GAME', roomId }, 'GAME_STARTED');
    await guest.next('GAME_STARTED');
    return result;
  };
  const coinRound = async ({ host, guest, roomId }) => {
    await host.request({ type: 'MOVE_COIN', coin: 1, roomId }, 'ROOM_STATE'); await guest.next('ROOM_STATE');
    const result = await guest.request({ type: 'MOVE_COIN', coin: 2, roomId }, 'ROOM_STATE'); await host.next('ROOM_STATE');
    return result;
  };
  return { server, connect, room, start, coinRound };
}

test('supports room creation, player join, spectator join, and spectator protection', async () => {
  const server = createServer({ port: 0 }); const address = await server.listen(); const url = `ws://127.0.0.1:${address.port}`;
  const host = new WebSocket(url); await open(host); host.send(JSON.stringify({ type: 'CREATE_ROOM', playerId: 'a', options: { spectatorSlots: 1 } })); const created = await message(host);
  const guest = new WebSocket(url); await open(guest); guest.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: created.roomId, playerId: 'b' })); await message(host);
  const watcher = new WebSocket(url); await open(watcher); watcher.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: created.roomId, playerId: 'w', role: 'SPECTATOR' })); await message(host); await message(watcher);
  watcher.send(JSON.stringify({ type: 'MOVE_COIN', roomId: created.roomId, coin: 1 })); assert.equal((await message(watcher)).type, 'ERROR');
  host.terminate(); guest.terminate(); watcher.terminate();
  server.wss.clients.forEach(client => client.terminate());
  await server.close();
});

test('broadcasts coin movement metadata for client flight animations', async () => {
  const server = createServer({ port: 0 }); const address = await server.listen(); const url = `ws://127.0.0.1:${address.port}`;
  const host = new WebSocket(url); await open(host); host.send(JSON.stringify({ type: 'CREATE_ROOM', playerId: 'a' })); const created = await message(host);
  const guest = new WebSocket(url); await open(guest); guest.send(JSON.stringify({ type: 'JOIN_ROOM', roomId: created.roomId, playerId: 'b' })); await Promise.all([message(host), message(guest)]);
  host.send(JSON.stringify({ type: 'START_GAME', roomId: created.roomId, playerId: 'a' })); await Promise.all([message(host), message(guest)]);
  host.send(JSON.stringify({ type: 'MOVE_COIN', roomId: created.roomId, playerId: 'a', coin: 1 }));
  const [hostMove, guestMove] = await Promise.all([message(host), message(guest)]);
  for (const event of [hostMove, guestMove]) { assert.deepEqual(event.coinAction, { type: 'MOVE', coin: 1, fromPlayerId: null, toPlayerId: 'a' }); }
  host.terminate(); guest.terminate(); await server.close();
});

test('validates room options and publishes authoritative menu state', async t => {
  const f = await fixture(t); const host = await f.connect();
  for (const options of [{handCardCount:4}, {handCardCount:'3'}, {handUsageRule:'bad'}, {historyVisibility:'bad'}, {spectatorSlots:-1}, {spectatorSlots:9}, {spectatorSlots:0.5}, {players:['injected']}, null]) {
    assert.equal((await host.request({type:'CREATE_ROOM', playerId:'a', options}, 'ERROR')).type, 'ERROR');
    assert.equal(f.server.manager.rooms.size, 0);
  }
  const options = {handCardCount:3, handUsageRule:'all-hole', historyVisibility:'self', spectatorSlots:8};
  const result = await host.request({type:'CREATE_ROOM', playerId:'a', options}, 'ROOM_CREATED');
  assert.deepEqual(result.state.options, options);
  assert.equal(result.state.hostId, 'a');
  assert.equal(result.state.successCount, 0); assert.equal(result.state.failureCount, 0);
  assert.deepEqual(result.state.rematchConfirmed, []);
  assert.equal((await host.request({type:'CREATE_ROOM', playerId:'second'}, 'ERROR')).type, 'ERROR');
  assert.equal(f.server.manager.rooms.size, 1);
});

test('rejects duplicate names and a sixth player without changing membership', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:1});
  const newcomer = await f.connect();
  const duplicate = await newcomer.request({type:'JOIN_ROOM', playerId:' a ', roomId:r.roomId}, 'ERROR');
  assert.match(duplicate.message, /already in use/);
  for (const id of ['c','d','e']) {
    const client = await f.connect();
    await client.request({type:'JOIN_ROOM', playerId:id, roomId:r.roomId}, 'ROOM_STATE');
  }
  const full = await newcomer.request({type:'JOIN_ROOM', playerId:'f', roomId:r.roomId}, 'ERROR');
  assert.match(full.message, /full/);
  assert.equal(f.server.manager.get(r.roomId).clients.size, 5);
});

test('protects all room actions from cross-room and unjoined connections', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:1}); await f.start(r);
  const attacker = await f.connect();
  await attacker.request({type:'CREATE_ROOM', playerId:'a'}, 'ROOM_CREATED');
  const unjoined = await f.connect();
  for (const client of [attacker, unjoined]) {
    for (const type of ['START_GAME','MOVE_COIN','RETURN_COIN','GET_REPLAY','REMATCH','END_GAME','LEAVE_ROOM']) {
      const error = await client.request({type, roomId:r.roomId, playerId:'a', coin:1}, 'ERROR');
      assert.match(error.message, /Not a member/);
    }
  }
  const repeated = await r.host.request({type:'START_GAME', roomId:r.roomId}, 'ERROR');
  assert.match(repeated.message, /already started/);
  assert.equal(f.server.manager.get(r.roomId).game.phase, 'ROUND_1_COINS');
});

test('lobby leave transfers host and permits the same connection to create a new room', async t => {
  const f = await fixture(t); const r = await f.room();
  assert.equal((await r.host.request({type:'LEAVE_ROOM',roomId:r.roomId}, 'ROOM_LEFT')).roomId, r.roomId);
  assert.equal((await r.guest.next('ROOM_STATE')).state.hostId, 'b');
  assert.equal(f.server.manager.get(r.roomId).clients.size, 1);
  await r.host.request({type:'CREATE_ROOM',playerId:'a'}, 'ROOM_CREATED');
  await r.guest.request({type:'LEAVE_ROOM',roomId:r.roomId}, 'ROOM_LEFT');
  assert.equal(f.server.manager.get(r.roomId), undefined);
});

test('active player leave ends the room but spectator leave does not', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:1});
  const spectator = await f.connect();
  await spectator.request({type:'JOIN_ROOM',playerId:'watcher',role:'SPECTATOR',roomId:r.roomId}, 'ROOM_STATE');
  await r.host.next('ROOM_STATE'); await r.guest.next('ROOM_STATE');
  await f.start(r); await spectator.next('GAME_STARTED');
  await spectator.request({type:'LEAVE_ROOM',roomId:r.roomId}, 'ROOM_LEFT');
  await r.host.next('ROOM_STATE'); await r.guest.next('ROOM_STATE');
  assert.ok(f.server.manager.get(r.roomId));
  await r.host.request({type:'LEAVE_ROOM',roomId:r.roomId}, 'ROOM_LEFT');
  assert.equal((await r.guest.next('ROOM_ENDED')).reason, 'PLAYER_LEFT');
  assert.equal(f.server.manager.get(r.roomId), undefined);
  await r.guest.request({type:'CREATE_ROOM',playerId:'b'}, 'ROOM_CREATED');
});

test('server filters histories and estimates across each visibility mode', async t => {
  const f = await fixture(t);
  for (const historyVisibility of ['all', 'self', 'none']) {
    const r = await f.room({historyVisibility,spectatorSlots:1,handCardCount:3,handUsageRule:'all-hole'});
    const spectator = await f.connect();
    await spectator.request({type:'JOIN_ROOM',playerId:'watcher',role:'SPECTATOR',roomId:r.roomId}, 'ROOM_STATE');
    await r.host.next('ROOM_STATE'); await r.guest.next('ROOM_STATE');
    const begun = await f.start(r); await spectator.next('GAME_STARTED');
    assert.equal(begun.state.ownEstimatedHand, null);
    assert.equal(begun.state.ownHoleCards.length, 3);
    const next = await f.coinRound(r);
    await spectator.next('ROOM_STATE'); const watched = await spectator.next('ROOM_STATE');
    assert.equal(next.state.communityCards.length, 3);
    assert.equal(next.state.ownEstimatedHand.cards.length, 5);
    assert.deepEqual(next.state.coinHistory, historyVisibility === 'none' ? [] : [2]);
    assert.deepEqual(next.state.players[0].coinHistory, historyVisibility === 'all' ? [1] : []);
    assert.deepEqual(next.state.players[1].coinHistory, historyVisibility === 'none' ? [] : [2]);
    assert.deepEqual(watched.state.ownHoleCards, []); assert.equal(watched.state.ownEstimatedHand, null);
    assert.deepEqual(watched.state.players[0].coinHistory, historyVisibility === 'all' ? [1] : []);
    const replay = await spectator.request({type:'GET_REPLAY',roomId:r.roomId}, 'REPLAY_DATA');
    if (historyVisibility !== 'all') {
      assert.ok(!replay.events.some(event => event.type === 'COIN_MOVED'));
      assert.ok(replay.events.every(event => !event.payload.coinHistory?.length));
    }
  }
});

test('four rounds, immutable settlement, rematch votes, and END_GAME close the full menu loop', async t => {
  const f = await fixture(t); const r = await f.room(); await f.start(r);
  let result;
  for (let round = 0; round < 4; round++) result = await f.coinRound(r);
  assert.equal(result.state.phase, 'SETTLEMENT');
  assert.equal(result.state.successCount + result.state.failureCount, 1);
  assert.equal(result.state.result.comparisons.length, 1);
  assert.match((await r.host.request({type:'RETURN_COIN',coin:1,roomId:r.roomId}, 'ERROR')).message, /closed/);
  const vote = await r.host.request({type:'REMATCH',roomId:r.roomId}, 'ROOM_STATE'); await r.guest.next('ROOM_STATE');
  assert.deepEqual(vote.state.rematchConfirmed, ['a']); assert.equal(vote.state.phase, 'SETTLEMENT');
  const rematch = await r.guest.request({type:'REMATCH',roomId:r.roomId}, 'ROOM_STATE'); await r.host.next('ROOM_STATE');
  assert.equal(rematch.state.phase, 'ROUND_1_COINS');
  assert.equal(rematch.state.successCount + rematch.state.failureCount, 1);
  for (let round = 0; round < 4; round++) await f.coinRound(r);
  const ended = await r.host.request({type:'END_GAME',roomId:r.roomId}, 'ROOM_ENDED');
  assert.equal(ended.reason, 'GAME_ENDED'); await r.guest.next('ROOM_ENDED');
  assert.equal(f.server.manager.get(r.roomId), undefined);
  await r.host.request({type:'CREATE_ROOM',playerId:'a'}, 'ROOM_CREATED');
});

test('only the host can update validated room options after GAME_OVER', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:2});
  const game = f.server.manager.get(r.roomId).game = new (require('../src/game').GameRoom)({players:['a','b'], spectatorSlots:2});
  game.phase = 'GAME_OVER'; game.rematchConfirmed.add('a');
  const denied = await r.guest.request({type:'UPDATE_ROOM_OPTIONS',roomId:r.roomId,options:{handCardCount:3}}, 'ERROR');
  assert.match(denied.message, /Only host/);
  const updated = await r.host.request({type:'UPDATE_ROOM_OPTIONS',roomId:r.roomId,options:{handCardCount:3,handUsageRule:'all-hole',historyVisibility:'self',spectatorSlots:4}}, 'ROOM_OPTIONS_UPDATED');
  await r.guest.next('ROOM_OPTIONS_UPDATED');
  assert.deepEqual(updated.state.options, {handCardCount:3,handUsageRule:'all-hole',historyVisibility:'self',spectatorSlots:4});
  assert.equal(updated.state.successCount, 0); assert.equal(updated.state.failureCount, 0);
  assert.deepEqual(updated.state.rematchConfirmed, []);
  assert.equal(f.server.manager.get(r.roomId).game.handCardCount, 3);
});

test('room option updates reject active phases, cross-room requests, and spectator overflow', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:1});
  const active = await r.host.request({type:'UPDATE_ROOM_OPTIONS',roomId:r.roomId,options:{handCardCount:3}}, 'ERROR');
  assert.match(active.message, /after game over/);
  const outsider = await f.connect(); await outsider.request({type:'CREATE_ROOM',playerId:'outsider'}, 'ROOM_CREATED');
  const cross = await outsider.request({type:'UPDATE_ROOM_OPTIONS',roomId:r.roomId,options:{handCardCount:3}}, 'ERROR');
  assert.match(cross.message, /Not a member/);
  const room = f.server.manager.get(r.roomId); room.game = new (require('../src/game').GameRoom)({players:['a','b'], spectatorSlots:1}); room.game.phase = 'GAME_OVER';
  room.spectators.push('watcher');
  const overflow = await r.host.request({type:'UPDATE_ROOM_OPTIONS',roomId:r.roomId,options:{spectatorSlots:0}}, 'ERROR');
  assert.match(overflow.message, /Spectator positions are full/);
});

test('SKIP_COMPARISON is player-only, requires settlement, and broadcasts all votes', async t => {
  const f = await fixture(t); const r = await f.room({spectatorSlots:1});
  const active = await r.host.request({type:'SKIP_COMPARISON',roomId:r.roomId}, 'ERROR');
  assert.match(active.message, /Game has not started/);
  const spectator = await f.connect();
  const roomState = await spectator.request({type:'JOIN_ROOM',playerId:'watcher',role:'SPECTATOR',roomId:r.roomId}, 'ROOM_STATE');
  await r.host.next('ROOM_STATE'); await r.guest.next('ROOM_STATE');
  const game = f.server.manager.get(r.roomId).game = new (require('../src/game').GameRoom)({players:['a','b']});
  game.phase = 'SETTLEMENT'; game.lastResult = {success:true,comparisons:[]};
  const denied = await spectator.request({type:'SKIP_COMPARISON',roomId:r.roomId}, 'ERROR');
  assert.match(denied.message, /Spectators cannot/);
  const first = await r.host.request({type:'SKIP_COMPARISON',roomId:r.roomId}, 'ROOM_STATE'); await r.guest.next('ROOM_STATE');
  assert.deepEqual(first.state.comparisonSkipVotes, ['a']); assert.equal(first.state.comparisonSkip, false);
  const duplicate = await r.host.request({type:'SKIP_COMPARISON',roomId:r.roomId}, 'ROOM_STATE'); await r.guest.next('ROOM_STATE');
  assert.deepEqual(duplicate.state.comparisonSkipVotes, ['a']);
  const complete = await r.guest.request({type:'SKIP_COMPARISON',roomId:r.roomId}, 'ROOM_STATE'); await r.host.next('ROOM_STATE');
  assert.deepEqual(complete.state.comparisonSkipVotes.sort(), ['a','b']); assert.equal(complete.state.comparisonSkip, true);
});

test('protocol heartbeat keeps an idle client alive without game actions', {timeout: 3000}, async t => {
  const f = await fixture(t, {heartbeatIntervalMs: 40});
  const client = await f.connect();
  for (let round = 0; round < 3; round++) await new Promise(resolve => client.ws.once('ping', resolve));
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  const created = await client.request({type:'CREATE_ROOM', playerId:'idle'}, 'ROOM_CREATED');
  assert.equal(created.state.hostId, 'idle');
});

test('heartbeat closes unresponsive connections and releases room membership', {timeout: 3000}, async t => {
  const f = await fixture(t, {heartbeatIntervalMs: 50});
  const client = await f.connect({autoPong:false});
  const closed = new Promise(resolve => client.ws.once('close', resolve));
  const created = await client.request({type:'CREATE_ROOM', playerId:'silent'}, 'ROOM_CREATED');
  const serverPeer = f.server.manager.get(created.roomId).clients.get('silent');
  const serverClosed = new Promise(resolve => serverPeer.once('close', resolve));
  await Promise.all([closed, serverClosed]);
  assert.equal(client.ws.readyState, WebSocket.CLOSED);
  assert.equal(f.server.manager.get(created.roomId), undefined);
});

test('oversized websocket messages close only that connection and server remains usable', {timeout: 3000}, async t => {
  const f = await fixture(t);
  const oversized = await f.connect();
  const closed = new Promise(resolve => oversized.ws.once('close', code => resolve(code)));
  oversized.ws.send('x'.repeat(16 * 1024 + 1));
  assert.equal(await closed, 1009);
  const healthy = await f.connect();
  const created = await healthy.request({type:'CREATE_ROOM', playerId:'healthy'}, 'ROOM_CREATED');
  assert.equal(created.state.hostId, 'healthy');
});
