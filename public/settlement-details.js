(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SettlementDetails = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const rank = value => ({14:'A',13:'K',12:'Q',11:'J'})[value] || String(value);
  function decidingPart(category, index) {
    if (category === 0 || category === 5) return `从大到小第 ${index + 1} 张牌`;
    if (category === 4 || category === 8) return '顺子的最高牌';
    if (category === 6) return index === 0 ? '三条的点数' : '对子的点数';
    if (category === 2) return ['较大对子的点数','较小对子的点数','踢脚牌'][index];
    if (index === 0) return ({1:'对子的点数',3:'三条的点数',7:'四条的点数'})[category] || '主要牌点';
    return `第 ${index} 张踢脚牌`;
  }
  function describe(record, finalHands) {
    if (!record) return null;
    const left = finalHands.find(entry => entry.playerId === record.higherPlayerId) || null;
    const right = finalHands.find(entry => entry.playerId === record.lowerPlayerId) || null;
    const symbol = record.comparison === 0 ? '=' : record.comparison < 0 ? '＜' : '＞';
    const verdict = record.comparison === 0 ? '平局通过' : record.passed ? '通过' : '失败';
    let explanation = '';
    if (!left?.hand || !right?.hand) return {left,right,symbol,verdict,reason:'牌组信息暂不可用。'};
    if (record.comparison === 0) {
      explanation = '两组牌的比较点数完全相同，平局也符合顺序。花色不参与大小比较。';
    } else if (left.hand.category !== right.hand.category) {
      explanation = `牌型不同：${left.hand.categoryName} ${symbol} ${right.hand.categoryName}。`;
    } else {
      const a = left.hand.tiebreak || [], b = right.hand.tiebreak || [];
      const index = a.findIndex((value, i) => value !== b[i]);
      explanation = index >= 0
        ? `同为${left.hand.categoryName}，比较${decidingPart(left.hand.category,index)}：${rank(a[index])} ${symbol} ${rank(b[index])}。`
        : `${left.hand.categoryName} ${symbol} ${right.hand.categoryName}。`;
    }
    const ordering = record.comparison === 0 ? '' : record.passed
      ? `${record.lowerCoin} 号比 ${record.higherCoin} 号强，顺序正确。`
      : `${record.higherCoin} 号比 ${record.lowerCoin} 号强，顺序不符。`;
    return {left,right,symbol,verdict,reason:explanation + ordering};
  }
  return { describe };
});
