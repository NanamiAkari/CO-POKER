(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomChat = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  const MAX_LENGTH = 200;
  const MAX_HISTORY = 100;
  const EMOJIS = Object.freeze([
    ['😀', '开心'], ['😂', '大笑'], ['😊', '微笑'], ['😎', '自信'], ['🤔', '思考'],
    ['😅', '汗颜'], ['😮', '惊讶'], ['😭', '哭泣'], ['🥳', '庆祝'], ['😴', '困了'],
    ['👍', '赞'], ['👎', '不赞同'], ['👏', '鼓掌'], ['🙏', '拜托'], ['🤝', '握手'],
    ['❤️', '红心'], ['🔥', '火热'], ['✨', '闪光'], ['🎉', '礼花'], ['🍀', '好运']
  ].map(([emoji, label]) => Object.freeze({ emoji, label })));

  function cleanCatalog(catalog) {
    if (!Array.isArray(catalog)) return [];
    const ids = new Set();
    return catalog.filter(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id)) return false;
      if (typeof item.src !== 'string' || !/^\/stickers\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|jpe?g|gif|webp)$/.test(item.src)) return false;
      if (typeof item.label !== 'string' || !item.label.trim() || Array.from(item.label.trim()).length > 30) return false;
      ids.add(item.id);
      return true;
    }).slice(0, 60).map(({ id, label, src }) => ({ id, label: label.trim(), src }));
  }

  function create(options) {
    const { Vue, roomId, playerId, connected, send } = options;
    const { ref, computed, nextTick } = Vue;
    const chatOpen = ref(true), chatDraft = ref(''), chatMessages = ref([]), chatUnread = ref(0);
    const chatPanel = ref(null), chatError = ref(''), chatSending = ref(false);
    const chatInput = ref(null), chatLog = ref(null), chatStickers = ref(cleanCatalog(options.catalog));
    const chatDraftLength = computed(() => Array.from(chatDraft.value).length);
    const chatCanSend = computed(() => connected.value && Boolean(roomId.value) && !chatSending.value && Boolean(chatDraft.value.trim()) && Array.from(chatDraft.value.trim()).length <= MAX_LENGTH);
    let pending = null, lastFailure = null, ackTimer = null, serial = 0, composing = false;
    let generation = 0, savedSelection = null;
    const session = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

    function clearPending() {
      clearTimeout(ackTimer);
      ackTimer = null;
      pending = null;
      chatSending.value = false;
    }

    function scrollToLatest(force) {
      const log = chatLog.value;
      const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 90;
      if (!chatOpen.value || (!force && !nearBottom)) return;
      const epoch = generation;
      nextTick(() => {
        if (epoch !== generation || !chatOpen.value || !chatLog.value) return;
        chatLog.value.scrollTop = chatLog.value.scrollHeight;
      });
    }

    function toggleChat() {
      chatOpen.value = !chatOpen.value;
      chatPanel.value = null;
      if (chatOpen.value) { chatUnread.value = 0; scrollToLatest(true); }
    }

    function rememberSelection() {
      const input = chatInput.value;
      if (input && Number.isInteger(input.selectionStart)) savedSelection = [input.selectionStart, input.selectionEnd];
    }

    function toggleChatPanel(panel) {
      rememberSelection();
      chatPanel.value = chatPanel.value === panel ? null : ['emoji', 'stickers'].includes(panel) ? panel : null;
    }

    function insertEmoji(value) {
      const emoji = typeof value === 'string' ? value : value?.emoji;
      if (!EMOJIS.some(item => item.emoji === emoji)) return false;
      const input = chatInput.value;
      const draft = chatDraft.value;
      const selection = input && Number.isInteger(input.selectionStart) ? [input.selectionStart, input.selectionEnd] : savedSelection || [draft.length, draft.length];
      const start = Math.max(0, Math.min(draft.length, selection[0]));
      const end = Math.max(start, Math.min(draft.length, selection[1]));
      const valueWithEmoji = draft.slice(0, start) + emoji + draft.slice(end);
      if (Array.from(valueWithEmoji).length > MAX_LENGTH) { chatError.value = '消息最多 200 个字符'; return false; }
      chatDraft.value = valueWithEmoji;
      chatError.value = '';
      const caret = start + emoji.length;
      savedSelection = [caret, caret];
      const epoch = generation;
      nextTick(() => {
        if (epoch !== generation || !chatInput.value) return;
        chatInput.value.focus();
        chatInput.value.setSelectionRange(caret, caret);
      });
      return true;
    }

    function acknowledge(message) {
      if (message.playerId !== playerId.value) return;
      const request = pending?.clientMessageId === message.clientMessageId ? pending : lastFailure?.clientMessageId === message.clientMessageId ? lastFailure : null;
      if (!request) return;
      if (request.kind === 'text' && chatDraft.value.startsWith(request.draft)) chatDraft.value = chatDraft.value.slice(request.draft.length);
      if (pending === request) clearPending();
      if (lastFailure === request) lastFailure = null;
      chatError.value = '';
    }

    function failure(request, message) {
      if (pending !== request) return;
      lastFailure = request;
      clearPending();
      chatError.value = message;
    }

    function deliver(kind, content) {
      if (!connected.value || !roomId.value) { chatError.value = '连接中，稍后再试'; return false; }
      if (pending) return false;
      const retry = lastFailure && lastFailure.roomId === roomId.value && lastFailure.kind === kind && (kind === 'text' ? lastFailure.text === content.text && lastFailure.draft === chatDraft.value : lastFailure.stickerId === content.stickerId);
      const request = retry ? lastFailure : { roomId: roomId.value, clientMessageId: session + '-' + (++serial), kind, ...content, draft: kind === 'text' ? chatDraft.value : null };
      pending = request;
      lastFailure = null;
      chatSending.value = true;
      chatError.value = '';
      ackTimer = setTimeout(() => failure(request, '消息未确认，请重试'), options.ackTimeoutMs ?? 10000);
      if (ackTimer && typeof ackTimer.unref === 'function') ackTimer.unref();
      const payload = { type: 'SEND_CHAT', roomId: request.roomId, clientMessageId: request.clientMessageId, kind };
      if (kind === 'text') payload.text = request.text;
      else payload.stickerId = request.stickerId;
      try {
        if (send(payload) === false) { failure(request, '连接中，稍后再试'); return false; }
      } catch (_) { failure(request, '发送失败，请重试'); return false; }
      chatPanel.value = null;
      return true;
    }

    function sendChat() {
      const text = chatDraft.value.trim();
      if (!text) return false;
      if (Array.from(text).length > MAX_LENGTH) { chatError.value = '消息最多 200 个字符'; return false; }
      return deliver('text', { text });
    }

    function sendSticker(id) {
      if (!chatStickers.value.some(item => item.id === id)) { chatError.value = '该表情包暂不可用'; return false; }
      return deliver('sticker', { stickerId: id });
    }

    function chatKeydown(event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
      event.preventDefault();
      sendChat();
    }

    function chatCompositionStart() { composing = true; }
    function chatCompositionEnd() { composing = false; }

    function mergeMessages(messages, live) {
      const merged = new Map(chatMessages.value.map(message => [message.id, message]));
      let changed = false, own = false;
      for (const message of messages) {
        if (!message || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.playerId !== 'string' || !['text', 'sticker'].includes(message.kind)) continue;
        if (message.kind === 'text' && typeof message.text !== 'string') continue;
        if (message.kind === 'sticker' && typeof message.stickerId !== 'string') continue;
        acknowledge(message);
        if (merged.has(message.id)) continue;
        merged.set(message.id, { ...message });
        changed = true;
        if (message.playerId === playerId.value) own = true;
        else if (live && !chatOpen.value) chatUnread.value += 1;
      }
      if (!changed) return;
      scrollToLatest(own);
      chatMessages.value = [...merged.values()].sort((a, b) => a.id - b.id).slice(-MAX_HISTORY);
    }

    function handleChatMessage(message) {
      if (!message || typeof message !== 'object') return false;
      const dedicated = message.type === 'CHAT_MESSAGE' || message.type === 'CHAT_ERROR';
      if (message.roomId !== roomId.value || !roomId.value) return dedicated;
      if (message.type === 'CHAT_MESSAGE') { mergeMessages([message.message], true); return true; }
      if (message.type === 'CHAT_ERROR') {
        if (pending && message.clientMessageId === pending.clientMessageId) failure(pending, message.message || '发送失败，请重试');
        return true;
      }
      if (['ROOM_CREATED', 'ROOM_STATE'].includes(message.type) && Array.isArray(message.chatHistory)) mergeMessages(message.chatHistory, false);
      return false;
    }

    function setChatStickers(catalog) { chatStickers.value = cleanCatalog(catalog); }

    async function loadChatStickers() {
      try {
        const response = await (options.fetch || fetch)('/stickers/catalog.json');
        if (!response.ok) return;
        setChatStickers(await response.json());
      } catch (_) { /* An empty catalog leaves text and emoji chat available. */ }
    }

    function resetChat() {
      generation += 1;
      clearPending();
      lastFailure = null;
      savedSelection = null;
      composing = false;
      chatOpen.value = true;
      chatDraft.value = '';
      chatMessages.value = [];
      chatUnread.value = 0;
      chatPanel.value = null;
      chatError.value = '';
    }

    return {
      chatOpen, chatDraft, chatMessages, chatUnread, chatPanel, chatError, chatSending, chatInput, chatLog,
      chatEmojis: EMOJIS, chatStickers, chatMaxLength: MAX_LENGTH, chatDraftLength, chatCanSend,
      toggleChat, toggleChatPanel, insertEmoji, sendChat, sendSticker, chatKeydown, chatCompositionStart, chatCompositionEnd,
      handleChatMessage, resetChat, loadChatStickers, setChatStickers,
      chatSticker: id => chatStickers.value.find(item => item.id === id) || null
    };
  }

  return Object.freeze({ create });
});
