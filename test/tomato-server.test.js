const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer, RoomManager } = require('../src/server');

async function fixture(t, options = {}) {
  const server = createServer(options);
  const address = await server.listen();
  t.after(() => server.close());
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const pending = [], queue = [];
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      const index = pending.findIndex(waiter => waiter.type === event.type);
      if (index < 0) return queue.push(event);
      const waiter = pending.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = type => {
      const index = queue.findIndex(event => event.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve };
        waiter.timer = setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 1000);
        pending.push(waiter);
      });
    };
    return { ws, queue, next, request(payload, type) { const response = next(type); ws.send(JSON.stringify(payload)); return response; } };
  };
  const room = async (name, roomOptions = {}) => {
    const host = await connect();
    const created = await host.request({ type: 'CREATE_ROOM', playerId: name, options: roomOptions }, 'ROOM_CREATED');
    return { roomId: created.roomId, members: [host], host };
  };
  const join = async (room, id, role = 'PLAYER') => {
    const client = await connect();
    const joined = client.request({ type: 'JOIN_ROOM', roomId: room.roomId, playerId: id, role }, 'ROOM_STATE');
    for (const member of room.members) await member.next('ROOM_STATE');
    await joined;
    room.members.push(client);
    return client;
  };
  return { server, connect, room, join };
}

test('THROW_TOMATO broadcasts one transient action to every member in the room', async t => {
  const f = await fixture(t, { manager: new RoomManager({ tomatoOptions: { now: () => 123456 } }) });
  const room = await f.room('alice', { spectatorSlots: 1 });
  const bob = await f.join(room, 'bob');
  const watcher = await f.join(room, 'watcher', 'SPECTATOR');
  const elsewhere = await f.room('other');

  room.host.ws.send(JSON.stringify({
    type: 'THROW_TOMATO', roomId: room.roomId, targetPlayerId: 'bob',
    fromPlayerId: 'forged', timestamp: 1, actionId: 'forged'
  }));
  const [hostEvent, bobEvent, watcherEvent] = await Promise.all([
    room.host.next('TOMATO_THROW'), bob.next('TOMATO_THROW'), watcher.next('TOMATO_THROW')
  ]);
  assert.deepEqual(hostEvent, bobEvent);
  assert.deepEqual(hostEvent, watcherEvent);
  assert.equal(hostEvent.roomId, room.roomId);
  assert.deepEqual(Object.keys(hostEvent.action).sort(), ['actionId', 'fromPlayerId', 'timestamp', 'toPlayerId'].sort());
  assert.match(hostEvent.action.actionId, /^tomato-[0-9a-f]{18}$/);
  assert.equal(hostEvent.action.fromPlayerId, 'alice');
  assert.equal(hostEvent.action.toPlayerId, 'bob');
  assert.equal(hostEvent.action.timestamp, 123456);
  assert.equal(room.host.queue.some(event => event.type === 'ROOM_STATE'), false, 'tomato does not enqueue a game snapshot');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(elsewhere.host.queue.some(event => event.type === 'TOMATO_THROW'), false, 'tomato is room scoped');
});

test('players and spectators can throw only at a current player, with authoritative identity', async t => {
  const f = await fixture(t);
  const room = await f.room('alice', { spectatorSlots: 1 });
  const bob = await f.join(room, 'bob');
  const watcher = await f.join(room, 'watcher', 'SPECTATOR');

  const send = (client, payload, type = 'TOMATO_THROW') => client.request({ type: 'THROW_TOMATO', roomId: room.roomId, ...payload }, type);
  watcher.ws.send(JSON.stringify({ type: 'THROW_TOMATO', roomId: room.roomId, targetPlayerId: 'bob', toPlayerId: 'alice' }));
  await Promise.all([room.host.next('TOMATO_THROW'), bob.next('TOMATO_THROW'), watcher.next('TOMATO_THROW')]);

  for (const [client, payload, code] of [
    [room.host, { targetPlayerId: 'alice' }, 'TOMATO_SELF_TARGET'],
    [room.host, { targetPlayerId: 'watcher' }, 'TOMATO_UNKNOWN_TARGET'],
    [room.host, { targetPlayerId: 'missing' }, 'TOMATO_UNKNOWN_TARGET'],
    [bob, { targetPlayerId: 'alice', roomId: 'FOREIGN' }, 'TOMATO_ROOM_NOT_FOUND']
  ]) {
    const error = await send(client, payload, 'TOMATO_ERROR');
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'state'), false);
  }

  const outsider = await f.connect();
  const error = await outsider.request({ type: 'THROW_TOMATO', roomId: room.roomId, targetPlayerId: 'bob' }, 'TOMATO_ERROR');
  assert.equal(error.code, 'TOMATO_NOT_MEMBER');
});

test('tomato rate limit is per sender and expires after the configured window', async t => {
  let now = 1000;
  const f = await fixture(t, { manager: new RoomManager({ tomatoOptions: { now: () => now, windowMs: 2000, maxThrows: 3 } }) });
  const room = await f.room('alice');
  const bob = await f.join(room, 'bob');
  const send = async (client, target, expected = 'TOMATO_THROW') => {
    if (expected !== 'TOMATO_THROW') return client.request({ type: 'THROW_TOMATO', roomId: room.roomId, targetPlayerId: target }, expected);
    const result = client.request({ type: 'THROW_TOMATO', roomId: room.roomId, targetPlayerId: target }, expected);
    const other = client === room.host ? bob : room.host;
    await other.next('TOMATO_THROW');
    return result;
  };
  await send(room.host, 'bob');
  await send(room.host, 'bob');
  await send(room.host, 'bob');
  assert.equal((await send(room.host, 'bob', 'TOMATO_ERROR')).code, 'TOMATO_RATE_LIMITED');
  // A different sender has an independent bucket.
  await send(bob, 'alice');
  now += 2000;
  await send(room.host, 'bob');
});

