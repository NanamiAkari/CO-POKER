const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

test('serves fresh HTML and cacheable static assets with correct MIME types', async () => {
  const server = createServer({ port: 0 });
  const address = await server.listen();
  try {
    const html = await fetch(`http://127.0.0.1:${address.port}/?v=1`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('cache-control'), /no-cache/);
    const homeHtml = await html.text();
    assert.match(homeHtml, /seat-layout\.css/);
    assert.match(homeHtml, /selection-guard\.css/);

    for (const cssFile of ['seat-layout.css', 'selection-guard.css']) {
      const css = await fetch(`http://127.0.0.1:${address.port}/${cssFile}?v=1`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /^text\/css/);
      assert.match(css.headers.get('cache-control'), /no-cache/);
      if (cssFile === 'selection-guard.css') {
        const rules = await css.text();
        assert.match(rules, /\.game-canvas[\s\S]*user-select:\s*none/);
        assert.match(rules, /\.chat-log[\s\S]*user-select:\s*text/);
      }
    }

    const coin = await fetch(`http://127.0.0.1:${address.port}/assets/coin-1.svg?v=1`);
    assert.equal(coin.status, 200);
    assert.match(coin.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(coin.headers.get('cache-control'), /max-age=300/);
    assert.equal(coin.headers.get('x-content-type-options'), 'nosniff');

    for (const name of ['tomato-splat.wav', 'tomato-throw.wav']) {
      const audio = await fetch(`http://127.0.0.1:${address.port}/assets/${name}?v=1`);
      assert.equal(audio.status, 200);
      assert.match(audio.headers.get('content-type'), /^audio\/wav/);
      assert.match(audio.headers.get('cache-control'), /max-age=300/);
      const bytes = new Uint8Array(await audio.arrayBuffer());
      assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
      assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
      assert.ok(bytes.length > 40, `${name} must contain audio frames`);
    }
  } finally {
    await server.close();
  }
});
