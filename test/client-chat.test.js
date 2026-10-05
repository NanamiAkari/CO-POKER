const test = require('node:test');
const assert = require('node:assert/strict');
const Vue = require('vue');
const RoomChat = require('../public/room-chat');

function fixture(options = {}) {
  const sent = [];
  const roomId = Vue.ref('ABC123'), playerId = Vue.ref('Alice'), connected = Vue.ref(true);
  const chat = RoomChat.create({ Vue, roomId, playerId, connected, send: payload => sent.push(payload), ...options });
  const message = (id, text, owner = 'Bob', clientMessageId) => ({ id, kind: 'text', playerId: owner, role: 'PLAYER', text, timestamp: 1720000000000 + id, clientMessageId });
  const receive = value => chat.handleChatMessage({ type: 'CHAT_MESSAGE', roomId: roomId.value, message: value });
  const ack = (request, id = 1) => receive(message(id, request.text, 'Alice', request.clientMessageId));
  return { chat, sent, roomId, playerId, connected, message, receive, ack };
}

function bubbleClock() {
  let now = 0, serial = 0;
  const tasks = new Map(), callbacks = [];
  return {
    options: {
      setTimeout(callback, delay) {
        const id = ++serial;
        tasks.set(id, { callback, due: now + delay });
        callbacks.push(callback);
        return id;
      },
      clearTimeout(id) { tasks.delete(id); }
    },
    callbacks,
    get pending() { return tasks.size; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, task] = next;
        now = task.due;
        tasks.delete(id);
        task.callback();
      }
      now = target;
    }
  };
}

test('confirmed live chat shows bubbles even when chat is collapsed; pending text does not', () => {
  const clock = bubbleClock();
  const { chat, sent, ack, message, receive } = fixture(clock.options);
  chat.toggleChat();
  chat.chatDraft.value = '我先选 👍';
  chat.sendChat();
  assert.equal(chat.chatBubbleFor('Alice'), null);
  ack(sent[0]);
  receive(message(2, '收到 👏'));
  assert.equal(chat.chatBubbleFor('Alice').text, '我先选 👍');
  assert.equal(chat.chatBubbleFor('Bob').text, '收到 👏');
  assert.equal(chat.chatBubbles.value.size, 2);
  assert.equal(chat.chatUnread.value, 1);
  clock.advance(5999);
  assert.equal(chat.chatBubbles.value.size, 2);
  clock.advance(1);
  assert.equal(chat.chatBubbles.value.size, 0);
});

test('bubble replacement resets only its sender timer and stale callbacks cannot erase it', () => {
  const clock = bubbleClock();
  const { chat, receive, message } = fixture(clock.options);
  receive(message(1, '第一条'));
  clock.advance(1000);
  receive(message(2, '另一位', 'Carol'));
  clock.advance(2000);
  receive(message(3, '更新了'));
  assert.equal(clock.pending, 2);
  clock.callbacks[0]();
  assert.equal(chat.chatBubbleFor('Bob').text, '更新了');
  clock.advance(4000);
  assert.equal(chat.chatBubbleFor('Carol'), null);
  assert.equal(chat.chatBubbleFor('Bob').text, '更新了');
  clock.advance(2000);
  assert.equal(chat.chatBubbleFor('Bob'), null);
});

test('long bubble text receives more reading time, capped at twelve seconds using Unicode length', () => {
  const clock = bubbleClock();
  const { chat, receive, message } = fixture(clock.options);
  receive(message(1, '👍'.repeat(100)));
  receive(message(2, '长'.repeat(200), 'Carol'));
  clock.advance(7999);
  assert.ok(chat.chatBubbleFor('Bob'));
  clock.advance(1);
  assert.equal(chat.chatBubbleFor('Bob'), null);
  assert.ok(chat.chatBubbleFor('Carol'));
  clock.advance(3999);
  assert.ok(chat.chatBubbleFor('Carol'));
  clock.advance(1);
  assert.equal(chat.chatBubbleFor('Carol'), null);
});

