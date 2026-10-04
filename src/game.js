const { createDeck, shuffle, findBestHand, compareHands, CoinTable } = require('./poker');

const PHASES = Object.freeze({
  WAITING: 'WAITING',
  ROUND_1_COINS: 'ROUND_1_COINS',
  ROUND_2_COINS: 'ROUND_2_COINS',
  ROUND_3_COINS: 'ROUND_3_COINS',
  ROUND_4_COINS: 'ROUND_4_COINS',
  FINAL_REVEAL: 'FINAL_REVEAL',
  SETTLEMENT: 'SETTLEMENT',
  GAME_OVER: 'GAME_OVER'
});

class GameRoom {
  constructor({ players, handCardCount = 2, handUsageRule = 'any', historyVisibility = 'all', turnTimerEnabled = false, turnTimerSeconds = 0, spectatorSlots = 0, random = Math.random } = {}) {
    if (!players || players.length < 2) throw new Error('At least two players are required');
    if (players.length > 5) throw new Error('At most five players are allowed');
    if (new Set(players).size !== players.length) throw new Error('Player names must be unique');
    if (handCardCount !== 2 && handCardCount !== 3) throw new Error('handCardCount must be 2 or 3');
    if (!['any', 'all-hole'].includes(handUsageRule)) throw new Error('Invalid handUsageRule');
    if (!['all', 'self', 'none'].includes(historyVisibility)) throw new Error('Invalid historyVisibility');
    if (!Number.isInteger(spectatorSlots) || spectatorSlots < 0 || spectatorSlots > 8) throw new Error('spectatorSlots must be between 0 and 8');
    this.players = players.map(id => ({ id, holeCards: [], currentCoin: null, coinHistory: [], finalHand: null }));
    this.handCardCount = handCardCount;
    this.handUsageRule = handUsageRule;
    this.historyVisibility = historyVisibility;
    this.turnTimerEnabled = turnTimerEnabled;
    this.turnTimerSeconds = turnTimerSeconds;
    this.spectatorSlots = spectatorSlots;
    this.spectators = new Set();
    this.rematchConfirmed = new Set();
    this.replayEvents = [];
    this.eventSequence = 0;
    this.random = random;
    this.phase = PHASES.WAITING;
    this.communityCards = [];
    this.coinTable = null;
    this.deck = [];
    this.successCount = 0;
    this.failureCount = 0;
    this.lastResult = null;
    this.closed = false;
  }

