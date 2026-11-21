/*
 * Match-point music.
 *
 * When a series reaches the score where one more loss ends the whole series
 * (a best-of-five sitting at two losses, for example), the table plays the
 * project-provided "never give up" track once. The cue respects the global
 * sound switch, fades in and out so it never cuts across table cues, and is
 * strictly cosmetic: a blocked or missing audio file cannot affect play.
 */
(() => {
  'use strict';

  const DEFAULT_SRC = '/assets/bgm/never-give-up.mp3?v=20261121-matchpoint';
  const DEFAULT_GAIN = 0.65;
  const FADE_IN_MS = 1200;
  const FADE_OUT_MS = 600;
  const FADE_STEP_MS = 50;

  function read(value, fallback) {
    if (typeof value === 'function') {
      try { return value(); } catch (_) { return fallback; }
    }
    // Vue refs expose value on their prototype; hasOwnProperty misses it.
    if (value && typeof value === 'object' && 'value' in value) return value.value;
    return value === undefined ? fallback : value;
  }

  function clamp01(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
  }

  // Match point here always means "one more loss ends the big game": with a
  // series length of 3 (first to three, best of five) that is two losses.
  function isMatchPoint({ seriesLength, successCount, failureCount, phase } = {}) {
    const target = Number(seriesLength);
    if (!Number.isInteger(target) || target < 1) return false;
    if (phase === 'GAME_OVER') return false;
    return Number(failureCount) === target - 1 && Number(successCount) < target;
  }

  function create(options = {}) {
    const src = typeof options.src === 'string' && options.src ? options.src : DEFAULT_SRC;
    const createAudio = typeof options.createAudio === 'function'
      ? options.createAudio
      : typeof Audio === 'function' ? () => new Audio() : null;
    const setTimer = typeof options.setInterval === 'function' ? options.setInterval : setInterval;
    const clearTimer = typeof options.clearInterval === 'function' ? options.clearInterval : clearInterval;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const fadeInMs = Number.isFinite(options.fadeInMs) ? Math.max(0, options.fadeInMs) : FADE_IN_MS;
    const fadeOutMs = Number.isFinite(options.fadeOutMs) ? Math.max(0, options.fadeOutMs) : FADE_OUT_MS;
    const gain = Number.isFinite(options.gain) ? clamp01(options.gain) : DEFAULT_GAIN;
    let audio = null;
    let fadeTimer = null;
    let wanted = false;
    let preloaded = false;

    const enabled = () => read(options.enabled, true) !== false;
    const targetVolume = () => clamp01(read(options.volume, 1)) * gain;

    function element() {
      if (audio || !createAudio) return audio;
      try { audio = createAudio(); } catch (_) { audio = null; }
      if (!audio) return null;
      try {
        audio.src = src;
        audio.preload = 'auto';
        audio.loop = false;
        audio.volume = 0;
        if (typeof audio.addEventListener === 'function') {
          audio.addEventListener('ended', () => { wanted = false; cancelFade(); });
          audio.addEventListener('error', () => { wanted = false; cancelFade(); });
        }
      } catch (_) { /* A broken element must only silence the music. */ }
      return audio;
    }

    function cancelFade() {
      if (fadeTimer == null) return;
      clearTimer(fadeTimer);
      fadeTimer = null;
    }

    function fadeTo(target, duration, done) {
      cancelFade();
      if (!audio) return;
      const to = clamp01(target);
      if (!duration) {
        try { audio.volume = to; } catch (_) { /* iOS can expose a read-only volume */ }
        if (done) done();
        return;
      }
      const from = clamp01(audio.volume);
      const started = now();
      fadeTimer = setTimer(() => {
        const progress = Math.min(1, (now() - started) / duration);
        try { audio.volume = from + (to - from) * progress; } catch (_) { /* ignore */ }
        if (progress >= 1) { cancelFade(); if (done) done(); }
      }, FADE_STEP_MS);
    }

    // Starts the track once. Repeated calls while it is already wanted are
    // no-ops so every extra snapshot cannot restart the song.
    function play() {
      if (!enabled()) return false;
      const node = element();
      if (!node) return false;
      if (wanted) return true;
      wanted = true;
      try { node.currentTime = 0; } catch (_) { /* not seekable before metadata */ }
      try { node.volume = 0; } catch (_) { /* ignore */ }
      try {
        const result = node.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => { wanted = false; cancelFade(); });
        }
      } catch (_) {
        wanted = false;
        return false;
      }
      fadeTo(targetVolume(), fadeInMs);
      return true;
    }

    function stop() {
      if (!audio) { wanted = false; return; }
      if (!wanted && audio.paused) { wanted = false; return; }
      wanted = false;
      const node = audio;
      fadeTo(0, fadeOutMs, () => { try { node.pause(); } catch (_) { /* ignore */ } });
    }

    function reset() {
      wanted = false;
      cancelFade();
      if (!audio) return;
      try { audio.pause(); } catch (_) { /* ignore */ }
      try { audio.currentTime = 0; } catch (_) { /* ignore */ }
      try { audio.volume = 0; } catch (_) { /* ignore */ }
    }

    // Fetch the track while the table is still one loss away from match point
    // so the cue starts on the beat instead of buffering 6 MB at the moment.
    function preload() {
      if (!enabled()) return false;
      if (wanted || preloaded) return true;
      const node = element();
      if (!node) return false;
      preloaded = true;
      try { node.load(); } catch (_) { /* ignore */ }
      return true;
    }

    function refreshVolume() {
      if (!audio || !wanted) return;
      fadeTo(targetVolume(), 0);
    }

    return {
      play,
      stop,
      reset,
      preload,
      refreshVolume,
      get playing() { return Boolean(audio && wanted && audio.paused === false); },
      get element() { return audio; }
    };
  }

  const api = { create, isMatchPoint, DEFAULT_SRC };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.MatchPointMusic = api;
})();