test('history, duplicate echoes, and messages evicted from history never replay or prolong bubbles', () => {
  const clock = bubbleClock();
  const { chat, receive, message } = fixture(clock.options);
  chat.handleChatMessage({ type: 'ROOM_CREATED', roomId: 'ABC123', chatHistory: [message(1, '已有记录')] });
  assert.equal(chat.chatBubbles.value.size, 0);
  receive(message(1, '已有记录'));
  assert.equal(chat.chatBubbles.value.size, 0);
  receive(message(2, '刚刚发的'));
  clock.advance(4000);
  receive(message(2, '刚刚发的'));
  chat.handleChatMessage({ type: 'ROOM_STATE', roomId: 'ABC123', chatHistory: Array.from({ length: 101 }, (_, index) => message(index + 3, '更多历史')) });
  assert.equal(chat.chatBubbleFor('Bob').id, 2);
  clock.advance(2000);
  assert.equal(chat.chatBubbleFor('Bob'), null);
  receive(message(2, '刚刚发的'));
  receive(message(103, '更多历史'));
  assert.equal(chat.chatBubbles.value.size, 0);
  receive(message(104, '新的消息'));
  assert.equal(chat.chatBubbleFor('Bob').id, 104);
});

test('leaving clears all bubble timers and protects the next room from old callbacks and messages', () => {
  const clock = bubbleClock();
  const { chat, receive, message, roomId } = fixture(clock.options);
  receive(message(1, '旧房间'));
  receive({ ...message(2, '旧观战', 'Watcher'), role: 'SPECTATOR' });
  const callbacks = [...clock.callbacks];
  chat.resetChat();
  assert.equal(clock.pending, 0);
  assert.equal(chat.chatBubbles.value.size, 0);
  assert.equal(chat.chatSpectatorBubble.value, null);
  roomId.value = 'NEW123';
  receive(message(1, '新房间'));
  for (const callback of callbacks) callback();
  chat.handleChatMessage({ type: 'CHAT_MESSAGE', roomId: 'ABC123', message: message(3, '迟到的旧消息') });
  assert.equal(chat.chatBubbleFor('Bob').text, '新房间');
  roomId.value = 'THIRD1';
  assert.equal(chat.chatBubbleFor('Bob'), null);
  assert.equal(chat.chatSpectatorBubble.value, null);
  chat.resetChat();
});

test('spectator bubble identifies the latest observer independently from player bubbles and retains sticker data', () => {
  const clock = bubbleClock();
  const { chat, receive, message } = fixture(clock.options);
  receive({ ...message(1, '观战消息', 'Watcher'), role: 'SPECTATOR' });
  clock.advance(1000);
  receive({ id: 2, playerId: 'SecondWatcher', role: 'SPECTATOR', kind: 'sticker', stickerId: 'hi', timestamp: 123 });
  receive(message(3, '<img src=x onerror=alert(1)> 👍'));
  assert.equal(chat.chatSpectatorBubble.value.playerId, 'SecondWatcher');
  assert.equal(chat.chatSpectatorBubble.value.stickerId, 'hi');
  assert.equal(chat.chatSpectatorBubble.value.timestamp, 123);
  assert.equal(chat.chatBubbleFor('Bob').text, '<img src=x onerror=alert(1)> 👍');
  clock.advance(5000);
  assert.equal(chat.chatBubbleFor('Watcher'), null);
  assert.equal(chat.chatSpectatorBubble.value.playerId, 'SecondWatcher');
  clock.advance(1000);
  assert.equal(chat.chatSpectatorBubble.value, null);
  assert.equal(chat.chatBubbleFor('Bob'), null);
});

test('chat waits for the server echo, preserves text typed during delivery, and does not duplicate the echo', () => {
  const { chat, sent, ack } = fixture();
  chat.chatDraft.value = '先等一下';
  assert.equal(chat.sendChat(), true);
  assert.equal(chat.chatSending.value, true);
  assert.equal(chat.chatMessages.value.length, 0);
  assert.equal(chat.chatDraft.value, '先等一下');
  chat.chatDraft.value += '我想换一个硬币';
  assert.equal(chat.sendChat(), false);
  ack(sent[0]);
  assert.equal(chat.chatDraft.value, '我想换一个硬币');
  assert.equal(chat.chatMessages.value.length, 1);
  assert.equal(chat.chatSending.value, false);
  ack(sent[0]);
  assert.equal(chat.chatMessages.value.length, 1);
  assert.equal(chat.chatDraft.value, '我想换一个硬币');
  chat.resetChat();
});

