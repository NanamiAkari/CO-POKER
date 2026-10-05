(function (root, factory) {
  'use strict';
  const art = factory();
  if (typeof module === 'object' && module.exports) module.exports = art;
  else root.TabletopArt = art;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  // All artwork is self-contained: SVG geometry, system serif type, and no network resources.
  const palette = Object.freeze({
    cream: '#fbf5e6', paper: '#eee2ca', burgundy: '#87323e',
    petrol: '#173f42', ink: '#173437', brass: '#b99352', paleGold: '#ead7a7'
  });
  const suits = Object.freeze({
    s: { glyph: '♠', color: palette.ink, path: 'M0-12C-3-7-11-3-11 3C-11 10-3 11-1 5C-1 9-3 11-5 12H5C3 11 1 9 1 5C3 11 11 10 11 3C11-3 3-7 0-12Z' },
    h: { glyph: '♥', color: palette.burgundy, path: 'M0 12C-3 7-11 2-11-5C-11-13-2-14 0-7C2-14 11-13 11-5C11 2 3 7 0 12Z' },
    d: { glyph: '♦', color: palette.burgundy, path: 'M0-13L10 0L0 13L-10 0Z' },
    c: { glyph: '♣', color: palette.ink, path: 'M0-12C-7-12-8-4-3-1C-10-5-15 2-10 7C-7 10-2 8-1 4C-1 9-3 11-5 12H5C3 11 1 9 1 4C2 8 7 10 10 7C15 2 10-5 3-1C8-4 7-12 0-12Z' }
  });
  const labels = Object.freeze({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' });
  const pipLayouts = Object.freeze({
    2: [[70, 57], [70, 139]],
    3: [[70, 57], [70, 98], [70, 139]],
    4: [[46, 57], [94, 57], [46, 139], [94, 139]],
    5: [[46, 57], [94, 57], [70, 98], [46, 139], [94, 139]],
    6: [[46, 57], [94, 57], [46, 98], [94, 98], [46, 139], [94, 139]],
    7: [[46, 57], [94, 57], [70, 77], [46, 98], [94, 98], [46, 139], [94, 139]],
    8: [[46, 57], [94, 57], [70, 77], [46, 98], [94, 98], [70, 119], [46, 139], [94, 139]],
    9: [[46, 51], [94, 51], [46, 82], [94, 82], [70, 98], [46, 114], [94, 114], [46, 145], [94, 145]],
    10: [[46, 51], [94, 51], [70, 66], [46, 82], [94, 82], [46, 114], [94, 114], [70, 130], [46, 145], [94, 145]]
  });
  const cardCache = new Map();
  const coinCache = new Map();
  const encode = svg => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

  function checkCard(card) {
    if (card && card.joker !== undefined) {
      if (card.joker !== 'red' && card.joker !== 'black') {
        throw new TypeError('Expected a red or black joker');
      }
      // Physical jokers have no rank or suit; evaluated jokers carry their substitution.
      if (card.rank === undefined && card.suit === undefined) return null;
    }
    if (!card || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14 ||
        !Object.prototype.hasOwnProperty.call(suits, card.suit)) {
      throw new TypeError('Expected a card with rank 2–14 and suit s, h, d, or c');
    }
    if (card.joker !== undefined &&
        (card.joker === 'red' ? !['h', 'd'].includes(card.suit) : !['s', 'c'].includes(card.suit))) {
      throw new TypeError('Joker substitution must match its red or black suit color');
    }
    return suits[card.suit];
  }

  function jokerText(color) {
    return color === 'red' ? '大王' : '小王';
  }

  function cardText(card) {
    if (card == null) return '';
    const suit = checkCard(card);
    if (!suit) return jokerText(card.joker);
    const text = `${labels[card.rank] || card.rank}${suit.glyph}`;
    return card.joker ? `${jokerText(card.joker)}（作 ${text}）` : text;
  }

  function cardFrame(content, definitions, title) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="196" viewBox="0 0 140 196" role="img">
      <title>${title}</title>
      <defs>
        <linearGradient id="paper" x2=".7" y2="1"><stop stop-color="#fffaf0"/><stop offset="1" stop-color="${palette.paper}"/></linearGradient>
        ${definitions}
      </defs>
      <rect x="1" y="1" width="138" height="194" rx="10" fill="url(#paper)" stroke="#c9b895" stroke-width="1.3"/>
      <rect x="5" y="5" width="130" height="186" rx="7" fill="none" stroke="#fffdf5" stroke-opacity=".8"/>
      ${content}
    </svg>`;
  }

  function corner(rank, color) {
    return `<g id="corner" fill="${color}">
      <text x="17" y="28" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${rank === 10 ? 19 : 22}" font-weight="700">${labels[rank] || rank}</text>
      <use href="#suit" transform="translate(17 42) scale(.55)"/>
    </g><use href="#corner" transform="rotate(180 70 98)"/>`;
  }

  function ace() {
    return `<g fill="none" stroke="${palette.brass}" stroke-width=".8">
      <path d="M40 73Q34 96 44 119M100 73Q106 96 96 119M45 65Q70 54 95 65M45 131Q70 142 95 131"/>
      <path d="M40 79l-6-4m5 15l-7-2m8 14l-7 2m10 9l-6 5M100 79l6-4m-5 15l7-2m-8 14l7 2m-10 9l6 5"/>
      <path d="M70 49l3 5-3 5-3-5ZM70 137l3 5-3 5-3-5Z" fill="${palette.paleGold}"/>
    </g><use class="ace-emblem" href="#suit" transform="translate(70 98) scale(2.5)"/>`;
  }

  function court(rank, color) {
    const queen = rank === 12;
    const jack = rank === 11;
    const crown = jack
      ? `<path d="M53 51Q57 37 73 40L85 48L62 51Z" fill="${palette.burgundy}"/><path d="M79 43Q82 31 93 34Q89 43 81 46" fill="${palette.paleGold}" stroke="${palette.brass}" stroke-width="1"/>`
      : `<path d="M53 48L51 36L62 41L69 32L77 41L87 35L84 48Z" fill="${palette.brass}" stroke="${palette.ink}" stroke-width=".8"/><path d="M56 45H82" stroke="${palette.paleGold}" stroke-width="2"/><circle cx="69" cy="40" r="2" fill="${palette.burgundy}"/>`;
    const hair = queen
      ? `<path d="M54 48Q45 57 53 79L61 83L60 51ZM81 48Q94 64 81 80L75 82L77 50Z" fill="${palette.burgundy}"/><path d="M54 55Q49 68 57 74M84 54Q90 67 82 75" fill="none" stroke="${palette.brass}" stroke-width="1.4"/>`
      : `<path d="M55 49L82 48L85 69L78 74L59 71L54 62Z" fill="${palette.ink}"/>`;
    const beard = rank === 13
      ? `<path d="M58 63L63 67L69 65L75 67L81 62L78 75L69 83L59 74Z" fill="${palette.ink}"/><path d="M65 70L69 75L74 69M60 66L63 73M79 65L76 73" fill="none" stroke="${palette.brass}" stroke-width="1"/>`
      : `<path d="M65 69Q70 72 75 68" fill="none" stroke="${palette.burgundy}" stroke-width="1.2"/>`;
    const accessory = queen
      ? `<path d="M94 93L90 68" stroke="${palette.brass}" stroke-width="2"/><g transform="translate(89 65)" fill="${palette.burgundy}" stroke="${palette.brass}" stroke-width=".7"><circle cy="-4" r="4"/><circle cx="4" r="4"/><circle cy="4" r="4"/><circle cx="-4" r="4"/><circle r="2.4" fill="${palette.paleGold}"/></g>`
      : `<path d="M91 94V52L95 46L99 52V94" fill="${palette.paleGold}" stroke="${palette.ink}" stroke-width=".7"/><path d="M95 48V87M88 81H102" stroke="${palette.brass}" stroke-width="1.7"/>`;
    return `<rect x="34" y="30" width="72" height="136" rx="3" fill="#e9dbc0" stroke="${palette.brass}"/>
      <rect x="37" y="33" width="66" height="130" rx="1" fill="${palette.cream}" stroke="${palette.brass}" stroke-width=".6"/>
      <g id="court-half" class="court-portrait">
        <path d="M38 98V85L58 75H79L102 86V98Z" fill="${palette.petrol}"/>
        <path d="M40 85L58 77L74 98H51ZM80 78L99 86L82 98H67Z" fill="${palette.burgundy}"/>
        <path d="M45 86L58 81L72 98M82 82L95 87L78 98" fill="none" stroke="${palette.brass}" stroke-width="3"/>
        <path d="M61 72L62 82L70 91L78 81L76 71Z" fill="#dfc09a" stroke="${palette.ink}" stroke-width=".7"/>
        <path d="M56 76L70 86L81 75L78 86L70 94L59 85Z" fill="${palette.paleGold}"/>
        ${hair}
        <path d="M58 47L79 47L81 58L78 68L70 77L62 73L57 63Z" fill="#edd4ae" stroke="${palette.ink}" stroke-width=".8"/>
        <path d="M69 53L67 63L72 64M59 54L65 53M73 53L78 54" fill="none" stroke="${palette.ink}" stroke-width="1"/>
        <path d="M60 57H64M74 57H78" stroke="${palette.ink}" stroke-width="1.4"/>
        ${beard}${crown}${accessory}
        <path d="M40 94l5-5 5 5-5 4ZM86 93l4-4 4 4-4 5Z" fill="${palette.brass}"/>
        <use href="#suit" transform="translate(51 65) scale(.28)" fill="${color}"/>
      </g><use href="#court-half" transform="rotate(180 70 98)"/>
      <path d="M37 98H103" stroke="${palette.brass}" stroke-width="2"/>
      <path d="M65 98l5-4 5 4-5 4Z" fill="${palette.paleGold}" stroke="${palette.brass}"/>`;
  }

  function jokerPortrait(joker) {
    const red = joker === 'red';
    const color = red ? palette.burgundy : palette.ink;
    const accent = red ? '#bc5960' : '#477477';
    const emblem = red ? suits.d.path : suits.s.path;
    return `<g id="joker-corner" fill="${color}" font-family="'Noto Serif CJK SC', 'Songti SC', SimSun, serif" font-weight="700" font-size="15" text-anchor="middle">
        <text x="17" y="27">${red ? '大' : '小'}</text><text x="17" y="44">王</text>
      </g><use href="#joker-corner" transform="rotate(180 70 98)"/>
      <rect x="34" y="26" width="72" height="144" rx="32" fill="${color}" stroke="${palette.brass}" stroke-width="1.2"/>
      <rect x="38" y="30" width="64" height="136" rx="29" fill="${palette.cream}" stroke="${palette.brass}" stroke-width=".65"/>
      <g id="joker-half" class="joker-portrait">
        <path d="M39 98V87L52 77L68 83L84 77L101 88V98Z" fill="${color}"/>
        <path d="M42 90L51 83L62 92L55 98H45ZM76 91L84 83L96 91L89 98H80Z" fill="${accent}"/>
        <path d="M43 90L51 85L60 92L54 97ZM78 92L85 85L93 91L88 97Z" fill="none" stroke="${palette.brass}"/>
        <path d="M61 71L60 82L69 91L79 82L77 71Z" fill="#dcbc93" stroke="${palette.ink}" stroke-width=".7"/>
        <path d="M52 77L59 75L69 84L80 75L87 78L81 88L74 86L69 94L63 86L57 89Z" fill="${palette.paleGold}" stroke="${palette.brass}" stroke-width=".8"/>
        <path d="M55 50Q52 72 68 80Q84 76 83 51Z" fill="#edd4ae" stroke="${palette.ink}" stroke-width=".8"/>
        <path d="M56 52L61 53L59 66L54 60ZM81 51L82 64L77 67L76 53Z" fill="${color}"/>
        <path d="M57 58Q62 54 65 58M72 58Q76 54 80 58" fill="none" stroke="${palette.ink}" stroke-width="1.3"/>
        <path d="M68 58L65 66L70 67M62 69Q70 77 77 67Q70 72 62 69" fill="none" stroke="${color}" stroke-width="1.2"/>
        <path d="M53 53Q50 39 43 45Q43 30 57 40Q61 22 69 35Q76 21 82 39Q97 29 97 44Q88 37 86 53Z" fill="${color}" stroke="${palette.brass}" stroke-width=".9"/>
        <path d="M57 40L65 50L69 35L76 50L82 39L80 53H60Z" fill="${accent}"/>
        <path d="M55 51Q69 44 84 51L84 55Q69 49 55 55Z" fill="${palette.brass}"/>
        <g fill="${palette.paleGold}" stroke="${palette.brass}" stroke-width=".8">
          <circle cx="43" cy="44" r="3"/><circle cx="69" cy="32" r="3"/><circle cx="97" cy="43" r="3"/>
          <circle cx="56" cy="90" r="1.8"/><circle cx="69" cy="95" r="1.8"/><circle cx="82" cy="89" r="1.8"/>
        </g>
        <path d="${emblem}" transform="translate(96 68) scale(.37)" fill="${color}"/>
        <path d="M45 65L49 69L45 73L41 69Z" fill="${palette.brass}"/>
      </g><use href="#joker-half" transform="rotate(180 70 98)"/>
      <path d="M38 98H102" stroke="${palette.brass}" stroke-width="2"/>
      <path d="M62 98L70 93L78 98L70 103Z" fill="${palette.paleGold}" stroke="${palette.brass}"/>
      <g fill="${color}" font-family="Georgia, serif" font-size="8" text-anchor="middle" letter-spacing="2"><text x="71" y="18">JOKER</text><text transform="rotate(180 70 98)" x="71" y="18">JOKER</text></g>`;
  }

  function jokerStamp(joker) {
    const color = joker === 'red' ? palette.burgundy : palette.ink;
    return `<g class="joker-origin" aria-label="${jokerText(joker)}">
      <path d="M48 177H92L96 183L92 189H48L44 183Z" fill="${palette.cream}" stroke="${palette.brass}" stroke-width=".6"/>
      <text x="70" y="186.5" text-anchor="middle" fill="${color}" font-family="'Noto Serif CJK SC', 'Songti SC', SimSun, serif" font-size="10" font-weight="700">${jokerText(joker)}</text>
    </g>`;
  }

  function cardImage(card) {
    if (card == null) return '';
    const suit = checkCard(card);
    const key = suit ? `${card.rank}${card.suit}:${card.joker || 'natural'}` : `joker:${card.joker}`;
    if (cardCache.has(key)) return cardCache.get(key);
    let svg;
    if (!suit) {
      svg = cardFrame(jokerPortrait(card.joker), '', cardText(card));
    } else {
      const artwork = card.rank === 14 ? ace() : card.rank > 10 ? court(card.rank, suit.color)
        : pipLayouts[card.rank].map(([x, y]) => `<use class="pip" href="#suit" transform="translate(${x} ${y}) rotate(${y > 98 ? 180 : 0}) scale(${card.rank >= 9 ? .76 : .9})"/>`).join('');
      svg = cardFrame(`<g fill="${suit.color}">${corner(card.rank, suit.color)}${artwork}</g>${card.joker ? jokerStamp(card.joker) : ''}`,
        `<path id="suit" d="${suit.path}"/>`, cardText(card));
    }
    const image = encode(svg);
    cardCache.set(key, image);
    return image;
  }

  const cardBack = encode(cardFrame(`
    <rect x="8" y="8" width="124" height="180" rx="5" fill="${palette.petrol}"/>
    <rect x="12" y="12" width="116" height="172" rx="3" fill="url(#weave)" stroke="${palette.brass}" stroke-width="1"/>
    <rect x="17" y="17" width="106" height="162" rx="2" fill="none" stroke="${palette.paleGold}" stroke-width=".5"/>
    <g fill="${palette.paleGold}" stroke="${palette.brass}" stroke-width=".6">
      <path d="M21 27V21H27M113 21H119V27M119 169V175H113M27 175H21V169" fill="none" stroke-width="1.5"/>
      <path d="M70 25l4 6-4 6-4-6ZM70 159l4 6-4 6-4-6Z"/>
    </g>
    <path d="M70 57L104 98L70 139L36 98Z" fill="${palette.petrol}" stroke="${palette.brass}" stroke-width="1.5"/>
    <path d="M70 63L98 98L70 133L42 98Z" fill="${palette.burgundy}" stroke="${palette.paleGold}" stroke-width=".6"/>
    <g transform="translate(70 98)" fill="${palette.paleGold}" stroke="${palette.brass}" stroke-width="1">
      <path d="M0-4C-22-30-31-3-5 0C-31 5-19 29 0 5C19 29 31 5 5 0C31-3 22-30 0-4Z"/>
      <path d="M0-16V16M-16 0H16" stroke="${palette.petrol}" stroke-width=".8"/>
      <circle r="5" fill="${palette.petrol}"/><circle r="2" fill="${palette.paleGold}"/>
    </g>`, `<pattern id="weave" width="12" height="16" patternUnits="userSpaceOnUse">
      <path d="M6 0L12 8L6 16L0 8Z" fill="none" stroke="${palette.brass}" stroke-width=".55" opacity=".7"/>
      <path d="M6 5L8 8L6 11L4 8Z" fill="${palette.paleGold}" opacity=".35"/>
    </pattern>`, '牌背'));

  // Engraved numerals are paths, so the token appearance is independent of installed fonts.
  const numerals = Object.freeze({
    1: 'M58 57L70 47V96M58 97H82',
    2: 'M54 60C54 42 84 41 86 57C88 69 65 80 54 96H87',
    3: 'M54 51C67 41 85 47 85 60C85 69 75 73 65 73M65 73C88 69 93 96 72 98C62 100 55 95 52 92',
    4: 'M79 98V47L51 82H91',
    5: 'M85 48H57L55 72C64 65 86 69 87 82C90 101 65 104 53 93'
  });

  function coinImage(number) {
    if (!Number.isInteger(number) || number < 1 || number > 5) {
      throw new RangeError('Coin number must be an integer from 1 to 5');
    }
    if (coinCache.has(number)) return coinCache.get(number);
    const ridges = Array.from({ length: 48 }, (_, index) =>
      `<path d="M70 9V15" transform="rotate(${index * 7.5} 70 70)"/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140" role="img">
      <title>硬币 ${number}</title><defs>
        <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fae8b3"/><stop offset=".26" stop-color="#b78b46"/><stop offset=".52" stop-color="#edd29a"/><stop offset=".79" stop-color="#946b33"/><stop offset="1" stop-color="#e5c58b"/></linearGradient>
        <radialGradient id="face" cx=".34" cy=".25" r=".8"><stop stop-color="#efd8a4"/><stop offset=".62" stop-color="#c59e59"/><stop offset="1" stop-color="#aa7d3d"/></radialGradient>
      </defs>
      <circle cx="70" cy="73" r="65" fill="#091e24" opacity=".3"/>
      <circle cx="70" cy="70" r="64" fill="url(#metal)" stroke="#705228" stroke-width="2"/>
      <circle cx="70" cy="70" r="61.5" fill="none" stroke="#ffefc3" stroke-opacity=".7"/>
      <g stroke="#76552b" stroke-width="1.25" opacity=".8">${ridges}</g>
      <circle cx="70" cy="70" r="52" fill="url(#face)" stroke="#f3dc9f" stroke-width="2"/>
      <circle cx="70" cy="70" r="46" fill="none" stroke="#876030" stroke-width=".9"/>
      <circle cx="70" cy="70" r="42" fill="none" stroke="#fce9b7" stroke-opacity=".6" stroke-width=".6"/>
      <path d="M62 31L70 27L78 31M62 109L70 113L78 109" fill="none" stroke="#71502a" stroke-width="1.5"/>
      <path d="${numerals[number]}" fill="none" stroke="#ffe8ab" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 1.5)"/>
      <path class="coin-number" d="${numerals[number]}" fill="none" stroke="#513d25" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M27 46Q38 23 63 21" fill="none" stroke="#fff2c8" stroke-width="2" stroke-linecap="round" opacity=".7"/>
    </svg>`;
    const image = encode(svg);
    coinCache.set(number, image);
    return image;
  }

  return Object.freeze({ cardImage, cardBack, cardText, coinImage });
});
