const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createServer, RoomManager } = require('../src/server');
const { RoomChat, loadStickerCatalog } = require('../src/chat');

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
        }, 2000);
        pending.push(waiter);
      });
    };
    return {
      ws, next, queue,
      request(payload, type) { const response = next(type); ws.send(JSON.stringify(payload)); return response; }
    };
  };
  const create = async (name = 'host', roomOptions = {}) => {
    const host = await connect();
    const created = await host.request({ type: 'CREATE_ROOM', playerId: name, options: roomOptions }, 'ROOM_CREATED');
    assert.deepEqual(created.chatHistory, []);
    return { roomId: created.roomId, host, members: [host] };
  };
  const join = async (room, name, role = 'PLAYER') => {
    const client = await connect();
    const joined = await client.request({ type: 'JOIN_ROOM', roomId: room.roomId, playerId: name, role }, 'ROOM_STATE');
    assert.equal(joined.roomId, room.roomId);
    for (const member of room.members) {
      const event = await member.next('ROOM_STATE');
      assert.deepEqual(event.chatHistory, joined.chatHistory);
    }
    room.members.push(client);
    return { client, joined };
  };
  const send = async (room, sender, text, id, extra = {}) => {
    const result = await sender.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: id, kind: 'text', text, ...extra }, 'CHAT_MESSAGE');
    for (const member of room.members) if (member !== sender) assert.deepEqual(await member.next('CHAT_MESSAGE'), result);
    assert.equal(Object.hasOwn(result, 'state'), false);
    return result.message;
  };
  // A response on each socket is a barrier after earlier outgoing room messages.
  const noChat = async room => {
    for (const member of room.members) {
      await member.request({ type: 'GET_REPLAY', roomId: room.roomId }, 'REPLAY_DATA');
      assert.equal(member.queue.some(event => ['CHAT_MESSAGE', 'ERROR'].includes(event.type)), false);
    }
  };
  return { server, connect, create, join, send, noChat };
}

test('chat broadcasts only to room members and takes identity from the connection', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const { client: guest } = await f.join(room, 'guest');
  const other = await f.create('elsewhere');
  const result = await f.send(room, guest, '  大家好 😀♥️  ', 'hello-1', {
    playerId: 'host', role: 'SPECTATOR', id: 500, timestamp: 1,
    src: 'https://example.test/tracker.svg'
  });
  assert.deepEqual(Object.keys(result).sort(), ['id', 'playerId', 'role', 'kind', 'text', 'timestamp', 'clientMessageId'].sort());
  assert.equal(result.id, 1);
  assert.equal(result.playerId, 'guest');
  assert.equal(result.role, 'PLAYER');
  assert.equal(result.text, '大家好 😀♥️');
  assert.ok(result.timestamp > 1);
  await f.noChat(other);
  const literal = '<img src=x onerror=alert(1)> & <script>hello</script>';
  assert.equal((await f.send(room, room.host, literal, 'literal')).text, literal);
});

test('chat rejects unjoined, foreign-room, missing-room and departed senders with independent CHAT_ERROR', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const { client: guest } = await f.join(room, 'guest');
  const outsider = await f.connect();
  const other = await f.create('outsider');
  for (const client of [outsider, other.host]) {
    const error = await client.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'attack', kind: 'text', text: 'hello', playerId: 'host' }, 'CHAT_ERROR');
    assert.equal(error.code, 'CHAT_NOT_MEMBER');
    assert.equal(error.clientMessageId, 'attack');
    assert.equal(error.roomId, room.roomId);
    assert.equal(Object.hasOwn(error, 'state'), false);
  }
  const missing = await outsider.request({ type: 'SEND_CHAT', roomId: 'missing', clientMessageId: 'missing', kind: 'text', text: 'hello' }, 'CHAT_ERROR');
  assert.equal(missing.code, 'CHAT_ROOM_NOT_FOUND');
  await guest.request({ type: 'LEAVE_ROOM', roomId: room.roomId }, 'ROOM_LEFT');
  await room.host.next('ROOM_STATE');
  room.members.pop();
  const left = await guest.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'left', kind: 'text', text: 'hello' }, 'CHAT_ERROR');
  assert.equal(left.code, 'CHAT_NOT_MEMBER');
  await f.noChat(room);
  assert.equal(f.server.manager.get(room.roomId).chat.history.length, 0);
});

