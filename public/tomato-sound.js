/*
 * A tiny, dependency-free sound for the tomato interaction.
 *
 * The sound is deliberately generated at runtime: it is a short, soft fruit
 * splat rather than a notification beep or a large explosion.  Keeping the
 * samples here also means a room does not need to download an audio asset.
 */
(() => {
  'use strict';

  const DEFAULT_SAMPLE_RATE = 44100;
  const DURATION_SECONDS = 0.56;
  const MAX_CONCURRENT = 3;
  const OUTPUT_GAIN = 0.62;

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

  function finiteRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? Math.max(1000, Math.floor(rate)) : DEFAULT_SAMPLE_RATE;
  }

  // A deterministic, seeded noise source makes previews and tests repeatable.
  function createSamples(sampleRate = DEFAULT_SAMPLE_RATE) {
    const rate = finiteRate(sampleRate);
    const length = Math.max(1, Math.floor(rate * DURATION_SECONDS));
    const samples = new Float32Array(length);
    let seed = 0x2f6e2b91;
    let wet = 0;
    let low = 0;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000 * 2 - 1;
    };
    const clamp = value => Math.max(-1, Math.min(1, value));

    for (let index = 0; index < length; index += 1) {
      const time = index / rate;
      const noise = random();

      // One-pole smoothing keeps the noise rounded and wet instead of harsh.
      wet += (noise - wet) * 0.16;
      low += (wet - low) * 0.08;

      // The first 25 ms is the palm-sized thump of the fruit arriving.  It is
      // low and brief, with no repeating pitch that could read as a beep.
      const thumpEnvelope = Math.exp(-time / 0.026);
      const thump = (low * 0.88 + noise * 0.22) * thumpEnvelope;

      // The body is a soft, broad noise burst.  Two slowly fading bands give
      // it the sticky/wet texture of pulp without becoming an explosion.
      const pulpEnvelope = Math.exp(-time / 0.115);
      const pulp = (wet * 0.74 + noise * 0.26) * pulpEnvelope;

      // A sparse tail of tiny seed clicks adds a little character.  These are
      // impulses spread over time rather than a pitched rhythm.
      const seedTimes = [0.19, 0.247, 0.314, 0.389, 0.442];
      let seedTail = 0;
      for (let seedIndex = 0; seedIndex < seedTimes.length; seedIndex += 1) {
        const distance = Math.abs(time - seedTimes[seedIndex]);
        if (distance < 0.0028) {
          const impulse = Math.max(0, 1 - distance / 0.0028);
          seedTail += impulse * (seedIndex % 2 ? -0.13 : 0.15);
        }
      }

      // A very quiet air tail prevents an abrupt digital cutoff at 560 ms.
      const tailEnvelope = Math.exp(-Math.max(0, time - 0.34) / 0.12);
      samples[index] = clamp(thump * 0.72 + pulp * 0.67 + seedTail * tailEnvelope);
    }
    return samples;
  }

  function copySamples(buffer, samples) {
    if (typeof buffer.copyToChannel === 'function') {
      buffer.copyToChannel(samples, 0);
      return;
    }
    if (typeof buffer.getChannelData === 'function') {
      const channel = buffer.getChannelData(0);
      if (channel && typeof channel.set === 'function') channel.set(samples);
    }
  }

  function create(options = {}) {
    const getContext = typeof options.getContext === 'function' ? options.getContext : () => null;
    let buffer = null;
    let bufferContext = null;
    const active = new Set();

    function context() {
      try { return getContext(); } catch (_) { return null; }
    }

    function ensureBuffer(audioContext) {
      if (buffer && bufferContext === audioContext) return buffer;
      if (!audioContext || typeof audioContext.createBuffer !== 'function') return null;
      const rate = finiteRate(audioContext.sampleRate);
      const samples = createSamples(rate);
      try {
        const created = audioContext.createBuffer(1, samples.length, rate);
        copySamples(created, samples);
        buffer = created;
        bufferContext = audioContext;
        return buffer;
      } catch (_) {
        return null;
      }
    }

    // Call this from the click/tap that enables sound.  The promise is always
    // caught so browsers which reject autoplay do not emit an unhandled error.
    function prime() {
      if (!enabled(options)) return Promise.resolve(false);
      const audioContext = context();
      if (!audioContext) return Promise.resolve(false);
      try {
        if (typeof audioContext.resume !== 'function') return Promise.resolve(audioContext.state === 'running');
        return Promise.resolve(audioContext.resume())
          .then(() => audioContext.state === undefined || audioContext.state === 'running')
          .catch(() => false);
      } catch (_) {
        return Promise.resolve(false);
      }
    }

    function playImpact() {
      // Do these checks before asking for a context; some AudioContext
      // factories are expensive and must not run while sound is disabled.
      if (!enabled(options) || !visible(options) || active.size >= MAX_CONCURRENT) return false;
      const audioContext = context();
      if (!audioContext || audioContext.state !== 'running') return false;
      const audioBuffer = ensureBuffer(audioContext);
      if (!audioBuffer || typeof audioContext.createBufferSource !== 'function') return false;

      let source = null;
      let gain = null;
      try {
        source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        if (typeof audioContext.createGain === 'function') {
          gain = audioContext.createGain();
          if (gain.gain) gain.gain.value = OUTPUT_GAIN;
          source.connect(gain);
          if (audioContext.destination && typeof gain.connect === 'function') gain.connect(audioContext.destination);
        } else if (audioContext.destination && typeof source.connect === 'function') {
          source.connect(audioContext.destination);
        }
        const entry = { source, gain };
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
      playImpact,
      reset,
      // Exposed for diagnostics/tests without exposing mutable internals.
      get activeCount() { return active.size; },
    };
  }

  const api = { create, createSamples, DURATION_SECONDS, MAX_CONCURRENT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') window.TomatoSound = api;
})();
