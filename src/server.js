const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { GameRoom, PHASES } = require('./game');
const { RoomChat, ChatError } = require('./chat');

function validateOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid room options');
  const options = { handCardCount: 2, handUsageRule: 'any', historyVisibility: 'all', includeJokers: false, spectatorSlots: 0 };
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) throw new Error(`Unknown room option: ${key}`);
    options[key] = input[key];
  }
  if (![2, 3].includes(options.handCardCount)) throw new Error('handCardCount must be 2 or 3');
  if (!['any', 'all-hole'].includes(options.handUsageRule)) throw new Error('Invalid handUsageRule');
  if (!['all', 'self', 'none'].includes(options.historyVisibility)) throw new Error('Invalid historyVisibility');
  if (typeof options.includeJokers !== 'boolean') throw new Error('includeJokers must be a boolean');
  if (!Number.isInteger(options.spectatorSlots) || options.spectatorSlots < 0 || options.spectatorSlots > 8) throw new Error('spectatorSlots must be between 0 and 8');
  return options;
}

function playerName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 32) throw new Error('Player name must contain 1 to 32 characters');
  return value.trim();
}

class RoomManager {
  constructor({ chatOptions } = {}) { this.rooms = new Map(); this.chatOptions = chatOptions; }
  create(options = {}) { options = validateOptions(options); const id = crypto.randomBytes(3).toString('hex').toUpperCase(); const room = { id, hostId: null, clients: new Map(), spectators: [], game: null, options, chat: new RoomChat(this.chatOptions) }; this.rooms.set(id, room); return room; }
  get(id) { return this.rooms.get(id); }
}