test('acknowledgement does not erase a replacement draft', () => {
  const { chat, sent, ack } = fixture();
  chat.chatDraft.value = '原消息';
  chat.sendChat();
  chat.chatDraft.value = '新想法';
  ack(sent[0]);
  assert.equal(chat.chatDraft.value, '新想法');
});

test('chat errors preserve drafts and retry with the same id for safe server deduplication', () => {
  const { chat, sent, ack } = fixture();
  chat.chatDraft.value = '👍';
  chat.sendChat();
  const first = sent[0];
  chat.handleChatMessage({ type: 'CHAT_ERROR', roomId: 'ABC123', clientMessageId: first.clientMessageId, code: 'RATE_LIMITED', message: '请稍后再发' });
  assert.equal(chat.chatSending.value, false);
  assert.equal(chat.chatDraft.value, '👍');
  assert.equal(chat.chatError.value, '请稍后再发');
  chat.sendChat();
  assert.equal(sent[1].clientMessageId, first.clientMessageId);
  ack(sent[1]);
  assert.equal(chat.chatDraft.value, '');
  assert.equal(chat.chatError.value, '');
});

test('missing acknowledgements time out without locking chat or dropping its draft', async () => {
  const { chat, sent, ack } = fixture({ ackTimeoutMs: 5 });
  chat.chatDraft.value = '消息还在';
  chat.sendChat();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(chat.chatSending.value, false);
  assert.equal(chat.chatError.value, '消息未确认，请重试');
  assert.equal(chat.chatDraft.value, '消息还在');
  ack(sent[0]);
  assert.equal(chat.chatDraft.value, '');
  assert.equal(chat.chatError.value, '');
});

test('server histories merge with live chat by id, stay ordered, and retain only the last 100', () => {
  const { chat, message, receive } = fixture();
  receive(message(102, '最新')); 
  chat.handleChatMessage({ type: 'ROOM_STATE', roomId: 'ABC123', chatHistory: Array.from({ length: 101 }, (_, index) => message(index + 1, String(index + 1))) });
  assert.equal(chat.chatMessages.value.length, 100);
  assert.equal(chat.chatMessages.value[0].id, 3);
  assert.equal(chat.chatMessages.value.at(-1).id, 102);
  receive(message(102, '最新'));
  assert.equal(chat.chatMessages.value.length, 100);
});

test('collapsed chat counts other players only, never historical messages or duplicate echoes', () => {
  const { chat, receive, message } = fixture();
  chat.toggleChat();
  chat.handleChatMessage({ type: 'ROOM_CREATED', roomId: 'ABC123', chatHistory: [message(1, '历史')] });
  receive(message(2, '你好'));
  receive(message(2, '你好'));
  receive(message(3, '自己的消息', 'Alice'));
  assert.equal(chat.chatUnread.value, 1);
  chat.toggleChat();
  assert.equal(chat.chatUnread.value, 0);
});

test('room isolation ignores foreign events, while leaving clears chat and stale acknowledgements', () => {
  const { chat, sent, roomId, message } = fixture();
  chat.chatDraft.value = '本房消息';
  chat.sendChat();
  chat.handleChatMessage({ type: 'CHAT_ERROR', roomId: 'FOREIGN', clientMessageId: sent[0].clientMessageId, message: '不相关' });
  chat.handleChatMessage({ type: 'CHAT_MESSAGE', roomId: 'FOREIGN', message: message(1, '不相关') });
  assert.equal(chat.chatSending.value, true);
  assert.equal(chat.chatMessages.value.length, 0);
  chat.resetChat();
  roomId.value = '';
  chat.handleChatMessage({ type: 'CHAT_MESSAGE', roomId: 'ABC123', message: message(1, '本房消息', 'Alice', sent[0].clientMessageId) });
  assert.equal(chat.chatDraft.value, '');
  assert.equal(chat.chatMessages.value.length, 0);
  assert.equal(chat.chatSending.value, false);
});

test('chat accepts 200 Unicode code points rather than counting emoji as two characters', () => {
  const { chat, sent, ack } = fixture();
  chat.chatDraft.value = '👍'.repeat(200);
  assert.equal(chat.chatDraftLength.value, 200);
  assert.equal(chat.chatCanSend.value, true);
  assert.equal(chat.sendChat(), true);
  ack(sent[0]);
  chat.chatDraft.value = '👍'.repeat(201);
  assert.equal(chat.chatCanSend.value, false);
  assert.equal(chat.sendChat(), false);
  assert.equal(chat.chatError.value, '消息最多 200 个字符');
  assert.equal(sent.length, 1);
});