test('chat validates Unicode length, empty input, request ids and unconfigured stickers', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const cases = [
    [{ text: ' \t\n\u3000 ' }, 'CHAT_EMPTY'],
    [{ text: '😀'.repeat(201) }, 'CHAT_TOO_LONG'],
    [{ text: 123 }, 'CHAT_INVALID_TEXT'],
    [{ text: 'hello\u0000world' }, 'CHAT_INVALID_TEXT'],
    [{ kind: 'html', text: 'hello' }, 'CHAT_INVALID_KIND'],
    [{ clientMessageId: '' }, 'CHAT_INVALID_ID'],
    [{ clientMessageId: 'x'.repeat(81) }, 'CHAT_INVALID_ID'],
    [{ clientMessageId: { id: 'x' } }, 'CHAT_INVALID_ID'],
    [{ kind: 'sticker', stickerId: 'unknown' }, 'CHAT_UNKNOWN_STICKER'],
    [{ kind: 'sticker', stickerId: 'https://example.test/image.png' }, 'CHAT_UNKNOWN_STICKER']
  ];
  for (const [payload, code] of cases) {
    const error = await room.host.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'invalid', kind: 'text', text: 'hello', ...payload }, 'CHAT_ERROR');
    assert.equal(error.code, code);
  }
  const emoji = await f.send(room, room.host, '😀'.repeat(200), 'unicode-limit');
  assert.equal([...emoji.text].length, 200);
  assert.equal(emoji.id, 1);
  await f.noChat(room);
});

test('spectators receive join history and can send chat with their authoritative spectator role', async t => {
  const f = await fixture(t);
  const room = await f.create('host', { spectatorSlots: 1 });
  await f.join(room, 'guest');
  const before = await f.send(room, room.host, '等你入座', 'before-join');
  const { client: watcher, joined } = await f.join(room, 'watcher', 'SPECTATOR');
  assert.deepEqual(joined.chatHistory, [before]);
  const after = await f.send(room, watcher, '👋', 'watcher-hello', { role: 'PLAYER', playerId: 'host' });
  assert.equal(after.role, 'SPECTATOR');
  assert.equal(after.playerId, 'watcher');
  assert.equal(after.id, 2);
  await f.noChat(room);
});

test('retrying chat acknowledges the same message only to its sender and rejects changed content', async t => {
  const f = await fixture(t);
  const room = await f.create();
  const { client: guest } = await f.join(room, 'guest');
  const original = await f.send(room, room.host, '同一条消息', 'retry-me');
  for (let attempt = 0; attempt < 3; attempt++) {
    const retried = await room.host.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'retry-me', kind: 'text', text: '同一条消息' }, 'CHAT_MESSAGE');
    assert.deepEqual(retried.message, original);
  }
  const conflict = await room.host.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'retry-me', kind: 'text', text: '改成另一条' }, 'CHAT_ERROR');
  assert.equal(conflict.code, 'CHAT_DUPLICATE_ID');
  assert.equal(f.server.manager.get(room.roomId).chat.history.length, 1);
  await f.noChat(room);
  const separate = await f.send(room, guest, '另一位玩家可用相同编号', 'retry-me');
  assert.equal(separate.id, 2);
});

test('chat rate limit is per connection and allows successful retries and sending after the window', async t => {
  let now = 10000;
  const f = await fixture(t, { manager: new RoomManager({ chatOptions: { now: () => now } }) });
  const room = await f.create();
  const { client: guest } = await f.join(room, 'guest');
  let first;
  for (let i = 0; i < 5; i++) {
    const result = await f.send(room, room.host, `消息 ${i}`, `rate-${i}`);
    if (i === 0) first = result;
  }
  const payload = { type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'rate-5', kind: 'text', text: '下一条' };
  assert.equal((await room.host.request(payload, 'CHAT_ERROR')).code, 'CHAT_RATE_LIMITED');
  const retried = await room.host.request({ ...payload, clientMessageId: 'rate-0', text: '消息 0' }, 'CHAT_MESSAGE');
  assert.deepEqual(retried.message, first);
  await f.send(room, guest, '不影响另一位玩家', 'guest-rate');
  now += 2000;
  const accepted = await f.send(room, room.host, '下一条', 'rate-5');
  assert.equal(accepted.id, 7);
  await f.noChat(room);
});

