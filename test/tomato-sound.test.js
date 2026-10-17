const test = require('node:test');
const assert = require('node:assert/strict');
const TomatoSound = require('../public/tomato-sound');

function fakeContext({ state = 'running', resume = null, sampleRate = 8000 } = {}) {
  const sources = [];
  const context = {
    state,
    sampleRate,
    destination: {},
    resume: resume || (() => Promise.resolve()),
    createBuffer(channels, length, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        channels,
        length,
        sampleRate: rate,
        copyToChannel(values, channel) { data[channel].set(values); },
        getChannelData(channel) { return data[channel]; },
        data,
      };
    },
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        started: 0,
        stopped: 0,
        connected: [],
        connect(node) { this.connected.push(node); },
        disconnect() { this.disconnected = true; },
        start() { this.started += 1; sources.push(this); },
        stop() { this.stopped += 1; },
      };
      return source;
    },
    sources,
  };
  return context;
}

test('createSamples returns a finite deterministic wet impact lasting about half a second', () => {
  const first = TomatoSound.createSamples(8000);
  const second = TomatoSound.createSamples(8000);
  assert.equal(first.length, Math.floor(8000 * TomatoSound.DURATION_SECONDS));
  assert.deepEqual(first, second);
  assert.ok(first.some(value => Math.abs(value) > 0.02));
  assert.ok([...first].every(Number.isFinite));
  assert.ok(Math.max(...first) <= 1 && Math.min(...first) >= -1);
});

test('prime obtains and resumes the shared context, swallowing autoplay rejection', async () => {
  let resumes = 0;
  const context = fakeContext({ state: 'suspended', resume: () => { resumes += 1; return Promise.reject(new Error('autoplay')); } });
  const sound = TomatoSound.create({ getContext: () => context });
  assert.equal(await sound.prime(), false);
  assert.equal(resumes, 1);
});

test('playImpact respects enabled, visibility and running-state gates', () => {
  const context = fakeContext();
  let calls = 0;
  const getContext = () => { calls += 1; return context; };
  assert.equal(TomatoSound.create({ getContext, enabled: false }).playImpact(), false);
  assert.equal(calls, 0, 'disabled audio does not request a context');
  assert.equal(TomatoSound.create({ getContext, isVisible: false }).playImpact(), false);
  assert.equal(calls, 0, 'hidden audio does not request a context');
  context.state = 'suspended';
  assert.equal(TomatoSound.create({ getContext }).playImpact(), false);
  assert.equal(calls, 1);
});

test('buffer is cached and no more than three impacts overlap', () => {
  const context = fakeContext();
  let buffers = 0;
  const original = context.createBuffer;
  context.createBuffer = (...args) => { buffers += 1; return original.apply(context, args); };
  const sound = TomatoSound.create({ getContext: () => context });
  assert.equal(sound.playImpact(), true);
  assert.equal(sound.playImpact(), true);
  assert.equal(sound.playImpact(), true);
  assert.equal(sound.playImpact(), false);
  assert.equal(sound.activeCount, 3);
  assert.equal(buffers, 1);
  context.sources[0].onended();
  assert.equal(sound.activeCount, 2);
  assert.equal(sound.playImpact(), true);
});

test('reset stops and clears all active sources', () => {
  const context = fakeContext();
  const sound = TomatoSound.create({ getContext: () => context });
  sound.playImpact();
  sound.playImpact();
  assert.equal(sound.activeCount, 2);
  sound.reset();
  assert.equal(sound.activeCount, 0);
  assert.deepEqual(context.sources.map(source => source.stopped), [1, 1]);
  // reset is idempotent and does not throw if a source has ended already.
  sound.reset();
});

test('turning sound off prevents a later impact after reset', () => {
  const context = fakeContext();
  let enabled = true;
  const sound = TomatoSound.create({ getContext: () => context, enabled: () => enabled });
  assert.equal(sound.playImpact(), true);
  sound.reset();
  enabled = false;
  assert.equal(sound.playImpact(), false);
  assert.equal(sound.activeCount, 0);
});