  start() {
    if (this.closed) throw new Error('Room is closed');
    if (![PHASES.WAITING, PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(this.phase)) throw new Error('Room cannot start from current phase');
    if (this.phase === PHASES.GAME_OVER) {
      this.successCount = 0;
      this.failureCount = 0;
    }
    this.deck = shuffle(createDeck(), this.random);
    this.communityCards = [];
    this.players.forEach(player => {
      player.holeCards = this.deck.splice(0, this.handCardCount);
      player.currentCoin = null;
      player.finalHand = null;
      player.coinHistory = [];
    });
    this.coinTable = new CoinTable(this.players.map(player => player.id));
    this.phase = PHASES.ROUND_1_COINS;
    this.lastResult = null;
    this.rematchConfirmed.clear();
    this.record('GAME_STARTED');
  }

  moveCoin(coin, toPlayer, fromPlayer = null) {
    if (![PHASES.ROUND_1_COINS, PHASES.ROUND_2_COINS, PHASES.ROUND_3_COINS, PHASES.ROUND_4_COINS].includes(this.phase)) throw new Error('Coin selection is closed');
    const target = this.players.find(player => player.id === toPlayer);
    if (!target) throw new Error('Unknown target player');
    if (!Number.isInteger(coin) || coin < 1 || coin > this.players.length) throw new Error('Invalid coin');
    if (fromPlayer && this.coinTable.owners.get(coin) !== fromPlayer) throw new Error('Invalid source player');
    if (target.currentCoin !== null && !this.coinTable.owners.has(coin)) throw new Error('Player already owns a coin');
    this.coinTable.move(coin, toPlayer, fromPlayer);
    this.record('COIN_MOVED', { coin, toPlayer, fromPlayer });
    this.players.forEach(player => { player.currentCoin = null; });
    for (const [number, owner] of this.coinTable.owners) {
      this.players.find(player => player.id === owner).currentCoin = number;
    }
    if (this.coinTable.isComplete()) this.completeCoinRound();
  }

  returnCoin(coin, player) {
    if (![PHASES.ROUND_1_COINS, PHASES.ROUND_2_COINS, PHASES.ROUND_3_COINS, PHASES.ROUND_4_COINS].includes(this.phase)) throw new Error('Coin selection is closed');
    if (!this.coinTable) throw new Error('Coin table is not initialized');
    this.coinTable.returnCoin(coin, player);
    const target = this.players.find(item => item.id === player);
    target.currentCoin = null;
    this.record('COIN_RETURNED', { coin, player });
  }

  completeCoinRound() {
    this.players.forEach(player => player.coinHistory.push(player.currentCoin));
    const completedPhase = this.phase;
    if (this.phase === PHASES.ROUND_1_COINS) {
      this.communityCards.push(...this.deck.splice(0, 3));
      this.phase = PHASES.ROUND_2_COINS;
    } else if (this.phase === PHASES.ROUND_2_COINS) {
      this.communityCards.push(this.deck.shift());
      this.phase = PHASES.ROUND_3_COINS;
    } else if (this.phase === PHASES.ROUND_3_COINS) {
      this.communityCards.push(this.deck.shift());
      this.phase = PHASES.ROUND_4_COINS;
    } else {
      this.phase = PHASES.FINAL_REVEAL;
      this.calculateFinalHands();
      this.settle();
    }
    this.record('ROUND_COMPLETED', { phase: completedPhase, coinHistory: this.players.map(player => ({ playerId: player.id, coin: player.currentCoin })) });
    if (completedPhase !== PHASES.ROUND_4_COINS) {
      this.coinTable = new CoinTable(this.players.map(player => player.id));
      this.players.forEach(player => { player.currentCoin = null; });
    }
  }

  calculateFinalHands() {
    this.players.forEach(player => {
      player.finalHand = findBestHand(player.holeCards, this.communityCards, this.handUsageRule);
    });
    this.record('FINAL_HANDS_CALCULATED');
  }

  settle() {
    if (this.phase !== PHASES.FINAL_REVEAL) throw new Error('Final reveal is not ready');
    const ordered = [...this.players].sort((a, b) => b.currentCoin - a.currentCoin);
    const comparisons = [];
    let success = true;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const comparison = compareHands(ordered[i].finalHand, ordered[i + 1].finalHand);
      // Coin 1 represents the strongest predicted hand. Since reveals run
      // from the highest coin down to 1, hand strength must increase.
      const passed = comparison <= 0;
      comparisons.push({ higherCoin: ordered[i].currentCoin, lowerCoin: ordered[i + 1].currentCoin, higherPlayerId: ordered[i].id, lowerPlayerId: ordered[i + 1].id, passed, comparison });
      if (!passed) success = false;
    }
    if (success) this.successCount += 1;
    else this.failureCount += 1;
    this.lastResult = { success, comparisons };
    this.phase = (this.successCount >= 3 || this.failureCount >= 3) ? PHASES.GAME_OVER : PHASES.SETTLEMENT;
    this.record('GAME_SETTLED', this.lastResult);
    return this.lastResult;
  }

  addSpectator(id) {
    if (this.spectators.size >= this.spectatorSlots) throw new Error('Spectator positions are full');
    if (this.players.some(player => player.id === id)) throw new Error('Player already exists');
    this.spectators.add(id);
    this.record('SPECTATOR_JOINED', { id });
  }

  removeSpectator(id) {
    this.spectators.delete(id);
    this.record('SPECTATOR_LEFT', { id });
  }

  confirmRematch(playerId) {
    if (this.closed) throw new Error('Room is closed');
    if (![PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(this.phase)) throw new Error('Rematch is unavailable');
    if (!this.players.some(player => player.id === playerId)) throw new Error('Unknown player');
    this.rematchConfirmed.add(playerId);
    this.record('REMATCH_CONFIRMED', { playerId });
    if (this.rematchConfirmed.size === this.players.length) this.start();
  }

  endGame() {
    if (![PHASES.SETTLEMENT, PHASES.GAME_OVER].includes(this.phase)) throw new Error('Game cannot end now');
    this.phase = PHASES.GAME_OVER;
    this.closed = true;
    this.record('ROOM_ENDED');
  }

  record(type, payload = {}) {
    this.replayEvents.push({ sequence: ++this.eventSequence, type, payload });
  }

  getReplay() { return this.replayEvents.slice(); }

  getPlayerView(playerId) {
    const self = this.players.find(player => player.id === playerId);
    if (!self) throw new Error('Unknown player');
    return {
      phase: this.phase,
      communityCards: this.communityCards.slice(),
      ownHoleCards: self.holeCards.slice(),
      ownEstimatedHand: self.holeCards.length + this.communityCards.length >= 5
        ? findBestHand(self.holeCards, this.communityCards, this.handUsageRule) : null,
      coinHistory: this.historyVisibility === 'none' ? [] : self.coinHistory.slice(),
      players: this.players.map(player => ({ id: player.id, currentCoin: player.currentCoin, coinHistory: this.historyVisibility === 'all' || (this.historyVisibility === 'self' && player.id === playerId) ? player.coinHistory.slice() : [] }))
    };
  }
}

module.exports = { GameRoom, PHASES };
