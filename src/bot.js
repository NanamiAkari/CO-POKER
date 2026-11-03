const { findBestHand } = require('./poker');

// Seven names are enough for a host plus seven bots. Names are the only
// visible distinction, so they are also the bot player ids.
const BOT_NAMES = Object.freeze([
  'Robot Jack',
  'Robot Sam',
  'Robot Daniel',
  'Robot Mike',
  'Robot Alex',
  'Robot Chris',
  'Robot Ben'
]);

const COIN_PHASES = new Set(['ROUND_1_COINS', 'ROUND_2_COINS', 'ROUND_3_COINS', 'ROUND_4_COINS']);
const REMATCH_PHASES = new Set(['SETTLEMENT', 'GAME_OVER']);
const CATEGORY_STRENGTH = [0.08, 0.38, 0.62, 0.76, 0.84, 0.9, 0.95, 0.98, 1];

function cardRank(card) {
  if (!card || card.joker) return 15;
  return card.rank || 2;
}

function estimateStrength(game, player) {
  const cards = player.holeCards.concat(game.communityCards);
  if (cards.length >= 5) {
    const hand = findBestHand(player.holeCards, game.communityCards, game.handUsageRule);
    const category = CATEGORY_STRENGTH[hand.category] ?? 0;
    const kicker = (hand.tiebreak?.[0] || 2) / 14;
    return Math.min(1, Math.max(0, category + kicker * 0.06));
  }
  const ranks = player.holeCards.map(cardRank).sort((a, b) => b - a);
  if (!ranks.length) return 0.5;
  const high = ((ranks[0] || 2) + (ranks[1] || 2)) / 28;
  const pair = ranks.length >= 2 && ranks[0] === ranks[1];
  const suited = player.holeCards.length >= 2 && player.holeCards[0]?.suit && player.holeCards[0].suit === player.holeCards[1]?.suit;
  const connected = ranks.length >= 2 && Math.abs(ranks[0] - ranks[1]) <= 1;
  const strength = pair ? 0.7 + high * 0.2 : 0.15 + high * 0.45 + (suited ? 0.04 : 0) + (connected ? 0.03 : 0);
  return Math.min(1, Math.max(0, strength));
}

function chooseBotCoin(game, bot, random = Math.random) {
  const free = [...game.coinTable.area].sort((a, b) => a - b);
  if (!free.length) return null;
  const count = game.players.length;
  const strength = estimateStrength(game, bot);
  const target = Math.min(count, Math.max(1, Math.round(1 + (1 - strength) * (count - 1))));
  const distance = coin => Math.abs(coin - target);
  const best = Math.min(...free.map(distance));
  const closest = free.filter(coin => distance(coin) === best);
  return closest[Math.floor(random() * closest.length)] ?? closest[0];
}

class BotDriver {
  constructor({
    room,
    onChange,
    onError = error => console.error('[bot] action failed:', error),
    random = Math.random,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    coinDelayMs = 450,
    rematchDelayMs = 450,
    skipDelayMs = 300
  }) {
    this.room = room;
    this.onChange = onChange;
    this.onError = onError;
    this.random = random;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.coinDelayMs = coinDelayMs;
    this.rematchDelayMs = rematchDelayMs;
    this.skipDelayMs = skipDelayMs;
    this.timers = new Map();
    this.stopped = false;
  }

  schedule(key, baseDelay, action) {
    if (this.stopped || this.timers.has(key)) return;
    const delay = Math.max(0, Math.floor(baseDelay + this.random() * baseDelay));
    const timer = this.setTimeoutFn(() => {
      this.timers.delete(key);
      if (this.stopped) return;
      try { action(); } catch (error) { this.onError(error); }
    }, delay);
    this.timers.set(key, timer);
  }

  sync() {
    if (this.stopped || !this.room.game) return;
    const game = this.room.game;
    const bots = game.players.filter(player => player.isBot);

    if (COIN_PHASES.has(game.phase)) {
      // Each bot gets its own timer, so a full table can choose at the same
      // time. The client animates each coin independently; the server still
      // resolves the actual moves in arrival order.
      const phase = game.phase;
      if (game.coinTable?.area.size) {
        for (const bot of bots) {
          if (bot.currentCoin !== null) continue;
          this.schedule(`coin:${bot.id}:${phase}`, this.coinDelayMs, () => {
            if (this.room.game !== game || game.phase !== phase || bot.currentCoin !== null || !game.coinTable?.area.size) return;
            const coin = chooseBotCoin(game, bot, this.random);
            if (!Number.isInteger(coin)) return;
            const fromPlayerId = game.coinTable.owners.get(coin) || null;
            game.moveCoin(coin, bot.id);
            this.onChange({ coinAction: { type: 'MOVE', coin, fromPlayerId, toPlayerId: bot.id } });
          });
        }
      }
    }

    if (REMATCH_PHASES.has(game.phase)) {
      const phase = game.phase;
      const hostConfirmed = game.rematchConfirmed.has(this.room.hostId);
      if (hostConfirmed) {
        for (const bot of bots) {
          if (game.rematchConfirmed.has(bot.id)) continue;
          this.schedule(`rematch:${bot.id}:${phase}`, this.rematchDelayMs, () => {
            if (this.room.game !== game || game.phase !== phase || game.rematchConfirmed.has(bot.id)) return;
            if (!game.rematchConfirmed.has(this.room.hostId)) return;
            game.confirmRematch(bot.id);
            this.onChange();
          });
        }
      }
      if (game.lastResult && game.comparisonSkipVotes.size > 0 && !game.comparisonSkip) {
        for (const bot of bots) {
          if (game.comparisonSkipVotes.has(bot.id)) continue;
          this.schedule(`skip:${bot.id}:${phase}`, this.skipDelayMs, () => {
            if (this.room.game !== game || game.phase !== phase || game.comparisonSkip || game.comparisonSkipVotes.has(bot.id)) return;
            game.requestComparisonSkip(bot.id);
            this.onChange();
          });
        }
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimeoutFn(timer);
    this.timers.clear();
  }
}

module.exports = { BOT_NAMES, BotDriver, chooseBotCoin, estimateStrength };
