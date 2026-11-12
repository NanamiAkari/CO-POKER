(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlayerMarks = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  const STORAGE_KEY = 'poker.privateMarks.v1';
  const MAX_ROOMS = 8;
  const CATEGORIES = Object.freeze(['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺']);
  const RANKS = Object.freeze([
    { value: 14, label: 'A' }, { value: 13, label: 'K' }, { value: 12, label: 'Q' },
    { value: 11, label: 'J' }, { value: 10, label: '10' }, { value: 9, label: '9' },
    { value: 8, label: '8' }, { value: 7, label: '7' }, { value: 6, label: '6' },
    { value: 5, label: '5' }, { value: 4, label: '4' }, { value: 3, label: '3' },
    { value: 2, label: '2' }
  ]);
  const SUITS = Object.freeze([
    { value: 's', label: '♠ 黑桃' }, { value: 'h', label: '♥ 红桃' },
    { value: 'c', label: '♣ 梅花' }, { value: 'd', label: '♦ 方块' }
  ]);
  const SUIT_LABELS = Object.freeze({ s: '♠', h: '♥', c: '♣', d: '♦' });
  const JOKER_LABELS = Object.freeze({ red: '大王', black: '小王' });

  function cardKey(card) {
    if (!card) return '';
    if (card.joker) return `joker:${card.joker}`;
    return `${card.rank}/${card.suit}`;
  }

  function isValidCard(card, includeJokers) {
    if (!card) return false;
    if (card.joker) return includeJokers && (card.joker === 'red' || card.joker === 'black');
    return Number.isInteger(card.rank) && card.rank >= 2 && card.rank <= 14 && ['s', 'h', 'c', 'd'].includes(card.suit);
  }

  function cardText(card) {
    if (!card) return '';
    if (card.joker) return JOKER_LABELS[card.joker] || '王';
    const rank = RANKS.find(item => item.value === card.rank)?.label || String(card.rank || '');
    return `${rank}${SUIT_LABELS[card.suit] || ''}`;
  }

  function sanitizeCards(cards, handCount, includeJokers) {
    if (!Array.isArray(cards)) return [];
    const result = [];
    const seen = new Set();
    for (const card of cards) {
      if (!isValidCard(card, includeJokers)) continue;
      const normalized = card.joker ? { joker: card.joker } : { rank: card.rank, suit: card.suit };
      const key = cardKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
      if (result.length >= Math.max(1, Math.min(handCount || 2, 3))) break;
    }
    return result;
  }

  function sanitizeMark(mark, handCount, includeJokers) {
    if (!mark || typeof mark !== 'object') return null;
    const category = CATEGORIES.includes(mark.category) ? mark.category : '';
    const cards = sanitizeCards(mark.cards, handCount, includeJokers);
    if (!category && !cards.length) return null;
    return {
      category,
      cards,
      updatedAt: Number.isFinite(mark.updatedAt) ? mark.updatedAt : Date.now()
    };
  }

  // Compact, text-free category pictograms for the card backs. The strings
  // are generated locally from a closed whitelist, never from user input.
  function markIconSvg(category) {
    const open = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">';
    const close = '</svg>';
    const pip = (x, y, r = 2) => `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" fill="currentColor"/>`;
    if (category === '一对') return `${open}<rect x="4" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="12" y="6" width="8" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="16" cy="12" r="1.2" fill="currentColor"/>${close}`;
    if (category === '两对') return `${open}<circle cx="7" cy="8" r="2" fill="currentColor"/><circle cx="12" cy="8" r="2" fill="currentColor"/><circle cx="7" cy="16" r="2" fill="currentColor"/><circle cx="12" cy="16" r="2" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>${close}`;
    if (category === '三条') return `${open}<circle cx="12" cy="7" r="2.1" fill="currentColor"/><circle cx="7" cy="16" r="2.1" fill="currentColor"/><circle cx="17" cy="16" r="2.1" fill="currentColor"/>${close}`;
    if (category === '顺子') return `${open}<path d="M4 17h4v-4h4v-4h4V5h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${close}`;
    if (category === '同花') return `${open}<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/>${pip(12, 12, 3.8)}${pip(6.6, 6.6, 1.6)}${pip(17.4, 6.6, 1.6)}${pip(6.6, 17.4, 1.6)}${pip(17.4, 17.4, 1.6)}${close}`;
    if (category === '葫芦') return `${open}${pip(6, 8, 2.4)}${pip(12, 8, 2.4)}${pip(18, 8, 2.4)}${pip(9, 16, 2.4)}${pip(15, 16, 2.4)}${close}`;
    if (category === '四条') return `${open}<circle cx="7" cy="8" r="2" fill="currentColor"/><circle cx="17" cy="8" r="2" fill="currentColor"/><circle cx="7" cy="16" r="2" fill="currentColor"/><circle cx="17" cy="16" r="2" fill="currentColor"/>${close}`;
    if (category === '同花顺') return `${open}<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/>${pip(6, 18, 1.7)}${pip(9, 15, 1.7)}${pip(12, 12, 1.7)}${pip(15, 9, 1.7)}${pip(18, 6, 1.7)}${close}`;
    return `${open}<path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/>${close}`;
  }

  function parseStore(storage) {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeStore(storage, data) {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* local-only feature */ }
  }

  function pruneStore(data) {
    const rooms = Object.keys(data);
    if (rooms.length <= MAX_ROOMS) return data;
    const scored = rooms.map(room => {
      let latest = 0;
      const viewers = data[room] && typeof data[room] === 'object' ? data[room] : {};
      for (const marks of Object.values(viewers)) {
        if (!marks || typeof marks !== 'object') continue;
        for (const mark of Object.values(marks)) latest = Math.max(latest, Number(mark?.updatedAt) || 0);
      }
      return { room, latest };
    }).sort((a, b) => a.latest - b.latest);
    const remove = scored.slice(0, scored.length - MAX_ROOMS);
    for (const item of remove) delete data[item.room];
    return data;
  }

  function create(options = {}) {
    const { Vue, storage, roomId, playerId, handCount, includeJokers, now = Date.now } = options;
    if (!Vue || !roomId || !playerId) throw new Error('PlayerMarks requires Vue and player refs');
    const { reactive, ref, computed, watch } = Vue;
    const marks = reactive({});
    const markTarget = ref(null);
    const markDraft = reactive({ category: '', cards: [] });
    const markCategories = CATEGORIES;
    let loadedKey = '';

    const maxCards = computed(() => Math.max(1, Math.min(Number(handCount?.value) || 2, 3)));
    const jokersEnabled = computed(() => includeJokers?.value === true);
    const markDeckCards = computed(() => {
      const cards = [];
      for (const suit of ['s', 'h', 'c', 'd']) {
        for (const rank of RANKS) cards.push({ rank: rank.value, suit });
      }
      if (jokersEnabled.value) cards.push({ joker: 'red' }, { joker: 'black' });
      return cards;
    });
    const markDraftEmpty = computed(() => !markDraft.category && !markDraft.cards.length);

    function clearMemory() {
      for (const key of Object.keys(marks)) delete marks[key];
    }

    function currentKey() {
      const room = roomId.value;
      const viewer = playerId.value;
      if (!room || !viewer) return '';
      return `${room}\u0000${viewer}\u0000${maxCards.value}\u0000${jokersEnabled.value ? 1 : 0}`;
    }

    function load() {
      const room = roomId.value;
      const viewer = playerId.value;
      const key = currentKey();
      if (key === loadedKey) return;
      loadedKey = key;
      clearMemory();
      if (!key) return;
      const all = parseStore(storage);
      const entry = all?.[room]?.[viewer];
      if (!entry || typeof entry !== 'object') return;
      for (const [target, mark] of Object.entries(entry)) {
        const clean = sanitizeMark(mark, maxCards.value, jokersEnabled.value);
        if (clean) marks[target] = clean;
      }
    }

    function ensureLoaded() {
      if (currentKey() !== loadedKey) load();
    }

    function persist() {
      const room = roomId.value;
      const viewer = playerId.value;
      if (!room || !viewer) return;
      const all = parseStore(storage);
      all[room] = all[room] && typeof all[room] === 'object' ? all[room] : {};
      if (Object.keys(marks).length) all[room][viewer] = { ...marks };
      else delete all[room][viewer];
      if (!Object.keys(all[room]).length) delete all[room];
      writeStore(storage, pruneStore(all));
    }

    function markFor(targetId) {
      ensureLoaded();
      return marks[targetId] || null;
    }

    function guessCardsFor(targetId) {
      const mark = markFor(targetId);
      return mark?.cards ? mark.cards.slice(0, maxCards.value).map(card => ({ ...card })) : [];
    }

    function markSummary(targetId) {
      const mark = markFor(targetId);
      if (!mark) return '';
      if (mark.cards?.length) return mark.cards.map(cardText).join(' ');
      return mark.category || '有标记';
    }

    function markNote(targetId) {
      const mark = markFor(targetId);
      if (!mark) return '';
      return [mark.category, mark.cards?.length ? mark.cards.map(cardText).join(' ') : ''].filter(Boolean).join(' · ') || '有标记';
    }

    function hasMark(targetId) {
      return Boolean(markFor(targetId));
    }

    function openMark(targetId) {
      ensureLoaded();
      if (!targetId || targetId === playerId.value) return false;
      markTarget.value = targetId;
      const existing = marks[targetId];
      markDraft.category = existing?.category || '';
      markDraft.cards = existing?.cards?.map(card => ({ ...card })) || [];
      return true;
    }

    function closeMark() {
      markTarget.value = null;
      markDraft.category = '';
      markDraft.cards = [];
    }

    function saveMark() {
      ensureLoaded();
      const target = markTarget.value;
      if (!target) return null;
      const clean = sanitizeMark({
        category: markDraft.category,
        cards: markDraft.cards,
        updatedAt: now()
      }, maxCards.value, jokersEnabled.value);
      if (clean) marks[target] = clean;
      else delete marks[target];
      persist();
      closeMark();
      return clean;
    }

    function clearMark(targetId) {
      ensureLoaded();
      const target = targetId || markTarget.value;
      if (!target) return;
      delete marks[target];
      persist();
      if (markTarget.value === target) closeMark();
    }

    function resetRoom() {
      const room = roomId.value;
      const viewer = playerId.value;
      closeMark();
      clearMemory();
      loadedKey = '';
      if (!room || !viewer) return;
      const all = parseStore(storage);
      if (all[room]) {
        delete all[room][viewer];
        if (!Object.keys(all[room]).length) delete all[room];
        writeStore(storage, pruneStore(all));
      }
    }

    function selectMarkCategory(category) {
      markDraft.category = markDraft.category === category ? '' : category;
    }

    function markHasCard(card) {
      const key = cardKey(card);
      return markDraft.cards.some(item => cardKey(item) === key);
    }

    function toggleMarkCard(card) {
      if (!isValidCard(card, jokersEnabled.value)) return false;
      const normalized = card.joker ? { joker: card.joker } : { rank: card.rank, suit: card.suit };
      const key = cardKey(normalized);
      const index = markDraft.cards.findIndex(item => cardKey(item) === key);
      if (index >= 0) {
        markDraft.cards.splice(index, 1);
        return true;
      }
      if (markDraft.cards.length >= maxCards.value) return false;
      markDraft.cards.push(normalized);
      return true;
    }

    function removeMarkCard(index) {
      if (!Number.isInteger(index) || index < 0 || index >= markDraft.cards.length) return;
      markDraft.cards.splice(index, 1);
    }

    watch([roomId, playerId, maxCards, jokersEnabled], load, { immediate: true });

    return {
      marks,
      markTarget,
      markDraft,
      markCategories,
      maxMarkCards: maxCards,
      markDeckCards,
      markHasCard,
      markDraftEmpty,
      jokersEnabled,
      markFor,
      guessCardsFor,
      markSummary,
      markNote,
      hasMark,
      openMark,
      closeMark,
      saveMark,
      clearMark,
      resetRoom,
      selectMarkCategory,
      toggleMarkCard,
      removeMarkCard,
      cardText,
      markIconSvg
    };
  }

  return Object.freeze({
    create,
    sanitizeMark,
    cardKey,
    cardText,
    CATEGORIES,
    RANKS,
    SUITS,
    markIconSvg,
    STORAGE_KEY,
    MAX_ROOMS
  });
});
