const test = require('node:test');
const assert = require('node:assert/strict');
const MatchPointMusic = require('../public/match-point-music');

function fakeAudio() {
  const handlers = {};
  return {
    src: '',
    preload: '',
    loop: true,
    volume: 1,
    currentTime: 0,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    loadCalls: 0,
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { this.pauseCalls += 1; this.paused = true; },
    load() { this.loadCalls += 1; },
    addEventListener(name, handler) { (handlers[name] ||= []).push(handler); },
    emit(name) { for (const handler of handlers[name] || []) handler(); }
  };
}

function setup(options = {}) {
  const audio = fakeAudio();
  const music = MatchPointMusic.create({
    createAudio: () => audio,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...options
  });
  return { audio, music };
}

test('isMatchPoint marks the score where one more loss ends the series', () => {
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 3, successCount: 0, failureCount: 2, phase: 'SETTLEMENT' }), true);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 3, successCount: 2, failureCount: 2, phase: 'SETTLEMENT' }), true);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 5, successCount: 0, failureCount: 4, phase: 'SETTLEMENT' }), true);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 3, successCount: 0, failureCount: 1, phase: 'SETTLEMENT' }), false);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 3, successCount: 3, failureCount: 2, phase: 'GAME_OVER' }), false);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 3, successCount: 3, failureCount: 2, phase: 'SETTLEMENT' }), false);
  assert.equal(MatchPointMusic.isMatchPoint({ seriesLength: 0, successCount: 0, failureCount: -1, phase: 'SETTLEMENT' }), false);
  assert.equal(MatchPointMusic.isMatchPoint({}), false);
});

test('play creates one local audio element and fades it up to the configured volume', () => {
  const { audio, music } = setup({ volume: () => 0.8, gain: 0.5 });
  assert.equal(music.play(), true);
  assert.equal(audio.src, MatchPointMusic.DEFAULT_SRC);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.loop, false);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.volume, 0.4);
  assert.equal(music.playing, true);
});

test('play is idempotent so repeated snapshots do not restart the track', () => {
  const { audio, music } = setup();
  assert.equal(music.play(), true);
  assert.equal(music.play(), true);
  assert.equal(audio.playCalls, 1);
});

test('stop fades out and pauses, reset lets the next series play again', () => {
  const { audio, music } = setup();
  music.play();
  music.stop();
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.volume, 0);
  assert.equal(music.playing, false);
  assert.equal(music.play(), true);
  assert.equal(audio.playCalls, 2);
  music.reset();
  assert.equal(audio.currentTime, 0);
  assert.equal(music.playing, false);
});

test('a finished or blocked track can return to idle cleanly', async () => {
  const { audio, music } = setup();
  music.play();
  audio.paused = true;
  audio.emit('ended');
  assert.equal(music.playing, false);
  assert.equal(music.play(), true);

  const blocked = MatchPointMusic.create({
    createAudio: () => { const node = fakeAudio(); node.play = () => { throw new Error('blocked'); }; return node; },
    fadeInMs: 0,
    fadeOutMs: 0
  });
  assert.equal(blocked.play(), false);
  assert.equal(blocked.playing, false);
});

test('preload warms the element without starting playback and is idempotent', () => {
  const { audio, music } = setup();
  assert.equal(music.preload(), true);
  assert.equal(music.preload(), true);
  assert.equal(audio.loadCalls, 1);
  assert.equal(audio.playCalls, 0);
});

test('disabled sound never creates an audio element', () => {
  let created = 0;
  const music = MatchPointMusic.create({
    enabled: () => false,
    createAudio: () => { created += 1; return fakeAudio(); }
  });
  assert.equal(music.play(), false);
  assert.equal(music.preload(), false);
  assert.equal(created, 0);
});

test('volume stays inside a single element and follows preference changes', () => {
  let level = 1;
  const { audio, music } = setup({ volume: () => level });
  music.play();
  level = 0.2;
  music.refreshVolume();
  assert.equal(audio.volume, 0.2 * 0.65);
});
