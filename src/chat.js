const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
const HISTORY_LIMIT = 100;
const TEXT_LIMIT = 200;
const RATE_WINDOW_MS = 2000;
const RATE_LIMIT = 5;
const RECEIPT_LIMIT = 512;

class ChatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function loadStickerCatalog(catalogFile = path.join(PUBLIC_ROOT, 'stickers', 'catalog.json'), publicRoot = PUBLIC_ROOT) {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    if (!Array.isArray(catalog)) return [];
    const seen = new Set();
    return catalog.filter(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || seen.has(item.id)) return false;
      if (typeof item.label !== 'string' || !item.label.trim() || [...item.label.trim()].length > 30) return false;
      if (typeof item.src !== 'string' || !/^\/stickers\/[a-zA-Z0-9/_-]+\.(svg|png|jpe?g|gif|webp)$/.test(item.src) || item.src.includes('..')) return false;
      const file = path.resolve(publicRoot, item.src.replace(/^\//, ''));
      const stickerRoot = fs.realpathSync(path.join(publicRoot, 'stickers'));
      let relative;
      try { relative = path.relative(stickerRoot, fs.realpathSync(file)); } catch { return false; }
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) return false;
      seen.add(item.id);
      return true;
    }).slice(0, 60).map(({ id, src, label }) => ({ id, src, label: label.trim() }));
  } catch { return []; }
}

class RoomChat {
  constructor({ now = Date.now, stickerCatalog = loadStickerCatalog() } = {}) {
    this.now = now;
    this.stickerIds = new Set(stickerCatalog.map(item => item.id));
    this.history = [];
    this.sequence = 0;
    // A connection owns its receipts: reconnecting or leaving cannot impersonate
    // another sender, and disconnected connections do not keep this cache alive.
    this.senders = new WeakMap();
  }

  accept(client, input) {
    if (typeof input.clientMessageId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(input.clientMessageId)) {
      throw new ChatError('CHAT_INVALID_ID', '消息编号无效，请重新发送');
    }
    let content;
    if (input.kind === 'text') {
      if (typeof input.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) {
        throw new ChatError('CHAT_INVALID_TEXT', '消息内容无效');
      }
      const text = input.text.trim();
      if (!text) throw new ChatError('CHAT_EMPTY', '请先输入消息');
      if ([...text].length > TEXT_LIMIT) throw new ChatError('CHAT_TOO_LONG', '消息最多 200 个字');
      content = { kind: 'text', text };
    } else if (input.kind === 'sticker') {
      if (typeof input.stickerId !== 'string' || !this.stickerIds.has(input.stickerId)) {
        throw new ChatError('CHAT_UNKNOWN_STICKER', '这个表情包暂时不可用');
      }
      content = { kind: 'sticker', stickerId: input.stickerId };
    } else {
      throw new ChatError('CHAT_INVALID_KIND', '不支持这种消息');
    }

    let sender = this.senders.get(client);
    if (!sender) {
      sender = { receipts: new Map(), recent: [] };
      this.senders.set(client, sender);
    }
    const receipt = sender.receipts.get(input.clientMessageId);
    const fingerprint = JSON.stringify(content);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ChatError('CHAT_DUPLICATE_ID', '消息编号已被使用，请重新发送');
      return { message: receipt.message, duplicate: true };
    }
    const timestamp = this.now();
    sender.recent = sender.recent.filter(sentAt => timestamp - sentAt < RATE_WINDOW_MS);
    if (sender.recent.length >= RATE_LIMIT) throw new ChatError('CHAT_RATE_LIMITED', '发送太快了，请稍后再试');

    const message = { id: ++this.sequence, playerId: client.id, role: client.role, ...content, timestamp, clientMessageId: input.clientMessageId };
    sender.recent.push(timestamp);
    sender.receipts.set(input.clientMessageId, { fingerprint, message });
    if (sender.receipts.size > RECEIPT_LIMIT) sender.receipts.delete(sender.receipts.keys().next().value);
    this.history.push(message);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    return { message, duplicate: false };
  }

  forget(client) { this.senders.delete(client); }
}

module.exports = { RoomChat, ChatError, loadStickerCatalog, HISTORY_LIMIT, TEXT_LIMIT };
