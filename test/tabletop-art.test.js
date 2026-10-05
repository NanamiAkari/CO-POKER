const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDeck } = require('../src/poker');
const art = require('../public/tabletop-art');

function svgFrom(uri) {
  assert.match(uri, /^data:image\/svg\+xml;charset=UTF-8,/);
  const svg = decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
  assert.match(svg, /^<svg\s/);
  assert.match(svg, /<\/svg>$/);
  assert.doesNotMatch(svg, /undefined|NaN|Infinity/);
  assert.doesNotMatch(svg, /(?:href|src)=["'](?:https?:|\/\/)|<script|<foreignObject|@import/);
  // Every local SVG reference must resolve inside its own document.
  const ids = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of svg.matchAll(/(?:href="#|url\(#)([^"\s)]+)/g)) {
    assert.ok(ids.has(match[1]), `Missing SVG definition ${match[1]}`);
  }
  return svg;
}

test('all 52 cards produce distinct self-contained artwork with correct card labels', () => {
  const deck = createDeck();
  const images = new Set();
  for (const card of deck) {
    const image = art.cardImage(card);
    const svg = svgFrom(image);
    images.add(image);
    assert.match(svg, /viewBox="0 0 140 196"/);
    assert.ok(svg.includes(`<title>${art.cardText(card)}</title>`));
    assert.match(svg, /href="#corner" transform="rotate\(180 70 98\)"/);
  }
  assert.equal(images.size, 52);
  assert.equal(art.cardText({ rank: 14, suit: 's' }), 'A♠');
  assert.equal(art.cardText({ rank: 10, suit: 'h' }), '10♥');
});

test('number cards show the right number of pips and court cards have two mirrored portraits', () => {
  for (const suit of ['s', 'h', 'd', 'c']) {
    for (let rank = 2; rank <= 10; rank += 1) {
      const svg = svgFrom(art.cardImage({ rank, suit }));
      assert.equal((svg.match(/class="pip"/g) || []).length, rank);
      assert.doesNotMatch(svg, /court-portrait|ace-emblem/);
    }
    for (const rank of [11, 12, 13]) {
      const svg = svgFrom(art.cardImage({ rank, suit }));
      assert.match(svg, /class="court-portrait"/);
      assert.match(svg, /href="#court-half" transform="rotate\(180 70 98\)"/);
    }
    assert.match(svgFrom(art.cardImage({ rank: 14, suit })), /class="ace-emblem"/);
  }
  assert.notEqual(art.cardImage({ rank: 11, suit: 's' }), art.cardImage({ rank: 12, suit: 's' }));
});

test('red and black physical jokers have distinct self-contained double-headed portraits', () => {
  const images = new Set(createDeck().map(art.cardImage));
  for (const [joker, name, color] of [['red', '大王', '#87323e'], ['black', '小王', '#173437']]) {
    const card = { joker };
    assert.equal(art.cardText(card), name);
    const image = art.cardImage(card);
    const svg = svgFrom(image);
    assert.ok(svg.includes(`<title>${name}</title>`));
    assert.ok(svg.includes(`fill="${color}"`));
    assert.match(svg, /viewBox="0 0 140 196"/);
    assert.match(svg, /class="joker-portrait"/);
    assert.match(svg, /href="#joker-half" transform="rotate\(180 70 98\)"/);
    assert.match(svg, /href="#joker-corner" transform="rotate\(180 70 98\)"/);
    assert.doesNotMatch(svg, /class="joker-origin"/);
    images.add(image);
    assert.equal(art.cardImage({ joker }), image);
  }
  assert.equal(images.size, 54);
});

