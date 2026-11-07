/*
 * Tomato action sound.
 *
 * Two short CC0 recordings are fetched once and decoded through the shared
 * audio context: a quick throw whoosh at launch and a wet splat on impact.
 * See public/assets/CREDITS.md for provenance and edits.
 */
(() => {
  'use strict';

  const DEFAULT_SPLAT_SRC = '/assets/tomato-splat.wav?v=20261031-landlord-combo';
  const DEFAULT_THROW_SRC = '/assets/tomato-throw.wav?v=20261031-whoosh';
  const MAX_CONCURRENT = 3;
  const IMPACT_GAIN = 0.55;
  const THROW_GAIN = 0.5;

  function read(value, fallback) {
    if (typeof value === 'function') {
      try { return value(); } catch (_) { return fallback; }
    }
    // Vue refs and other small observable wrappers expose a value property.
    if (value && typeof value === 'object' && 'value' in value) return value.value;
    return value === undefined ? fallback : value;
  }

  function enabled(options) {
    return read(options.enabled, true) !== false;
  }

  function visible(options) {
    return read(options.isVisible, true) !== false;
  }

  function create(options = {}) {
    const getContext = typeof options.getContext === 'function' ? options.getContext : () => null;
    const sources = {
      impact: typeof options.splatSrc === 'string' && options.splatSrc ? options.splatSrc : DEFAULT_SPLAT_SRC,
      throw: typeof options.throwSrc === 'string' && options.throwSrc ? options.throwSrc : DEFAULT_THROW_SRC,
    };
    const fetchImpl = typeof options.fetch === 'function'
      ? options.fetch
      : typeof fetch === 'function' ? fetch : null;
    let buffers = { impact: null, throw: null };
    let bufferContext = null;
    const loading = { impact: null, throw: null };
    const active = new Set();

    function context() {
      try { return getContext(); } catch (_) { return null; }
    }

    function decode(audioContext, data) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const succeed = value => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = error => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        try {
          const result = audioContext.decodeAudioData(data, succeed, fail);
          if (result && typeof result.then === 'function') result.then(succeed, fail);
        } catch (error) {
          fail(error);
        }
      });
    }

    // Fetching and decoding are asynchronous. Callers never wait for this
    // promise: the first action may be silent while the assets warm up, then
    // the decoded buffers are reused. Errors are swallowed so a missing or
    // blocked asset can only remove sound, never game input.
    function load(kind) {
      const audioContext = context();
      if (!audioContext || typeof audioContext.decodeAudioData !== 'function' || !fetchImpl) {
        return Promise.resolve(null);
      }
      if (buffers[kind] && bufferContext === audioContext) return Promise.resolve(buffers[kind]);
      if (loading[kind]) return loading[kind];
      loading[kind] = Promise.resolve()
        .then(() => fetchImpl(sources[kind]))
        .then(response => {
          if (!response) throw new Error('No audio response');
          if (response.ok === false) throw new Error('Audio request failed');
          if (typeof response.arrayBuffer !== 'function') throw new Error('Audio response has no arrayBuffer');
          return response.arrayBuffer();
        })
        .then(data => decode(audioContext, data))
        .then(decoded => {
          if (decoded) {
            if (bufferContext !== audioContext) {
              buffers = { impact: null, throw: null };
              bufferContext = audioContext;
            }
            buffers[kind] = decoded;
          }
          return decoded;
        })
        .catch(() => null)
        .finally(() => { loading[kind] = null; });
      return loading[kind];
    }

    function preload() {
      if (!enabled(options)) return Promise.resolve(false);
      return Promise.all([load('impact'), load('throw')])
        .then(([impact, thrown]) => Boolean(impact && thrown));
    }

    // Call this from the click/tap that enables sound. The promise is always
    // caught so browsers which reject autoplay do not emit an unhandled error.
    function prime() {
      if (!enabled(options)) return Promise.resolve(false);
      const audioContext = context();
      if (!audioContext) return Promise.resolve(false);
      void preload();
      try {
        if (typeof audioContext.resume !== 'function') {
          return Promise.resolve(audioContext.state === undefined || audioContext.state === 'running');
        }
        return Promise.resolve(audioContext.resume())
          .then(() => audioContext.state === undefined || audioContext.state === 'running')
          .catch(() => false);
      } catch (_) {
        return Promise.resolve(false);
      }
    }

    function activeFor(kind) {
      let count = 0;
      for (const entry of active) if (entry.kind === kind) count += 1;
      return count;
    }

    function volumeFor(kind, fallback) {
      const source = options.volume;
      if (typeof source === 'function') {
        try {
          const value = Number(source(kind));
          return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
        } catch (_) {
          return fallback;
        }
      }
      const value = Number(source);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
    }
    function play(kind, gainValue) {
      // Do these checks before asking for a context; some AudioContext
      // factories are expensive and must not run while sound is disabled.
      if (!enabled(options) || !visible(options)) return false;
      const audioContext = context();
      if (!audioContext || audioContext.state !== 'running') return false;
      const audioBuffer = buffers[kind];
      if (!audioBuffer || bufferContext !== audioContext) {
        void load(kind);
        return false;
      }
      if (activeFor(kind) >= MAX_CONCURRENT) return false;
      if (typeof audioContext.createBufferSource !== 'function') return false;

      let source = null;
      let gain = null;
      try {
        source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        if (typeof audioContext.createGain === 'function') {
          gain = audioContext.createGain();
          if (gain.gain) gain.gain.value = gainValue * volumeFor(kind, 1);
          source.connect(gain);
          if (audioContext.destination && typeof gain.connect === 'function') gain.connect(audioContext.destination);
        } else if (audioContext.destination && typeof source.connect === 'function') {
          source.connect(audioContext.destination);
        }
        const entry = { source, gain, kind };
        active.add(entry);
        source.onended = () => {
          active.delete(entry);
          try { source.disconnect?.(); } catch (_) { /* best effort */ }
          try { gain?.disconnect?.(); } catch (_) { /* best effort */ }
        };
        source.start(0);
        return true;
      } catch (_) {
        if (source) {
          try { source.disconnect?.(); } catch (_) { /* best effort */ }
        }
        if (gain) {
          try { gain.disconnect?.(); } catch (_) { /* best effort */ }
        }
        return false;
      }
    }

    function playImpact() {
      return play('impact', IMPACT_GAIN);
    }

    function playThrow() {
      return play('throw', THROW_GAIN);
    }

    function reset() {
      for (const entry of active) {
        const source = entry.source;
        try { source.onended = null; } catch (_) { /* best effort */ }
        try { source.stop?.(0); } catch (_) { /* already ended */ }
        try { source.disconnect?.(); } catch (_) { /* best effort */ }
        try { entry.gain?.disconnect?.(); } catch (_) { /* best effort */ }
      }
      active.clear();
    }

    return {
      prime,
      preload,
      playImpact,
      playThrow,
      reset,
      // Exposed for diagnostics/tests without exposing mutable internals.
      get activeCount() { return active.size; },
    };
  }

  const api = { create, DEFAULT_SPLAT_SRC, DEFAULT_THROW_SRC, MAX_CONCURRENT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.TomatoSound = api;
})();