test('chat stays available across coin rounds, settlement and rematch without changing game snapshots', async t => {
  let now = 10000;
  const f = await fixture(t, { manager: new RoomManager({ chatOptions: { now: () => now } }) });
  const room = await f.create();
  const { client: guest } = await f.join(room, 'guest');
  await f.send(room, room.host, '开始吧', 'waiting');
  const started = await room.host.request({ type: 'START_GAME', roomId: room.roomId }, 'GAME_STARTED');
  await guest.next('GAME_STARTED');
  assert.equal(Object.hasOwn(started, 'chatHistory'), false);
  for (let round = 1; round <= 4; round++) {
    now += 2000;
    const game = f.server.manager.get(room.roomId).game;
    const before = JSON.stringify(game.getReplay());
    await f.send(room, guest, `第 ${round} 轮`, `round-${round}`);
    assert.equal(JSON.stringify(game.getReplay()), before);
    await room.host.request({ type: 'MOVE_COIN', roomId: room.roomId, coin: 1 }, 'ROOM_STATE');
    await guest.next('ROOM_STATE');
    const moved = await guest.request({ type: 'MOVE_COIN', roomId: room.roomId, coin: 2 }, 'ROOM_STATE');
    await room.host.next('ROOM_STATE');
    assert.equal(Object.hasOwn(moved, 'chatHistory'), false);
  }
  assert.equal(f.server.manager.get(room.roomId).game.phase, 'SETTLEMENT');
  await f.send(room, room.host, '再来一局', 'settlement');
  await room.host.request({ type: 'REMATCH', roomId: room.roomId }, 'ROOM_STATE');
  await guest.next('ROOM_STATE');
  await guest.request({ type: 'REMATCH', roomId: room.roomId }, 'ROOM_STATE');
  await room.host.next('ROOM_STATE');
  const stored = f.server.manager.get(room.roomId);
  assert.equal(stored.game.phase, 'ROUND_1_COINS');
  assert.equal(stored.chat.history.length, 6);
  assert.equal(stored.chat.history[0].clientMessageId, 'waiting');
  await f.send(room, guest, '继续', 'next-hand');
  assert.equal(stored.chat.history.at(-1).id, 7);
});

test('join history is bounded to the most recent 100 messages with monotonic room ids', async t => {
  let now = 10000;
  const f = await fixture(t, { manager: new RoomManager({ chatOptions: { now: () => now } }) });
  const room = await f.create();
  for (let i = 1; i <= 105; i++) {
    now += 2000;
    await f.send(room, room.host, `消息 ${i}`, `history-${i}`);
  }
  const { joined } = await f.join(room, 'late');
  assert.equal(joined.chatHistory.length, 100);
  assert.equal(joined.chatHistory[0].id, 6);
  assert.equal(joined.chatHistory.at(-1).id, 105);
  const replayed = await room.host.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'history-1', kind: 'text', text: '消息 1' }, 'CHAT_MESSAGE');
  assert.equal(replayed.message.id, 1);
  assert.equal(f.server.manager.get(room.roomId).chat.history.length, 100);
  await f.noChat(room);
});

test('chat retry receipts are bounded and leaving releases them', () => {
  let now = 10000;
  const chat = new RoomChat({ now: () => now });
  const client = { id: 'host', role: 'PLAYER' };
  for (let i = 0; i < 520; i++) {
    now += 2000;
    chat.accept(client, { kind: 'text', text: `${i}`, clientMessageId: `bounded-${i}` });
  }
  assert.equal(chat.history.length, 100);
  assert.equal(chat.senders.get(client).receipts.size, 512);
  const retried = chat.accept(client, { kind: 'text', text: '519', clientMessageId: 'bounded-519' });
  assert.equal(retried.duplicate, true);
  assert.equal(retried.message.id, 520);
  chat.forget(client);
  assert.equal(chat.senders.has(client), false);
});