test('emoji picker inserts into the current selection and retains the caret without sending', async () => {
  const { chat, sent } = fixture();
  let selection, focused = false;
  chat.chatInput.value = { selectionStart: 1, selectionEnd: 3, focus() { focused = true; }, setSelectionRange(start, end) { selection = [start, end]; } };
  chat.chatDraft.value = '一二三四';
  chat.toggleChatPanel('emoji');
  assert.equal(chat.insertEmoji({ emoji: '😀' }), true);
  await Vue.nextTick();
  assert.equal(chat.chatDraft.value, '一😀四');
  assert.deepEqual(selection, [3, 3]);
  assert.equal(focused, true);
  assert.equal(sent.length, 0);
});

test('Enter sends, Shift+Enter permits newlines, and IME confirmation never sends', () => {
  const { chat, sent, ack } = fixture();
  let prevented = 0;
  const event = overrides => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, preventDefault() { prevented++; }, ...overrides });
  chat.chatDraft.value = '中文';
  chat.chatKeydown(event({ isComposing: true }));
  chat.chatKeydown(event({ keyCode: 229 }));
  chat.chatCompositionStart();
  chat.chatKeydown(event());
  chat.chatCompositionEnd();
  chat.chatKeydown(event({ shiftKey: true }));
  assert.equal(sent.length, 0);
  assert.equal(prevented, 0);
  chat.chatKeydown(event());
  assert.equal(sent.length, 1);
  assert.equal(prevented, 1);
  ack(sent[0]);
});

test('sticker catalog allows only local assets and sticker sends leave text drafts unchanged', () => {
  const { chat, sent, receive } = fixture({ catalog: [
    { id: 'hi', label: '打招呼', src: '/stickers/hi.webp' },
    { id: 'outside', label: '远程', src: 'https://example.com/a.png' },
    { id: 'traversal', label: '越界', src: '/stickers/../secret.svg' },
    { id: 'query', label: '参数', src: '/stickers/hi.svg?payload=1' },
    { id: 'hi', label: '重复', src: '/stickers/second.png' }
  ] });
  assert.equal(chat.chatStickers.value.length, 1);
  chat.chatDraft.value = '未发送草稿';
  assert.equal(chat.sendSticker('hi'), true);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['clientMessageId', 'kind', 'roomId', 'stickerId', 'type']);
  receive({ id: 1, kind: 'sticker', playerId: 'Alice', stickerId: 'hi', clientMessageId: sent[0].clientMessageId });
  assert.equal(chat.chatDraft.value, '未发送草稿');
  assert.equal(chat.chatMessages.value[0].stickerId, 'hi');
  assert.equal(chat.sendSticker('outside'), false);
});

test('empty and unavailable sticker manifests leave text chat usable', async () => {
  const { chat, sent, ack } = fixture({ fetch: async () => ({ ok: true, json: async () => [] }) });
  await chat.loadChatStickers();
  assert.deepEqual(chat.chatStickers.value, []);
  assert.equal(chat.chatError.value, '');
  chat.chatDraft.value = '正常聊天';
  assert.equal(chat.sendChat(), true);
  ack(sent[0]);
  const unavailable = fixture({ fetch: async () => { throw new Error('offline'); } }).chat;
  await unavailable.loadChatStickers();
  assert.deepEqual(unavailable.chatStickers.value, []);
  assert.equal(unavailable.chatError.value, '');
});

test('connection failures are retryable and keep the typed draft', () => {
  const { chat, connected } = fixture({ send: () => false });
  chat.chatDraft.value = '还没发送';
  connected.value = false;
  assert.equal(chat.sendChat(), false);
  assert.equal(chat.chatSending.value, false);
  connected.value = true;
  assert.equal(chat.sendChat(), false);
  assert.equal(chat.chatDraft.value, '还没发送');
  assert.equal(chat.chatSending.value, false);
});

