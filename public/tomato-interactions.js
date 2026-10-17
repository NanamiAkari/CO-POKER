/* Lightweight, game-state-independent player interaction effects. */
(() => {
  'use strict';

  const DEFAULT_FLIGHT_MS = 1100;
  const DEFAULT_IMPACT_MS = 1500;
  const REDUCED_IMPACT_MS = 500;
  const PROJECTILE_SRC = '/assets/tomato.svg';
  const SPLAT_SRC = '/assets/tomato-splat.svg';

  function unwrap(value) {
    if (typeof value === 'function') return value();
    // Vue refs expose value on their prototype; hasOwnProperty misses it.
    if (value && typeof value === 'object' && 'value' in value) return value.value;
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
    const frame = () => unwrap(options.frame) || doc?.defaultView || (typeof window === 'object' ? window : null);
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
    const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
    const onImpact = typeof options.onImpact === 'function' ? options.onImpact : () => {};
    const flightMs = Number.isFinite(options.flightMs) ? Math.max(0, options.flightMs) : DEFAULT_FLIGHT_MS;
    const impactMs = Number.isFinite(options.impactMs) ? Math.max(0, options.impactMs) : DEFAULT_IMPACT_MS;
    const activeFlights = [];
    const seenActions = new Set();
    const timers = new Set();
    const activeHits = new Map();
    let serial = 0;

    const currentRoom = () => String(unwrap(room) || '');
    const currentPlayer = () => String(unwrap(sender) || '');
    const prefersReducedMotion = () => options.reducedMotion !== undefined
      ? Boolean(unwrap(options.reducedMotion))
      : Boolean(frame()?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    function schedule(callback, delay) {
      const timer = setTimer(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
      return timer;
    }

    function cancelFlightTimer(flight) {
      if (flight.timer == null) return;
      clearTimer(flight.timer);
      timers.delete(flight.timer);
      flight.timer = null;
    }

    function removeFlight(flight) {
      if (flight.status === 'done') return;
      cancelFlightTimer(flight);
      flight.visual?.removeEventListener?.('animationend', flight.onAnimationEnd);
      if (flight.visual?.parentNode) flight.visual.parentNode.removeChild(flight.visual);
      const index = activeFlights.indexOf(flight);
      if (index !== -1) activeFlights.splice(index, 1);
      if (flight.didHit) {
        const remaining = (activeHits.get(flight.target) || 1) - 1;
        if (remaining) activeHits.set(flight.target, remaining);
        else { activeHits.delete(flight.target); flight.target?.classList?.remove('tomato-hit'); }
      }
      flight.status = 'done';
    }

    function finishVisual(flight) {
      if (flight.status !== 'flying') return;
      cancelFlightTimer(flight);
      flight.visual?.removeEventListener?.('animationend', flight.onAnimationEnd);
      flight.status = 'impact';
      try { onImpact(flight.action); } catch (_) { /* cosmetic audio must never block the animation */ }
      // The whole fruit disappears immediately. Only the splat and particles
      // remain during the independent impact/hold/fade animation.
      if (flight.projectile) flight.projectile.hidden = true;
      flight.visual?.classList?.add('tomato-impact');
      if (flight.target && !flight.reducedMotion) {
        flight.didHit = true;
        activeHits.set(flight.target, (activeHits.get(flight.target) || 0) + 1);
        flight.target.classList?.add('tomato-hit');
      }
      flight.timer = schedule(() => removeFlight(flight), flight.impactMs);
    }

    function visibleRect(element) {
      if (!element || element.isConnected === false || typeof element.getBoundingClientRect !== 'function') return null;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const viewport = frame();
      const style = viewport?.getComputedStyle?.(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return null;
      const right = rect.right ?? rect.left + rect.width;
      const bottom = rect.bottom ?? rect.top + rect.height;
      if (right <= 0 || bottom <= 0 || (viewport?.innerWidth && rect.left >= viewport.innerWidth) || (viewport?.innerHeight && rect.top >= viewport.innerHeight)) return null;
      return rect;
    }

    function resolveAnchor(playerId, allowSpectator = false) {
      if (!doc || !playerId) return null;
      // Hidden seats can remain in the DOM during settlement. Resolve a live
      // visible anchor, including the visible settlement row when present.
      for (const [selector, key] of [['[data-player]', 'player'], ['[data-owner-anchor]', 'ownerAnchor'], ['[data-spectator-anchor]', 'spectatorAnchor']]) {
        for (const element of doc.querySelectorAll?.(selector) || []) {
          if (element.dataset?.[key] !== playerId) continue;
          const rect = visibleRect(element);
          if (rect) return { element, rect };
        }
      }
      // Observers share a table-side source anchor and do not occupy a seat.
      if (allowSpectator) {
        for (const element of doc.querySelectorAll?.('[data-spectator-anchor]') || []) {
          const rect = visibleRect(element);
          if (rect) return { element, rect };
        }
      }
      return null;
    }

    function child(parent, tag, className) {
      const node = doc.createElement(tag);
      node.className = className;
      node.setAttribute?.('aria-hidden', 'true');
      parent.appendChild(node);
      return node;
    }

    function addBurst(visual) {
      const burst = child(visual, 'span', 'tomato-burst');
      const splat = child(burst, 'img', 'tomato-splat');
      splat.src = SPLAT_SRC;
      splat.alt = '';
      splat.draggable = false;
      const droplets = [[-60,-27],[-42,-60],[-10,-71],[34,-62],[68,-26],[72,20],[44,57],[-27,69],[-64,39],[-76,6]];
      droplets.forEach(([x,y], index) => {
        const drop = child(burst, 'i', 'tomato-droplet');
        drop.style.setProperty('--drop-x', `${x}px`);
        drop.style.setProperty('--drop-y', `${y}px`);
        drop.style.setProperty('--drop-delay', `${index % 3 * 16}ms`);
        drop.style.setProperty('--drop-scale', `${index % 3 === 0 ? 1.12 : index % 3 === 1 ? .85 : .62}`);
        drop.style.setProperty('--drop-rotation', `${Math.round(Math.atan2(y,x) * 180 / Math.PI) + 90}deg`);
      });
      [[-34,-21],[29,-37],[44,26],[-21,46],[1,-51]].forEach(([x,y], index) => {
        const seed = child(burst, 'i', 'tomato-seed');
        seed.style.setProperty('--seed-x', `${x}px`);
        seed.style.setProperty('--seed-y', `${y}px`);
        seed.style.setProperty('--seed-delay', `${index * 13}ms`);
      });
    }

    function createVisual(flight) {
      const source = resolveAnchor(flight.action.fromPlayerId, true);
      const target = resolveAnchor(flight.action.toPlayerId);
      if (!doc?.body || !source || !target) return;
      flight.source = source.element;
      flight.target = target.element;
      const sourceX = source.rect.left + source.rect.width / 2;
      const sourceY = source.rect.top + source.rect.height / 2;
      const targetX = target.rect.left + target.rect.width / 2;
      const targetY = target.rect.top + target.rect.height / 2;
      const dx = targetX - sourceX, dy = targetY - sourceY;
      const arc = Math.max(48, Math.min(120, Math.abs(dx) * .15 + 46));
      const visual = doc.createElement('span');
      visual.className = `tomato-flight${flight.reducedMotion ? ' tomato-reduced' : ''}`;
      visual.setAttribute?.('role', 'img');
      visual.setAttribute?.('aria-label', '番茄飞向玩家并炸开');
      visual.style.left = `${sourceX - 26}px`;
      visual.style.top = `${sourceY - 26}px`;
      visual.style.setProperty('--tomato-x', `${dx}px`);
      visual.style.setProperty('--tomato-y', `${dy}px`);
      visual.style.setProperty('--tomato-half-x', `${dx * .5}px`);
      visual.style.setProperty('--tomato-mid-y', `${dy * .5 - arc}px`);
      // Durations belong to distinct CSS variables; an inline animationDuration
      // would override the impact duration after its class changed.
      visual.style.setProperty('--tomato-flight-ms', `${flight.flightMs}ms`);
      visual.style.setProperty('--tomato-impact-ms', `${flight.impactMs}ms`);
      const projectile = child(visual, 'img', 'tomato-projectile');
      projectile.src = PROJECTILE_SRC;
      projectile.alt = '';
      projectile.draggable = false;
      flight.projectile = projectile;
      addBurst(visual);
      doc.body.appendChild(visual);
      flight.visual = visual;
      if (!flight.flightMs) finishVisual(flight);
      else {
        flight.onAnimationEnd = event => {
          if (event.target === visual && event.animationName === 'tomato-flight-path') finishVisual(flight);
        };
        visual.addEventListener('animationend', flight.onAnimationEnd);
        // Hidden tabs can defer animationend; do not leak visual nodes there.
        flight.timer = schedule(() => finishVisual(flight), flight.flightMs + 60);
      }
    }

    function normaliseAction(message) {
      if (!message || message.type !== 'TOMATO_THROW' || !message.action || typeof message.action !== 'object') return null;
      const action = message.action;
      if (message.roomId != null && String(message.roomId) !== currentRoom()) return null;
      if (typeof action.actionId !== 'string' || !action.actionId || action.actionId.length > 120) return null;
      if (typeof action.fromPlayerId !== 'string' || !action.fromPlayerId || action.fromPlayerId.length > 80) return null;
      if (typeof action.toPlayerId !== 'string' || !action.toPlayerId || action.toPlayerId.length > 80 || action.toPlayerId === action.fromPlayerId) return null;
      return { actionId:action.actionId, fromPlayerId:action.fromPlayerId, toPlayerId:action.toPlayerId, timestamp:integerTimestamp(action.timestamp,clock()) };
    }

    function sendTomato(toPlayerId) {
      const fromPlayerId = currentPlayer(), target = String(toPlayerId || ''), roomId = currentRoom();
      if (!roomId || !fromPlayerId || !target || target === fromPlayerId) return false;
      const action = { actionId:`${fromPlayerId}-${integerTimestamp(clock(),Date.now())}-${++serial}`, fromPlayerId, toPlayerId:target, timestamp:integerTimestamp(clock(),Date.now()) };
      let accepted;
      try { accepted = send({ type:'TOMATO_THROW', roomId, action }); } catch (_) { return false; }
      return accepted === false ? false : action;
    }

    function handleTomatoMessage(message) {
      const action = normaliseAction(message);
      if (!action || seenActions.has(action.actionId)) return false;
      seenActions.add(action.actionId);
      const reducedMotion = prefersReducedMotion();
      const flight = { action, status:'flying', visual:null, projectile:null, source:null, target:null, timer:null, onAnimationEnd:null, didHit:false, reducedMotion,
        flightMs:reducedMotion ? 0 : flightMs, impactMs:reducedMotion ? Math.min(impactMs,REDUCED_IMPACT_MS) : impactMs };
      activeFlights.push(flight);
      createVisual(flight);
      if (!flight.visual) flight.timer = schedule(() => removeFlight(flight), flight.flightMs + flight.impactMs);
      return action;
    }

    function reset() {
      for (const flight of [...activeFlights]) removeFlight(flight);
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      activeHits.clear();
      seenActions.clear();
      serial = 0;
    }

    return { sendTomato, handleTomatoMessage, reset, tomatoFlights:activeFlights, activeFlights };
  }

  const api = { create, DEFAULT_FLIGHT_MS, DEFAULT_IMPACT_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.TomatoInteractions = api;
})();
