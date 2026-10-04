const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../public/settlement-details');
const { evaluateFiveCards, compareHands } = require('../src/poker');
const c = (rank,suit) => ({rank,suit});
function detail(cardsA,cardsB) {
  const a={playerId:'A',coin:5,hand:evaluateFiveCards(cardsA)}, b={playerId:'B',coin:4,hand:evaluateFiveCards(cardsB)};
  const comparison=compareHands(a.hand,b.hand);
  return describe({higherPlayerId:'A',lowerPlayerId:'B',higherCoin:5,lowerCoin:4,comparison,passed:comparison<=0},[b,a]);
}
test('explains an out-of-order pair vs high-card as failure, using coin rather than hand order',()=>{
  const d=detail([c(13,'s'),c(13,'h'),c(10,'c'),c(8,'d'),c(2,'s')],[c(14,'h'),c(12,'h'),c(9,'c'),c(6,'d'),c(3,'s')]);
  assert.equal(d.verdict,'失败'); assert.equal(d.symbol,'＞'); assert.equal(d.left.coin,5);
  assert.match(d.reason,/一对 ＞ 高牌/); assert.match(d.reason,/5 号比 4 号强/);
});
test('explains kicker decisions and accepts exact ties across different suits',()=>{
  const a=[c(13,'s'),c(13,'h'),c(12,'c'),c(8,'d'),c(2,'s')];
  const b=[c(13,'d'),c(13,'c'),c(14,'c'),c(9,'d'),c(3,'s')];
  const d=detail(a,b); assert.equal(d.verdict,'通过');assert.match(d.reason,/第 1 张踢脚牌：Q ＜ A/);
  const tie=detail(a,[c(13,'d'),c(13,'c'),c(12,'h'),c(8,'c'),c(2,'d')]);
  assert.equal(tie.symbol,'=');assert.equal(tie.verdict,'平局通过');assert.match(tie.reason,/完全相同/);
});
test('uses the wheel as five high rather than ace high',()=>{
  const d=detail([c(14,'h'),c(2,'s'),c(3,'d'),c(4,'c'),c(5,'s')],[c(2,'h'),c(3,'s'),c(4,'d'),c(5,'c'),c(6,'s')]);
  assert.equal(d.verdict,'通过');assert.match(d.reason,/最高牌：5 ＜ 6/);
});
test('explains full houses by triple first, then pair',()=>{
  const d=detail([c(8,'s'),c(8,'h'),c(8,'c'),c(12,'d'),c(12,'c')],[c(8,'d'),c(8,'h'),c(8,'c'),c(13,'s'),c(13,'h')]);
  assert.match(d.reason,/对子的点数：Q ＜ K/);
});