test('sticker catalog accepts only existing local image files and messages contain only approved ids', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'copoker-chat-catalog-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'stickers'));
  fs.writeFileSync(path.join(temp, 'stickers', 'wave.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(temp, 'outside.svg'), '<svg/>');
  const file = path.join(temp, 'stickers', 'catalog.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'wave', src: '/stickers/wave.svg', label: ' 招手 ' },
    { id: 'wave', src: '/stickers/wave.svg', label: '重复招手' },
    { id: 'remote', src: 'https://example.test/stickers/image.svg', label: '外链' },
    { id: 'traversal', src: '/stickers/../outside.svg', label: '目录外' },
    { id: 'relative', src: 'stickers/wave.svg', label: '相对路径' },
    { id: 'missing', src: '/stickers/missing.png', label: '无图片' },
    { id: 'html', src: '/stickers/test.html', label: '网页' },
    { id: 'query', src: '/stickers/wave.svg?url=https://example.test', label: '外链参数' },
    { id: 'data', src: 'data:image/svg+xml,<svg/>', label: '内嵌数据' },
    { id: 'no-label', src: '/stickers/wave.svg' },
    { id: 'blank-label', src: '/stickers/wave.svg', label: ' ' },
    { id: 'long-label', src: '/stickers/wave.svg', label: '字'.repeat(31) }
  ]));
  const catalog = loadStickerCatalog(file, temp);
  assert.deepEqual(catalog, [{ id: 'wave', src: '/stickers/wave.svg', label: '招手' }]);
  const chat = new RoomChat({ stickerCatalog: catalog });
  const { message } = chat.accept({ id: 'host', role: 'PLAYER' }, {
    clientMessageId: 'sticker-1', kind: 'sticker', stickerId: 'wave', src: 'https://example.test/evil.png', text: '<img src=x>'
  });
  assert.equal(message.stickerId, 'wave');
  assert.equal(Object.hasOwn(message, 'src'), false);
  assert.equal(Object.hasOwn(message, 'text'), false);
  assert.throws(() => chat.accept({ id: 'other', role: 'PLAYER' }, { clientMessageId: 'sticker-2', kind: 'sticker', stickerId: 'remote' }), { code: 'CHAT_UNKNOWN_STICKER' });
  fs.writeFileSync(file, JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ id: `sticker-${i}`, src: '/stickers/wave.svg', label: `表情 ${i}` }))));
  assert.equal(loadStickerCatalog(file, temp).length, 60);
  fs.writeFileSync(file, '{broken json');
  assert.deepEqual(loadStickerCatalog(file, temp), []);
});

test('approved sticker sends directly to players and spectators without any client-provided URL', async t => {
  const f = await fixture(t, { manager: new RoomManager({ chatOptions: {
    stickerCatalog: [{ id: 'wave', label: '招手', src: '/stickers/wave.svg' }]
  } }) });
  const room = await f.create('host', { spectatorSlots: 1 });
  const { client: watcher } = await f.join(room, 'watcher', 'SPECTATOR');
  const received = await watcher.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'wave-1', kind: 'sticker', stickerId: 'wave', src: 'https://example.test/tracker.gif' }, 'CHAT_MESSAGE');
  assert.deepEqual(await room.host.next('CHAT_MESSAGE'), received);
  assert.equal(received.message.kind, 'sticker');
  assert.equal(received.message.stickerId, 'wave');
  assert.equal(received.message.playerId, 'watcher');
  assert.equal(received.message.role, 'SPECTATOR');
  assert.equal(Object.hasOwn(received.message, 'src'), false);
  assert.equal(Object.hasOwn(received, 'state'), false);
  const retried = await watcher.request({ type: 'SEND_CHAT', roomId: room.roomId, clientMessageId: 'wave-1', kind: 'sticker', stickerId: 'wave' }, 'CHAT_MESSAGE');
  assert.deepEqual(retried, received);
  await f.noChat(room);
});

test('sticker catalog is served as JSON so the browser can load the configured sticker list', async t => {
  const f = await fixture(t);
  const address = f.server.httpServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/stickers/catalog.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.ok(Array.isArray(await response.json()));
});