function createServer({ port = 0, host = '127.0.0.1', manager = new RoomManager(), heartbeatIntervalMs = 25000 } = {}) {
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ service: 'cooperative-poker', status: 'ok' })); }
    const requestUrl = new URL(req.url, 'http://localhost');
    const requested = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const file = path.join(__dirname, '..', 'public', requested.replace(/^\//, ''));
    if (!file.startsWith(path.join(__dirname, '..', 'public'))) { res.writeHead(400); return res.end('Bad request'); }
    try {
      const content = fs.readFileSync(file);
      const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const cacheControl = file.endsWith('.html') || file.endsWith('app.js') || file.endsWith('.css')
        ? 'no-cache, must-revalidate'
        : 'public, max-age=300, must-revalidate';
      res.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': cacheControl,
        'x-content-type-options': 'nosniff'
      });
      res.end(content);
    }
    catch { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 16 * 1024 });
  // Protocol ping frames keep idle games alive through HTTP reverse proxies.
  // Browsers answer pong automatically, even while players make no moves.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping(error => { if (error) client.terminate(); });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  const send = (ws, type, payload = {}) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload })); };
  const state = room => ({
    roomId: room.id, hostId: room.hostId, options: room.options,
    phase: room.game?.phase || PHASES.WAITING,
    successCount: room.game?.successCount || 0, failureCount: room.game?.failureCount || 0,
    rematchConfirmed: room.game ? [...room.game.rematchConfirmed] : [],
    comparisonSkip: room.game?.comparisonSkip || false,
    comparisonSkipVotes: room.game ? [...room.game.comparisonSkipVotes] : [],
    players: room.game ? room.game.players.map(p => ({ id: p.id, currentCoin: p.currentCoin })) : [...room.clients.values()].filter(c => c.role === 'PLAYER').map(c => ({ id: c.id, currentCoin: null, coinHistory: [] })),
    spectators: room.spectators
  });
  const viewFor = (room, client) => {
    const game = room.game;
    const own = client.role === 'PLAYER' && game?.players.find(p => p.id === client.id);
    const reveal = game && [PHASES.FINAL_REVEAL, PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(game.phase);
    const privateView = own ? game.getPlayerView(client.id) : {
      communityCards: game?.communityCards || [], ownHoleCards: [], ownEstimatedHand: null, coinHistory: [],
      ...(game ? { players: game.players.map(p => ({ id: p.id, currentCoin: p.currentCoin, coinHistory: room.options.historyVisibility === 'all' ? p.coinHistory.slice() : [] })) } : {})
    };
    return { ...state(room), ...privateView,
      finalHands: reveal ? game.players.map(p => ({ playerId: p.id, coin: p.currentCoin, holeCards: p.holeCards, hand: p.finalHand })) : [],
      result: game?.lastResult || null
    };
  };
  const broadcast = (room, type, payload = {}) => room.clients.forEach(client => { if (client.readyState === 1) send(client, type, { ...payload, state: viewFor(room, client) }); });
  const playerIds = room => [...room.clients.values()].filter(c => c.role === 'PLAYER').map(c => c.id);
  const detach = ws => { ws.room = null; ws.id = null; ws.role = null; };
  const closeRoom = (room, reason) => {
    for (const client of room.clients.values()) {
      send(client, 'ROOM_ENDED', { roomId: room.id, reason });
      room.chat.forget(client);
      detach(client);
    }
    room.clients.clear();
    room.spectators = [];
    manager.rooms.delete(room.id);
  };
  const leaveRoom = (ws, explicit = false) => {
    const room = ws.room;
    if (!room || room.clients.get(ws.id) !== ws) return;
    const id = ws.id;
    const wasPlayer = ws.role === 'PLAYER';
    room.chat.forget(ws);
    room.clients.delete(id);
    room.spectators = room.spectators.filter(spectator => spectator !== id);
    detach(ws);
    if (explicit) send(ws, 'ROOM_LEFT', { roomId: room.id });
    if (room.game && wasPlayer) return closeRoom(room, explicit ? 'PLAYER_LEFT' : 'PLAYER_DISCONNECTED');
    if (room.hostId === id) room.hostId = playerIds(room)[0] || null;
    if (!room.hostId) return closeRoom(room, 'NO_PLAYERS');
    broadcast(room, 'ROOM_STATE');
  };
  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Malformed/oversized frames are closed by ws; consume the error so one
    // bad connection cannot terminate the whole game process.
    ws.on('error', () => { if (ws.readyState === 1) ws.terminate(); });
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, 'ERROR', { message: 'Invalid JSON' }); }
      try {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid message');
        if (msg.type === 'SEND_CHAT') {
          const room = manager.get(msg.roomId);
          if (!room) throw new ChatError('CHAT_ROOM_NOT_FOUND', '房间已结束');
          if (ws.room !== room || room.clients.get(ws.id) !== ws) throw new ChatError('CHAT_NOT_MEMBER', '请先加入这个房间');
          const { message, duplicate } = room.chat.accept(ws, msg);
          if (duplicate) return send(ws, 'CHAT_MESSAGE', { roomId: room.id, message });
          // Chat must never enqueue a game snapshot or release a pending move.
          for (const client of room.clients.values()) send(client, 'CHAT_MESSAGE', { roomId: room.id, message });
          return;
        }
        if (msg.type === 'CREATE_ROOM') {
          if (ws.room) throw new Error('Leave the current room first');
          const id = playerName(msg.playerId);
          const room = manager.create(msg.options);
          room.hostId = id; ws.room = room; ws.id = id; ws.role = 'PLAYER'; room.clients.set(id, ws);
          return send(ws, 'ROOM_CREATED', { roomId: room.id, state: viewFor(room, ws), chatHistory: [] });
        }
        const room = manager.get(msg.roomId); if (!room) throw new Error('Room not found');
        if (msg.type === 'JOIN_ROOM') {
          if (ws.room) throw new Error('Leave the current room first');
          const id = playerName(msg.playerId);
          if (room.clients.has(id)) throw new Error('Player name is already in use');
          if (msg.role !== undefined && !['PLAYER', 'SPECTATOR'].includes(msg.role)) throw new Error('Invalid role');
          const role = msg.role || 'PLAYER';
          if (role === 'PLAYER' && room.game) throw new Error('Game already started');
          if (role === 'PLAYER' && playerIds(room).length >= 5) throw new Error('Player positions are full');
          if (role === 'SPECTATOR' && room.spectators.length >= room.options.spectatorSlots) throw new Error('Spectator positions are full');
          ws.room = room; ws.id = id; ws.role = role; room.clients.set(id, ws);
          if (role === 'SPECTATOR') room.spectators.push(id);
          return broadcast(room, 'ROOM_STATE', { roomId: room.id, chatHistory: room.chat.history });
        }
        if (ws.room !== room || room.clients.get(ws.id) !== ws) throw new Error('Not a member of this room');
        if (msg.type === 'LEAVE_ROOM') return leaveRoom(ws, true);
        if (msg.type === 'START_GAME') {
          if (ws.id !== room.hostId || ws.role !== 'PLAYER') throw new Error('Only host can start');
          if (room.game) throw new Error('Game already started');
          room.game = new GameRoom({ ...room.options, players: playerIds(room) });
          room.game.start();
          return broadcast(room, 'GAME_STARTED');
        }
        if (msg.type === 'UPDATE_ROOM_OPTIONS') {
          if (ws.id !== room.hostId || ws.role !== 'PLAYER') throw new Error('Only host can update room options');
          if (!room.game || room.game.phase !== PHASES.GAME_OVER) throw new Error('Room options can only be changed after game over');
          const requested = validateOptions({ ...room.options, ...(msg.options || {}) });
          if (room.spectators.length > requested.spectatorSlots) throw new Error('Spectator positions are full');
          room.game.updateOptions(requested);
          room.options = requested;
          return broadcast(room, 'ROOM_OPTIONS_UPDATED');
        }
        if (msg.type === 'GET_REPLAY') {
          const visibility = room.options.historyVisibility;
          const events = (room.game?.getReplay() || []).flatMap(event => {
            if (visibility === 'all') return [event];
            const selfOnly = visibility === 'self' && ws.role === 'PLAYER';
            if (['COIN_MOVED', 'COIN_RETURNED'].includes(event.type) && !(selfOnly && (event.payload.toPlayer === ws.id || event.payload.player === ws.id))) return [];
            if (Array.isArray(event.payload.coinHistory)) return [{ ...event, payload: { ...event.payload, coinHistory: selfOnly ? event.payload.coinHistory.filter(item => item.playerId === ws.id) : [] } }];
            return [event];
          });
          return send(ws, 'REPLAY_DATA', { events });
        }
        if (ws.role !== 'PLAYER') throw new Error('Spectators cannot perform player actions');
        if (!room.game) throw new Error('Game has not started');
        let coinAction = null;
        if (msg.type === 'MOVE_COIN') {
          coinAction = { type: 'MOVE', coin: msg.coin, fromPlayerId: room.game.coinTable?.owners.get(msg.coin) || null, toPlayerId: ws.id };
          room.game.moveCoin(msg.coin, ws.id, msg.fromPlayerId || null);
        } else if (msg.type === 'RETURN_COIN') {
          coinAction = { type: 'RETURN', coin: msg.coin, fromPlayerId: ws.id, toPlayerId: null };
          room.game.returnCoin(msg.coin, ws.id);
        }
        else if (msg.type === 'SETTLE') room.game.settle();
        else if (msg.type === 'REMATCH') room.game.confirmRematch(ws.id);
        else if (msg.type === 'SKIP_COMPARISON') room.game.requestComparisonSkip(ws.id);
        else if (msg.type === 'END_GAME') { room.game.endGame(); return closeRoom(room, 'GAME_ENDED'); }
        else throw new Error('Unknown message type');
        broadcast(room, 'ROOM_STATE', coinAction ? { coinAction } : {});
      } catch (error) {
        if (msg?.type === 'SEND_CHAT') return send(ws, 'CHAT_ERROR', {
          roomId: typeof msg.roomId === 'string' ? msg.roomId : null,
          clientMessageId: typeof msg.clientMessageId === 'string' ? msg.clientMessageId : null,
          code: error.code || 'CHAT_INVALID_MESSAGE', message: error.message
        });
        send(ws, 'ERROR', { message: error.message });
      }
    });
    ws.on('close', () => leaveRoom(ws));
  });
  return { httpServer, wss, manager, listen: () => new Promise(resolve => httpServer.listen(port, host, () => resolve(httpServer.address()))), close: () => new Promise(resolve => { clearInterval(heartbeat); wss.clients.forEach(client => client.terminate()); wss.close(() => httpServer.close(resolve)); }) };
}

if (require.main === module) createServer({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000) }).listen().then(address => console.log(`Poker server listening on ${address.address}:${address.port}`));
module.exports = { createServer, RoomManager };
