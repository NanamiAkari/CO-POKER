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

    const coin = await fetch(`http://127.0.0.1:${address.port}/assets/coin-1.svg?v=1`);
    assert.equal(coin.status, 200);
    assert.match(coin.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(coin.headers.get('cache-control'), /max-age=300/);
    assert.equal(coin.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await server.close();
  }
});
