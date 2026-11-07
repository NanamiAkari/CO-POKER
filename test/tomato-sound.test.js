const test = require('node:test');
const assert = require('node:assert/strict');
const TomatoSound = require('../public/tomato-sound');

function fakeContext({ state = 'running', resume = null, decodeError = null } = {}) {
  const sources = [];
  let decodes = 0;
  let resumes = 0;
  const decoder = new TextDecoder();
  const context = {
    state,
    sampleRate: 44100,
    destination: {},
    get resumes() { return resumes; },
    get decodes() { return decodes; },
    resume: resume || (() => { resumes += 1; context.state = 'running'; return Promise.resolve(); }),
    decodeAudioData(data, success, fail) {
      decodes += 1;
      if (decodeError) {
        if (fail) fail(decodeError);
        return Promise.reject(decodeError);
      }
      const decoded = { duration: 0.5, url: decoder.decode(new Uint8Array(data)) };
      if (success) success(decoded);
      return Promise.resolve(decoded);
    },
    createGain() {
      const node = { gain: { value: 1 }, connect() {}, disconnect() { this.disconnected = true; } };
      return node;
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        started: 0,
        stopped: 0,
        connect(node) { this.connectedTo = node; },
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

function fakeFetch({ ok = true, failFor = null } = {}) {
  const calls = [];
  const encoder = new TextEncoder();
  const impl = async url => {
    calls.push(url);
    if (failFor && url.includes(failFor)) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok, arrayBuffer: async () => encoder.encode(url).buffer };
  };
  impl.calls = calls;
  return impl;
}

test('prime preloads both the throw and impact recordings and caches them', async () => {
  const context = fakeContext({ state: 'suspended' });
  const fetchImpl = fakeFetch();
  const sound = TomatoSound.create({ getContext: () => context, fetch: fetchImpl });

  assert.equal(await sound.prime(), true);
  assert.equal(context.resumes, 1);
  assert.equal(await sound.preload(), true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.some(url => /tomato-splat\.wav/.test(url)));
  assert.ok(fetchImpl.calls.some(url => /tomato-throw\.wav/.test(url)));
  assert.equal(context.decodes, 2);

  assert.equal(sound.playThrow(), true);
  assert.equal(sound.playImpact(), true);
  assert.match(context.sources[0].buffer.url, /tomato-throw\.wav/);
  assert.match(context.sources[1].buffer.url, /tomato-splat\.wav/);
  assert.equal(await sound.preload(), true);
  assert.equal(fetchImpl.calls.length, 2, 'both decoded buffers are cached');
  assert.equal(context.decodes, 2, 'each recording is decoded once');
});

test('prime swallows autoplay rejection without throwing', async () => {
  const context = fakeContext({ state: 'suspended', resume: () => Promise.reject(new Error('autoplay')) });
  const sound = TomatoSound.create({ getContext: () => context, fetch: fakeFetch() });
  assert.equal(await sound.prime(), false);
});

test('playback respects enabled, visibility and running-state gates before loading', () => {
  let calls = 0;
  const context = fakeContext();
  const fetchImpl = fakeFetch();
  const getContext = () => { calls += 1; return context; };
  const disabled = TomatoSound.create({ getContext, fetch: fetchImpl, enabled: false });
  assert.equal(disabled.playImpact(), false);
  assert.equal(disabled.playThrow(), false);
  assert.equal(calls, 0, 'disabled audio does not request a context');
  assert.equal(fetchImpl.calls.length, 0, 'disabled audio does not start a download');
  const hidden = TomatoSound.create({ getContext, fetch: fetchImpl, isVisible: false });
  assert.equal(hidden.playImpact(), false);
  assert.equal(hidden.playThrow(), false);
  assert.equal(calls, 0, 'hidden audio does not request a context');
  context.state = 'suspended';
  const sound = TomatoSound.create({ getContext, fetch: fetchImpl });
  assert.equal(sound.playImpact(), false);
  assert.equal(sound.playThrow(), false);
  assert.equal(calls, 2, 'each suspended playback check asks for the context once');
});

test('the first action warms only the requested asset and later voices are capped per kind', async () => {
  const context = fakeContext();
  const fetchImpl = fakeFetch();
  const sound = TomatoSound.create({ getContext: () => context, fetch: fetchImpl });
  assert.equal(sound.playThrow(), false, 'the very first throw starts the download instead of waiting');
  assert.equal(await sound.preload(), true);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sound.playImpact(), true);
  assert.equal(sound.playThrow(), true);
  for (let index = 0; index < 4; index += 1) sound.playThrow();
  for (let index = 0; index < 4; index += 1) sound.playImpact();
  assert.equal(sound.activeCount, 6, 'three impacts and three throws may overlap');
  assert.equal(fetchImpl.calls.length, 2, 'both recordings are fetched once');
  context.sources[1].onended();
  assert.equal(sound.activeCount, 5);
  assert.equal(sound.playThrow(), true);
});

test('volume scales throw and impact independently', async () => {
  const context = fakeContext();
  const volumes = { throw: 0.4, impact: 0.8 };
  const sound = TomatoSound.create({
    getContext: () => context,
    fetch: fakeFetch(),
    volume: kind => volumes[kind]
  });
  assert.equal(await sound.preload(), true);
  assert.equal(sound.playThrow(), true);
  assert.equal(sound.playImpact(), true);
  const throwGain = context.sources[0].connectedTo;
  const impactGain = context.sources[1].connectedTo;
  assert.ok(throwGain);
  assert.ok(impactGain);
  assert.equal(Number(throwGain.gain.value.toFixed(3)), Number((0.5 * 0.4).toFixed(3)));
  assert.equal(Number(impactGain.gain.value.toFixed(3)), Number((0.55 * 0.8).toFixed(3)));
});

test('reset stops and clears both voice kinds', async () => {
  const context = fakeContext();
  const sound = TomatoSound.create({ getContext: () => context, fetch: fakeFetch() });
  await sound.preload();
  sound.playImpact();
  sound.playThrow();
  assert.equal(sound.activeCount, 2);
  sound.reset();
  assert.equal(sound.activeCount, 0);
  assert.deepEqual(context.sources.map(source => source.stopped), [1, 1]);
  sound.reset();
});

test('turning sound off prevents playback after reset', async () => {
  const context = fakeContext();
  let enabled = true;
  const sound = TomatoSound.create({ getContext: () => context, fetch: fakeFetch(), enabled: () => enabled });
  assert.equal(await sound.preload(), true);
  assert.equal(sound.playImpact(), true);
  sound.reset();
  enabled = false;
  assert.equal(sound.playImpact(), false);
  assert.equal(sound.playThrow(), false);
  assert.equal(await sound.preload(), false);
  assert.equal(sound.activeCount, 0);
});

test('a missing recording degrades to silence without disabling the other recording', async () => {
  const context = fakeContext();
  const sound = TomatoSound.create({ getContext: () => context, fetch: fakeFetch({ failFor: 'tomato-throw' }) });
  assert.equal(await sound.preload(), false);
  assert.equal(sound.playThrow(), false);
  assert.equal(sound.playImpact(), true, 'the splat still plays when only the throw whoosh is unavailable');

  for (const fetchImpl of [fakeFetch({ ok: false }), async () => { throw new Error('offline'); }]) {
    const broken = TomatoSound.create({ getContext: () => fakeContext(), fetch: fetchImpl });
    assert.equal(await broken.preload(), false);
    assert.equal(broken.playImpact(), false);
    assert.equal(broken.playThrow(), false);
  }
  const broken = fakeContext({ decodeError: new Error('bad wav') });
  const soundWithBadDecode = TomatoSound.create({ getContext: () => broken, fetch: fakeFetch() });
  assert.equal(await soundWithBadDecode.preload(), false);
  assert.equal(soundWithBadDecode.playImpact(), false);
  assert.equal(soundWithBadDecode.playThrow(), false);
});
