/* Lightweight, game-state-independent player interaction effects. */
(() => {
  'use strict';

  const DEFAULT_FLIGHT_MS = 900;
  const DEFAULT_IMPACT_MS = 240;

  function unwrap(value) {
    if (typeof value === 'function') return value();
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
    return value;
  }

  function integerTimestamp(value, fallback) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp) : fallback;
  }

  function create(options = {}) {
    const room = options.roomId;
    const sender = options.playerId;
    const send = typeof options.send === 'function' ? options.send : () => false;
    const doc = options.document || (typeof document === 'object' ? document : null);
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    const flightMs = Number.isFinite(options.flightMs) ? Math.max(0, options.flightMs) : DEFAULT_FLIGHT_MS;
    const impactMs = Number.isFinite(options.impactMs) ? Math.max(0, options.impactMs) : DEFAULT_IMPACT_MS;
    const activeFlights = [];
    const seenActions = new Set();
    const timers = new Set();
    let serial = 0;

    const valueOf = value => unwrap(value);
    const currentRoom = () => String(valueOf(room) || '');
    const currentPlayer = () => String(valueOf(sender) || '');

    function schedule(callback, delay) {
      const timer = setTimer(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    }

    function removeFlight(flight) {
      const index = activeFlights.indexOf(flight);
      if (index !== -1) activeFlights.splice(index, 1);
      if (flight.timer != null) {
        clearTimer(flight.timer);
        timers.delete(flight.timer);
        flight.timer = null;
      }
      if (flight.visual?.parentNode) flight.visual.parentNode.removeChild(flight.visual);
      flight.target?.classList?.remove('tomato-hit');
      flight.status = 'done';
    }

    function finishVisual(flight) {
      if (flight.status === 'done' || flight.status === 'impact') return;
      flight.status = 'impact';
      flight.visual?.classList?.add('tomato-impact');
      flight.target?.classList?.add('tomato-hit');
      flight.timer = schedule(() => removeFlight(flight), impactMs);
    }

    function resolveAnchor(playerId) {
      if (!doc || !playerId) return null;
      const elements = [];
      // data-player is the preferred seat anchor. data-owner-anchor supports
      // the coin slot used by the table while the seat is being rendered.
      for (const selector of ['[data-player]', '[data-owner-anchor]']) {
        for (const element of doc.querySelectorAll?.(selector) || []) {
          if (element.dataset?.player === playerId || element.dataset?.ownerAnchor === playerId) elements.push(element);
        }
        if (elements.length) break;
      }
      return elements[0] || null;
    }

    function createVisual(flight) {
      const from = resolveAnchor(flight.action.fromPlayerId);
      const target = resolveAnchor(flight.action.toPlayerId);
      flight.source = from;
      flight.target = target;
      if (!doc || !from || !target || typeof from.getBoundingClientRect !== 'function' || typeof target.getBoundingClientRect !== 'function') return;
      const sourceRect = from.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const sourceX = sourceRect.left + sourceRect.width / 2;
      const sourceY = sourceRect.top + sourceRect.height / 2;
      const targetX = targetRect.left + targetRect.width / 2;
      const targetY = targetRect.top + targetRect.height / 2;
      const visual = doc.createElement('span');
      visual.className = 'tomato-flight';
      visual.textContent = '🍅';
      visual.setAttribute('role', 'img');
      visual.setAttribute('aria-label', '番茄互动');
      visual.style.left = `${sourceX - 18}px`;
      visual.style.top = `${sourceY - 18}px`;
      visual.style.setProperty('--tomato-x', `${targetX - sourceX}px`);
      visual.style.setProperty('--tomato-y', `${targetY - sourceY}px`);
      visual.style.setProperty('--tomato-arc', `${Math.max(34, Math.min(96, Math.abs(targetX - sourceX) * .14 + 34))}px`);
      visual.style.animationDuration = `${flightMs}ms`;
      doc.body?.appendChild(visual);
      flight.visual = visual;
      if (flightMs === 0) finishVisual(flight);
      else {
        // CSS animationend is preferred, with a timer fallback for hidden
        // tabs and browsers that do not implement animation events.
        visual.addEventListener?.('animationend', event => {
          if (event.animationName === 'tomato-flight-path') finishVisual(flight);
        }, { once: true });
        flight.timer = schedule(() => finishVisual(flight), flightMs + 40);
      }
    }

    function normaliseAction(message) {
      if (!message || message.type !== 'TOMATO_THROW' || typeof message.action !== 'object') return null;
      const action = message.action;
      if (message.roomId != null && String(message.roomId) !== currentRoom()) return null;
      if (typeof action.actionId !== 'string' || !action.actionId || action.actionId.length > 120) return null;
      if (typeof action.fromPlayerId !== 'string' || !action.fromPlayerId || action.fromPlayerId.length > 80) return null;
      if (typeof action.toPlayerId !== 'string' || !action.toPlayerId || action.toPlayerId.length > 80 || action.toPlayerId === action.fromPlayerId) return null;
      return {
        actionId: action.actionId,
        fromPlayerId: action.fromPlayerId,
        toPlayerId: action.toPlayerId,
        timestamp: integerTimestamp(action.timestamp, clock())
      };
    }

    function sendTomato(toPlayerId) {
      const fromPlayerId = currentPlayer();
      const target = String(toPlayerId || '');
      const roomId = currentRoom();
      if (!roomId || !fromPlayerId || !target || target === fromPlayerId) return false;
      const action = {
        actionId: `${fromPlayerId}-${integerTimestamp(clock(), Date.now())}-${++serial}`,
        fromPlayerId,
        toPlayerId: target,
        timestamp: integerTimestamp(clock(), Date.now())
      };
      let accepted;
      try { accepted = send({ type: 'TOMATO_THROW', roomId, action }); } catch (_) { return false; }
      if (accepted === false) return false;
      return action;
    }

    function handleTomatoMessage(message) {
      const action = normaliseAction(message);
      if (!action || seenActions.has(action.actionId)) return false;
      seenActions.add(action.actionId);
      const flight = { action, status: 'flying', visual: null, source: null, target: null, timer: null };
      activeFlights.push(flight);
      createVisual(flight);
      if (!flight.visual) flight.timer = schedule(() => removeFlight(flight), flightMs + impactMs);
      return action;
    }

    function reset() {
      for (const timer of [...timers]) clearTimer(timer);
      timers.clear();
      for (const flight of [...activeFlights]) removeFlight(flight);
      activeFlights.length = 0;
      seenActions.clear();
      serial = 0;
    }

    return {
      sendTomato,
      handleTomatoMessage,
      reset,
      tomatoFlights: activeFlights,
      activeFlights
    };
  }

  const api = { create, DEFAULT_FLIGHT_MS, DEFAULT_IMPACT_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.TomatoInteractions = api;
})();