test('real WebSocket chat acknowledges controller ids, syncs spectators, and recovers from a rejected send', async t => {
  const { createServer } = require('../src/server');
  const WebSocket = require('ws');
  const server = createServer({ host: '127.0.0.1', port: 0 });
  const address = await server.listen();
  const clients = [];
  t.after(async () => { for (const client of clients) client.chat.resetChat(); await server.close(); });

  async function connect(name) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const roomId = Vue.ref(''), inbox = [], waiters = [];
    const chat = RoomChat.create({ Vue, roomId, playerId: Vue.ref(name), connected: Vue.ref(true), send: payload => ws.send(JSON.stringify(payload)) });
    const next = type => {
      const index = inbox.findIndex(event => event.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Missing ${type}`)); }, 2000) };
        waiters.push(waiter);
      });
    };
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (['ROOM_CREATED', 'ROOM_STATE'].includes(event.type)) roomId.value = event.roomId || event.state?.roomId;
      chat.handleChatMessage(event);
      const index = waiters.findIndex(waiter => waiter.type === event.type);
      if (index < 0) inbox.push(event);
      else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(event); }
    });
    const client = { chat, roomId, next, request: (payload, type) => { const result = next(type); ws.send(JSON.stringify(payload)); return result; } };
    clients.push(client);
    return client;
  }

  const host = await connect('Alice');
  await host.request({ type: 'CREATE_ROOM', playerId: 'Alice', options: { spectatorSlots: 1 } }, 'ROOM_CREATED');
  const guest = await connect('Bob');
  await guest.request({ type: 'JOIN_ROOM', playerId: 'Bob', roomId: host.roomId.value }, 'ROOM_STATE');
  await host.next('ROOM_STATE');
  host.chat.chatDraft.value = '这局加油 👍';
  host.chat.chatPanel.value = 'emoji';
  assert.equal(host.chat.sendChat(), true);
  assert.equal(host.chat.chatPanel.value, null, 'sending closes the picker so the new message is visible');
  await Promise.all([host.next('CHAT_MESSAGE'), guest.next('CHAT_MESSAGE')]);
  assert.equal(host.chat.chatSending.value, false);
  assert.equal(host.chat.chatDraft.value, '');
  assert.deepEqual(host.chat.chatMessages.value, guest.chat.chatMessages.value);
  assert.equal(host.chat.chatBubbleFor('Alice').text, '这局加油 👍');
  assert.deepEqual(host.chat.chatBubbleFor('Alice'), guest.chat.chatBubbleFor('Alice'));

  const watcher = await connect('Watcher');
  await watcher.request({ type: 'JOIN_ROOM', playerId: 'Watcher', role: 'SPECTATOR', roomId: host.roomId.value }, 'ROOM_STATE');
  assert.equal(watcher.chat.chatMessages.value[0].text, '这局加油 👍');
  assert.equal(watcher.chat.chatBubbleFor('Alice'), null, 'joining history does not replay old bubbles');
  watcher.chat.chatDraft.value = '观战也能聊';
  watcher.chat.sendChat();
  await Promise.all([host.next('CHAT_MESSAGE'), guest.next('CHAT_MESSAGE'), watcher.next('CHAT_MESSAGE')]);
  assert.equal(host.chat.chatMessages.value.at(-1).role, 'SPECTATOR');
  assert.equal(host.chat.chatSpectatorBubble.value.text, '观战也能聊');
  assert.deepEqual(host.chat.chatSpectatorBubble.value, watcher.chat.chatSpectatorBubble.value);

  guest.chat.chatDraft.value = '坏\u0001字符';
  assert.equal(guest.chat.sendChat(), true);
  const rejected = await guest.next('CHAT_ERROR');
  assert.equal(rejected.code, 'CHAT_INVALID_TEXT');
  assert.equal(guest.chat.chatSending.value, false);
  assert.equal(guest.chat.chatDraft.value, '坏\u0001字符');
  guest.chat.chatDraft.value = '改好了 😎';
  assert.equal(guest.chat.sendChat(), true);
  await Promise.all([host.next('CHAT_MESSAGE'), guest.next('CHAT_MESSAGE'), watcher.next('CHAT_MESSAGE')]);
  assert.equal(guest.chat.chatDraft.value, '');
  assert.equal(host.chat.chatMessages.value.length, 3);
  assert.deepEqual(host.chat.chatMessages.value, watcher.chat.chatMessages.value);
});