test('resolved jokers show the chosen card and a source stamp without cache collisions', () => {
  for (const natural of createDeck()) {
    const joker = ['h', 'd'].includes(natural.suit) ? 'red' : 'black';
    const name = joker === 'red' ? '大王' : '小王';
    const resolved = { ...natural, joker };
    const svg = svgFrom(art.cardImage(resolved));
    assert.equal(art.cardText(resolved), `${name}（作 ${art.cardText(natural)}）`);
    assert.ok(svg.includes(`<title>${art.cardText(resolved)}</title>`));
    assert.ok(svg.includes(`class="joker-origin" aria-label="${name}"`));
    assert.match(svg, /href="#corner" transform="rotate\(180 70 98\)"/);
    assert.doesNotMatch(svg, /class="joker-portrait"/);
    if (natural.rank <= 10) assert.equal((svg.match(/class="pip"/g) || []).length, natural.rank);
    assert.notEqual(art.cardImage(resolved), art.cardImage(natural));
    assert.notEqual(art.cardImage(resolved), art.cardImage({ joker }));
    assert.doesNotMatch(svgFrom(art.cardImage(natural)), /joker-origin|joker-portrait/);
    assert.equal(art.cardImage({ joker, ...natural }), art.cardImage(resolved));
  }
});

test('card back and five engraved tokens are valid local SVG assets', () => {
  const back = svgFrom(art.cardBack);
  assert.match(back, /viewBox="0 0 140 196"/);
  assert.match(back, /<pattern id="weave"/);
  const coins = new Set();
  for (let number = 1; number <= 5; number += 1) {
    const image = art.coinImage(number);
    const svg = svgFrom(image);
    assert.ok(svg.includes(`<title>硬币 ${number}</title>`));
    assert.match(svg, /class="coin-number"/);
    assert.match(svg, /viewBox="0 0 140 140"/);
    coins.add(image);
  }
  assert.equal(coins.size, 5);
});

test('browser script exposes the same dependency-free API as CommonJS', () => {
  const context = vm.createContext({ window: {} });
  const source = fs.readFileSync(path.join(__dirname, '../public/tabletop-art.js'), 'utf8');
  vm.runInContext(source, context);
  const browserArt = context.window.TabletopArt;
  assert.deepEqual(Object.keys(browserArt).sort(), ['cardBack', 'cardImage', 'cardText', 'coinImage']);
  assert.equal(browserArt.cardBack, art.cardBack);
  for (const card of createDeck()) assert.equal(browserArt.cardImage(card), art.cardImage(card));
  for (const card of [{ joker: 'red' }, { joker: 'black' },
    { joker: 'red', rank: 14, suit: 'h' }, { joker: 'black', rank: 10, suit: 'c' }]) {
    assert.equal(browserArt.cardImage(card), art.cardImage(card));
    assert.equal(browserArt.cardText(card), art.cardText(card));
  }
  for (let number = 1; number <= 5; number += 1) assert.equal(browserArt.coinImage(number), art.coinImage(number));
});

test('invalid input cannot generate broken or injected SVG and empty cards are supported', () => {
  assert.equal(art.cardImage(null), '');
  assert.equal(art.cardText(undefined), '');
  for (const card of [{}, { rank: NaN, suit: 's' }, { rank: 1, suit: 'h' },
    { rank: 15, suit: 's' }, { rank: 2.5, suit: 's' }, { rank: 2, suit: 'toString' },
    { rank: 2, suit: '<script>' }, { rank: '2', suit: 's' }]) {
    assert.throws(() => art.cardImage(card), TypeError);
    assert.throws(() => art.cardText(card), TypeError);
  }
  for (const number of [0, 6, NaN, 2.5, '1', null]) assert.throws(() => art.coinImage(number), RangeError);
});

test('invalid joker colors, partial substitutions, and opposite-color suits are rejected', () => {
  for (const card of [{ joker: 'green' }, { joker: '<script>' }, { joker: null },
    { joker: 'red', rank: 14 }, { joker: 'black', suit: 's' },
    { joker: 'red', rank: null, suit: null }, { joker: 'black', rank: '14', suit: 's' },
    { joker: 'red', rank: 14, suit: 's' }, { joker: 'red', rank: 2, suit: 'c' },
    { joker: 'black', rank: 14, suit: 'h' }, { joker: 'black', rank: 2, suit: 'd' },
    { joker: 'red', rank: 14, suit: '<script>' }, { joker: 'black', rank: 15, suit: 'c' }]) {
    assert.throws(() => art.cardImage(card), TypeError);
    assert.throws(() => art.cardText(card), TypeError);
  }
});
