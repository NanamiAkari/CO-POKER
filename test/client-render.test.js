const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Vue = require('vue');
const { compile } = require('@vue/compiler-dom');
const { renderToString } = require('@vue/server-renderer');
const Art = require('../public/tabletop-art');
const SettlementDetails = require('../public/settlement-details');
const HandHighlights = require('../public/hand-highlights');
const { findBestHand } = require('../src/poker');
const RoomChat = require('../public/room-chat');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const template = html.slice(html.indexOf('<div id="app"'), html.indexOf('<script src="/vendor'));
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)(Vue);

async function renderScreen(configure = () => {}, timers = {setTimeout, clearTimeout}, environment = {}) {
  let root;
  const components = {};
  const script = fs.readFileSync(path.join(__dirname, '../public/game-client.js'), 'utf8');
  const context = {
    Vue: { ...Vue, createApp(options) {
      root = options;
      return { component(name, options) { components[name] = options; }, config: {}, mount() {} };
    } },
    window: { TabletopArt: Art, SettlementDetails, HandHighlights, RoomChat, matchMedia: () => ({ matches: false }) },
    document: { querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    ...timers, console
  };
  Object.assign(context.window, environment.window);
  if(environment.document)context.document=environment.document;
  if(environment.navigator)context.navigator=environment.navigator;
  vm.runInNewContext(script, context);
  const app = Vue.createSSRApp({ render, setup() { const view = root.setup(); configure(view); return view; } });
  const warnings = [];
  app.config.warnHandler = warning => warnings.push(warning);
  for (const [name, options] of Object.entries(components)) app.component(name, options);
  const output = await renderToString(app);
  assert.deepEqual(warnings, []);
  return output;
}

test('actual Vue menu and settings templates render without missing bindings', async () => {
  const home = await renderScreen();
  assert.match(home, /CO-POKER/);
  assert.match(home, /德扑/);
  assert.match(home, /创建房间/);
  assert.match(home, /加入房间/);
  assert.doesNotMatch(home, /\{\{/);
  const settings = await renderScreen(v => { v.panel.value = 'settings'; });
  assert.match(settings, /role="dialog"/);
  assert.match(settings, /桌面音效/);
  assert.match(settings, /演出节奏/);
});

test('room chat renders text and emoji safely while table actions are busy', async () => {
  const content='<img src=x onerror=alert(1)> 大家好 😀';
  const output=await renderScreen(v=>{
    v.inRoom.value=true;v.connected.value=true;v.playerId.value='A';v.roomId.value='ABC123';v.busy.value=true;v.pending.value=true;
    v.chatDraft.value='继续 👍';
    v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:1,playerId:'B',role:'PLAYER',kind:'text',text:content,timestamp:1,clientMessageId:'test-1'}});
    assert.equal(v.chatCanSend.value,true,'game action locks must not lock chat');
    assert.equal(v.pending.value,true,'chat must not acknowledge a game action');
  });
  assert.match(output,/aria-label="聊天消息"/);
  assert.match(output,/&lt;img src=x onerror=alert\(1\)&gt; 大家好 😀/);
  assert.doesNotMatch(output,/<img src=x/);
  assert.match(output,/选择 emoji/);
  const empty=await renderScreen(v=>{v.inRoom.value=true;v.chatPanel.value='stickers';});
  assert.match(empty,/暂无表情包/);
  const folded=await renderScreen(v=>{
    v.inRoom.value=true;v.roomId.value='ABC123';v.playerId.value='A';v.toggleChat();
    v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:1,playerId:'B',role:'SPECTATOR',kind:'text',text:'观战中',timestamp:1}});
    assert.equal(v.chatUnread.value,1);
  });
  assert.match(folded,/aria-label="打开房间聊天"/);
  assert.match(folded,/class="chat-unread">1</);
  assert.doesNotMatch(folded,/id="room-chat-panel"/);
});

test('host can render the post-round room rules panel', async () => {
  const view = await renderScreen(v => {
    v.inRoom.value = true;
    v.playerId.value = 'host';
    v.panel.value = 'room-settings';
    Object.assign(v.state, {phase:'GAME_OVER',hostId:'host',options:{handCardCount:2,handUsageRule:'any',historyVisibility:'all',spectatorSlots:2}});
  });
  assert.match(view, /下一场规则/);
  assert.match(view, /修改后，所有玩家需要重新确认下一场/);
  assert.match(view, /保存下一场规则/);
});

test('live chat bubbles follow the speaker in both player viewpoints and settlement order', async () => {
  const players=[{id:'A',currentCoin:1},{id:'B',currentCoin:2}];
  for(const viewer of ['A','B']){
    const other=viewer==='A'?'B':'A';
    const output=await renderScreen(v=>{
      v.inRoom.value=true;v.playerId.value=viewer;v.roomId.value='ABC123';
      v.state.players=players;v.state.phase='ROUND_1_COINS';v.chatOpen.value=false;
      for(const [index,playerId] of ['A','B'].entries())v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:index+1,playerId,role:'PLAYER',kind:'text',text:playerId+' 加油 👍'}});
    });
    assert.match(output,new RegExp('<article[^>]*data-player="'+other+'"[\\s\\S]*?data-speaker="'+other+'"'));
    assert.match(output,new RegExp('<div class="self-hand[^>]*>[\\s\\S]*?data-speaker="'+viewer+'"'));
    assert.equal((output.match(/class="chat-bubble"/g)||[]).length,2);
    assert.doesNotMatch(output,/id="room-chat-panel"/,'folding the log does not hide bubbles');
  }
  const result=await renderScreen(v=>{
    v.inRoom.value=true;v.playerId.value='丙';v.roomId.value='ABC123';v.presentation.value='summary';Object.assign(v.state,fivePlayerResult());
    for(const [i,p] of v.state.players.entries())v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:i+1,playerId:p.id,role:'PLAYER',kind:'text',text:'下一局一起加油'}});
  });
  const order=result.match(/<ol class="order-players">[\s\S]*?<\/ol>/)[0];
  assert.equal((order.match(/class="chat-bubble"/g)||[]).length,5);
  assert.equal((result.match(/class="chat-bubble"/g)||[]).length,5,'settlement has no duplicate bubbles at hidden seats');
});

test('bubble contents are plain text, history does not pop, and spectators retain attribution', async () => {
  const output=await renderScreen(v=>{
    v.inRoom.value=true;v.playerId.value='A';v.roomId.value='ABC123';v.state.players=[{id:'A'}];
    v.handleChatMessage({type:'ROOM_STATE',roomId:'ABC123',chatHistory:[{id:1,playerId:'A',role:'PLAYER',kind:'text',text:'旧消息'}]});
    assert.equal(v.chatBubbleFor('A'),null);
    v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:2,playerId:'A',role:'PLAYER',kind:'text',text:'<img src=x onerror=alert(1)> 😀'}});
    v.handleChatMessage({type:'CHAT_MESSAGE',roomId:'ABC123',message:{id:3,playerId:'观战者',role:'SPECTATOR',kind:'text',text:'加油'}});
  });
  assert.match(output,/<p class="chat-bubble-text">&lt;img src=x onerror=alert\(1\)&gt; 😀<\/p>/);
  assert.match(output,/class="chat-bubble-author">观战者 · 观战/);
  assert.doesNotMatch(output,/<img src=x/);
});

test('joker rule is off by default, configurable at creation and retained in next-game settings', async () => {
  const creation=await renderScreen(v=>{v.panel.value='create';assert.equal(v.roomSettings.includeJokers,false);});
  assert.match(creation,/type="checkbox"[^>]*aria-label="牌堆加入大小王"/);
  assert.doesNotMatch(creation.match(/<input[^>]*aria-label="牌堆加入大小王"[^>]*>/)[0],/\bchecked\b/);
  const nextGame=await renderScreen(v=>{
    v.inRoom.value=true;v.playerId.value='A';
    Object.assign(v.state,{phase:'GAME_OVER',hostId:'A',options:{handCardCount:3,handUsageRule:'all-hole',historyVisibility:'all',spectatorSlots:2,includeJokers:true}});
    v.prepareRoomSettings();assert.equal(v.roomSettings.includeJokers,true);
  });
  assert.match(nextGame.match(/<input[^>]*aria-label="牌堆加入大小王"[^>]*>/)[0],/\bchecked\b/);
  const waiting=await renderScreen(v=>{v.inRoom.value=true;v.state.options.includeJokers=true;});
  assert.match(waiting,/含大小王 · 54 张/);
});

test('joker source identities survive replacement in selection, hints, summary and final table', async () => {
  const red={joker:'red'},black={joker:'black'};
  const board=[{rank:14,suit:'s'},{rank:14,suit:'d'},{rank:13,suit:'c'},{rank:3,suit:'h'},{rank:4,suit:'d'}];
  const best=findBestHand([red,black],board,'all-hole');
  assert.equal(best.category,7);
  const a={playerId:'A',coin:1,holeCards:[red,black],hand:best};
  const b={playerId:'B',coin:2,holeCards:[{rank:8,suit:'c'},{rank:9,suit:'c'}],hand:findBestHand([{rank:8,suit:'c'},{rank:9,suit:'c'}],board)};
  for(const stage of ['idle','select','compare','summary','table']){
    const output=await renderScreen(v=>{
      v.inRoom.value=true;v.playerId.value='A';v.presentation.value=stage;
      Object.assign(v.state,{phase:stage==='idle'?'ROUND_4_COINS':'SETTLEMENT',players:[{id:'A',currentCoin:1},{id:'B',currentCoin:2}],ownHoleCards:[red,black],communityCards:board,ownEstimatedHand:best,finalHands:[a,b],result:stage==='idle'?null:{success:true,comparisons:[{higherCoin:2,lowerCoin:1,higherPlayerId:'B',lowerPlayerId:'A',passed:true,comparison:-1}]}});
      v.summaryIndex.value=1;v.revealIndex.value=1;v.selectionLit.value=true;
      assert.equal(v.isChosen(a,red),true);assert.equal(v.isChosen(a,black),true);
      assert.equal(v.isChosen(a,{rank:14,suit:'h'}),false,'a simulated heart ace is still the red joker, not the physical ace');
      assert.equal(v.cardHighlight(best,red).meta.role,'quads');
      assert.equal(v.cardHighlight(best,black).card.joker,'black');
      assert.equal(v.cardHighlight(best,{rank:14,suit:'h'}),undefined);
    });
    assert.match(output,/aria-label="大王"/);assert.match(output,/aria-label="小王"/);
    assert.match(output,/大王（作 A♥）/);assert.match(output,/小王（作 A♣）/);
    assert.doesNotMatch(output,/undefined|\[object Object\]/);
  }
});

test('copying a room works on HTTP, restores focus, and reports unsupported clipboard honestly', async () => {
  for(const outcome of [true,false,'throw']){
    let view,field,selected,removed=false,restored=false;
    const environment={document:{
      activeElement:{focus(){restored=true;}},
      body:{appendChild(el){field=el;}},
      createElement(){return {style:{},focus(){},select(){},setSelectionRange(start,end){selected=[start,end];},remove(){removed=true;}};},
      execCommand(command){assert.equal(command,'copy');assert.equal(field.value,'ABC123');if(outcome==='throw')throw Error('blocked');return outcome;}
    }};
    await renderScreen(v=>{view=v;v.roomId.value='ABC123';},{setTimeout:()=>0,clearTimeout(){}},environment);
    await view.copyRoom();
    assert.equal(removed,true);assert.equal(restored,true);assert.deepEqual(selected,[0,6]);
    assert.equal(view.noticeError.value,outcome!==true);
    assert.match(view.notice.value,outcome===true?/房间号已复制/:/无法自动复制.*ABC123/);
  }
});

test('secure clipboard copies only the code and falls back after a rejected permission', async () => {
  for(const rejected of [false,true]){
    let view,copied,fallback=false;
    await renderScreen(v=>{view=v;v.roomId.value='DEF456';},{setTimeout:()=>0,clearTimeout(){}},{
      window:{isSecureContext:true},
      navigator:{clipboard:{async writeText(text){copied=text;if(rejected)throw Error('denied');}}},
      document:{body:{appendChild(){}},createElement(){return {style:{},focus(){},select(){},setSelectionRange(){},remove(){}};},execCommand(){fallback=true;return true;}}
    });
    await view.copyRoom();assert.equal(copied,'DEF456');assert.equal(fallback,rejected);assert.equal(view.noticeError.value,false);
  }
});

test('rulebook pages render with bounded previous/next and keyboard navigation', async () => {
  let pageCount;
  const first = await renderScreen(v => {
    v.panel.value = 'rules';
    pageCount = v.rulePages.length;
    v.goRulePage(-50);
    assert.equal(v.ruleStep.value, 0);
  });
  assert.match(first, /disabled[^>]*>← 上一页/);
  assert.doesNotMatch(first, /disabled[^>]*>下一页 →/);
  for (let i = 1; i < pageCount; i++) {
    const page = await renderScreen(v => {
      v.panel.value = 'rules';
      v.goRulePage(i - 1);
      let prevented = false;
      v.ruleKey({ key: 'PageDown', preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      assert.equal(v.ruleStep.value, i);
      v.ruleKey({ key: 'ArrowUp', preventDefault() {} });
      assert.equal(v.ruleStep.value, i - 1);
      v.goRulePage(i === pageCount - 1 ? 999 : i);
      assert.equal(v.ruleStep.value, i);
    });
    assert.match(page, /aria-label="规则正文"/);
    assert.match(page, new RegExp(`${i + 1} / ${pageCount}`));
    assert.doesNotMatch(page, /disabled[^>]*>← 上一页/);
    if (i === pageCount - 1) assert.match(page, /disabled[^>]*>下一页 →/);
  }
});

test('rulebook pages include visual guides for each topic', async () => {
  let pageCount;
  for (let i = 0; i < 8; i++) {
    const page = await renderScreen(v => { v.panel.value='rules'; pageCount=v.rulePages.length; v.goRulePage(i); });
    assert.equal(pageCount, 8);
    assert.match(page, /class="rule-visual visual-[^"]+"/);
    assert.match(page, /data:image\/svg\+xml/);
    assert.doesNotMatch(page, /\{\{|undefined|\[object Object\]/, 'rulebook pages have no unresolved Vue expressions');
  }
});

test('holding a coin keeps remaining public coins visible but disabled', async () => {
  const table = await renderScreen(v => {
    v.inRoom.value = true; v.connected.value = true; v.playerId.value = 'A';
    Object.assign(v.state, {phase:'ROUND_1_COINS',players:[{id:'A',currentCoin:1},{id:'B',currentCoin:null}],ownHoleCards:[{rank:14,suit:'s'},{rank:13,suit:'h'}]});
  });
  assert.match(table, /disabled aria-label="选择硬币 2"/);
  assert.match(table, /aria-label="归还硬币 1"/);
  assert.equal((table.match(/class="playing-card[^\"]*" aria-label="牌背"/g) || []).length, 7);
});

test('spectators see every player\'s hole cards during live play while players keep them face-down', async () => {
  const players = [
    {id:'A', currentCoin:1, holeCards:[{rank:14,suit:'h'},{rank:13,suit:'c'}]},
    {id:'B', currentCoin:2, holeCards:[{rank:10,suit:'s'},{rank:9,suit:'d'}]}
  ];
  const spectator = await renderScreen(v => {
    v.inRoom.value = true; v.connected.value = true; v.role.value = 'SPECTATOR'; v.playerId.value = 'watcher';
    Object.assign(v.state, {phase:'ROUND_2_COINS', players, communityCards:[{rank:2,suit:'c'},{rank:3,suit:'d'},{rank:4,suit:'h'}]});
  });
  assert.equal((spectator.match(/class="seat-cards spectator-reveal"/g) || []).length, 2);
  assert.match(spectator, /aria-label="A♥"/);
  assert.match(spectator, /aria-label="K♣"/);
  assert.match(spectator, /aria-label="10♠"/);
  assert.match(spectator, /aria-label="9♦"/);
  assert.doesNotMatch(spectator, /spectating player card placeholder/);

  const player = await renderScreen(v => {
    v.inRoom.value = true; v.connected.value = true; v.role.value = 'PLAYER'; v.playerId.value = 'watcher';
    Object.assign(v.state, {phase:'ROUND_2_COINS', players, communityCards:[{rank:2,suit:'c'},{rank:3,suit:'d'},{rank:4,suit:'h'}]});
  });
  assert.doesNotMatch(player, /class="seat-cards spectator-reveal"/);
  assert.equal((player.match(/class="playing-card[^\"]*" aria-label="牌背"/g) || []).length, 8);
});

test('own hand hint stays behind the exclamation hover and does not highlight the hand', async () => {
  const hand={category:1,categoryName:'一对',tiebreak:[9,14,13,11],cards:[{rank:9,suit:'s'},{rank:9,suit:'h'},{rank:14,suit:'d'},{rank:13,suit:'c'},{rank:11,suit:'s'}]};
  const table=await renderScreen(v=>{
    v.inRoom.value=true;v.connected.value=true;v.playerId.value='A';
    Object.assign(v.state,{phase:'ROUND_2_COINS',players:[{id:'A',currentCoin:null},{id:'B',currentCoin:null}],ownHoleCards:hand.cards.slice(0,2),ownEstimatedHand:hand});
  });
  assert.match(table,/查看当前最大牌型/);assert.match(table,/一对/);
  // The player's cards stay visually neutral during play. Highlighting is
  // reserved for the cards inside the hint popup shown on hover/focus.
  assert.equal((table.match(/highlight-pair/g)||[]).length,2);
  assert.match(table,/class="hint"/);
  assert.match(table,/class="hint-text"/);
});

test('result only renders a single stage with card images, never stacked result panels', async () => {
  const a = {playerId:'A',coin:2,holeCards:[{rank:2,suit:'s'},{rank:4,suit:'c'}],hand:{categoryName:'高牌',cards:[{rank:14,suit:'h'},{rank:13,suit:'c'},{rank:11,suit:'s'},{rank:9,suit:'c'},{rank:7,suit:'s'}]}};
  const b = {playerId:'B',coin:1,holeCards:[{rank:3,suit:'s'},{rank:5,suit:'c'}],hand:a.hand};
  for (const phase of ['select','compare','summary']) {
    const result = await renderScreen(v => {
      v.inRoom.value = true; v.playerId.value = 'A'; v.presentation.value = phase;
      Object.assign(v.state, {phase:'SETTLEMENT',players:[{id:'A',currentCoin:2},{id:'B',currentCoin:1}],finalHands:[a,b],result:{success:true,comparisons:[{higherCoin:2,lowerCoin:1,higherPlayerId:'A',lowerPlayerId:'B',passed:true,comparison:0}]}});
    });
    assert.equal((result.match(/class="stage-center/g)||[]).length,1,phase);
    assert.match(result,/data:image\/svg\+xml/);
    assert.doesNotMatch(result,/class="panel result"|class="panel reveal-panel"/);
  }
});

function fivePlayerResult() {
  const cards=[{rank:14,suit:'h'},{rank:13,suit:'c'},{rank:11,suit:'s'},{rank:9,suit:'c'},{rank:7,suit:'s'}];
  const finalHands=[
    {playerId:'甲',coin:5,hand:{category:1,categoryName:'一对',tiebreak:[2,14,13,11],cards}},
    {playerId:'乙',coin:4,hand:{category:0,categoryName:'高牌',tiebreak:[14,13,11,9,7],cards}},
    {playerId:'丙',coin:3,hand:{category:2,categoryName:'两对',tiebreak:[3,2,14],cards}},
    {playerId:'丁',coin:2,hand:{category:2,categoryName:'两对',tiebreak:[3,2,14],cards}},
    {playerId:'戊',coin:1,hand:{category:4,categoryName:'顺子',tiebreak:[8],cards}}
  ].map(entry=>({...entry,holeCards:cards.slice(0,2)}));
  const comparisons=[1,-1,0,-1].map((comparison,i)=>({higherCoin:5-i,lowerCoin:4-i,higherPlayerId:finalHands[i].playerId,lowerPlayerId:finalHands[i+1].playerId,comparison,passed:comparison<=0}));
  return {phase:'SETTLEMENT',finalHands:[...finalHands].reverse(),players:finalHands.map(e=>({id:e.playerId,currentCoin:e.coin})),communityCards:cards,failureCount:1,successCount:0,result:{success:false,comparisons}};
}

test('five-player settlement retains the full order and completed verdicts, with review details', async () => {
  const output=await renderScreen(v=>{
    v.inRoom.value=true;v.playerId.value='丙';v.presentation.value='compare';v.compareIndex.value=2;
    Object.assign(v.state,fivePlayerResult());v.completedComparisonCount.value=2;
    assert.deepEqual([...v.sortedFinalHands.value].map(e=>e.coin),[5,4,3,2,1]);
    assert.deepEqual([...v.comparisonSteps.value].map(e=>e.completed),[true,true,false,false]);
    v.comparisonHover.value=2;assert.equal(v.inspectedComparison.value,null,'unplayed comparison must not expose details');
    v.comparisonFocus.value=null;v.comparisonHover.value=0;
    assert.equal(v.comparisonDetail.value.verdict,'失败');
    assert.equal(v.displayedFailureCount.value,0,'current-round score stays hidden until the summary');
  });
  assert.match(output,/最终选币顺序/);
  assert.match(output,/硬币5与4：失败，查看详情/);
  assert.match(output,/硬币4与3：通过，查看详情/);
  assert.match(output,/硬币3与2：等待比较/);
  assert.match(output,/一对 ＞ 高牌/);
  assert.doesNotMatch(output,/aria-label="本局结算"/);
  const final=await renderScreen(v=>{
    v.inRoom.value=true;v.presentation.value='summary';Object.assign(v.state,fivePlayerResult());
    v.comparisonPinned.value=2;assert.equal(v.comparisonDetail.value.verdict,'平局通过');
    assert.equal(v.displayedFailureCount.value,1);
    v.closeComparisonDetail();assert.equal(v.inspectedComparison.value,null);
  });
  assert.match(final,/aria-label="本局结算"/);
  assert.equal((final.match(/class="comparison-marker complete/g)||[]).length,4);
});

test('settlement can hide the result to inspect the final table and restore it', async () => {
  let view;
  const fixture = fivePlayerResult();
  fixture.ownHoleCards = fixture.finalHands.find(entry => entry.playerId === '丙').holeCards.slice();
  const table = await renderScreen(v => {
    view = v;
    v.inRoom.value = true;
    v.playerId.value = '丙';
    v.presentation.value = 'table';
    Object.assign(v.state, fixture);
  });
  const summary = await renderScreen(v => {
    v.inRoom.value = true;
    v.playerId.value = '丙';
    v.presentation.value = 'summary';
    Object.assign(v.state, fixture);
  });
  assert.match(summary, /aria-label="查看牌桌"/);
  assert.doesNotMatch(summary, /重看比较|隐藏结算/);
  assert.equal((summary.match(/class="settlement-toggle"/g)||[]).length,1);
  assert.equal((table.match(/class="settlement-toggle"/g)||[]).length,1);
  assert.match(summary, /aria-label="本局结算"/);
  assert.match(table, /settlement-scene table-review/);
  assert.match(table, /aria-label="查看结算"/);
  assert.doesNotMatch(table, /最终选币顺序/);
  assert.match(table, /aria-label="A♥/);
  assert.match(table, /class="self-zone"/);
  view.showSettlementSummary();
  assert.equal(view.presentation.value, 'summary');
  view.showFinalTable();
  assert.equal(view.presentation.value, 'table');
  assert.equal(view.displayedFailureCount.value,fixture.failureCount,'reviewing the table must retain the settled score');
});

test('comparison playback completes every pair after a failure, then unlocks the summary; replay resets review state', async () => {
  let view,now=0,id=0;
  const scheduled=new Map();
  const timers={setTimeout(fn,ms){const key=++id;scheduled.set(key,{at:now+ms,fn});return key;},clearTimeout(key){scheduled.delete(key);}};
  await renderScreen(v=>{view=v;v.inRoom.value=true;v.presentation.value='summary';Object.assign(v.state,fivePlayerResult());v.comparisonPinned.value=0;},timers);
  const playback=view.replayReveal();
  assert.equal(view.completedComparisonCount.value,0);assert.equal(view.inspectedComparison.value,null);
  const completed=[];
  for(let guard=0;guard<100&&view.presentation.value!=='summary';guard++){
    const next=[...scheduled].sort((a,b)=>a[1].at-b[1].at)[0];assert.ok(next,'playback must schedule its next step');
    scheduled.delete(next[0]);now=next[1].at;next[1].fn();
    for(let n=0;n<5;n++)await Promise.resolve();
    if(view.presentation.value==='compare'){
      assert.equal(view.completedComparisonCount.value,view.compareIndex.value,'result marker must wait until animation ends');
      assert.equal(view.displayedFailureCount.value,0);
    }
    const count=view.completedComparisonCount.value;
    if(count&&completed.at(-1)!==count)completed.push(count);
  }
  await playback;
  assert.deepEqual(completed,[1,2,3,4]);assert.equal(view.presentation.value,'summary');assert.equal(view.busy.value,false);
  assert.equal(view.displayedFailureCount.value,1);
});

test('all-player comparison skip jumps to summary after selection playback', async () => {
  let view, now = 0, id = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout(fn, ms) { const key = ++id; scheduled.set(key, {at: now + ms, fn}); return key; },
    clearTimeout(key) { scheduled.delete(key); }
  };
  await renderScreen(v => {
    view = v;
    v.inRoom.value = true;
    v.presentation.value = 'summary';
    Object.assign(v.state, {...fivePlayerResult(), comparisonSkip: true});
  }, timers);
  const playback = view.replayReveal();
  for (let guard = 0; guard < 100 && view.presentation.value !== 'summary'; guard++) {
    const next = [...scheduled].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, 'selection playback must schedule its next step');
    scheduled.delete(next[0]);
    now = next[1].at;
    next[1].fn();
    for (let n = 0; n < 5; n++) await Promise.resolve();
  }
  await playback;
  assert.equal(view.presentation.value, 'summary');
  assert.equal(view.completedComparisonCount.value, view.state.result.comparisons.length);
});

test('two to five players show one icon-only review marker between each adjacent pair', async () => {
  for (let count=2;count<=5;count++) {
    const output=await renderScreen(v=>{
      v.inRoom.value=true;v.presentation.value='summary';
      const fixture=fivePlayerResult();
      fixture.finalHands=fixture.finalHands.filter(entry=>entry.coin<=count);
      fixture.result.comparisons=fixture.result.comparisons.filter(step=>step.higherCoin<=count);
      Object.assign(v.state,fixture);
    });
    const markers=[...output.matchAll(/<button class="comparison-marker[^>]*>([\s\S]*?)<\/button>/g)];
    assert.equal(markers.length,count-1);
    for(const [,body] of markers){
      assert.doesNotMatch(body,/<img|→|硬币/);
      assert.match(body,/>[✓×]<\/span>/);
    }
    assert.doesNotMatch(output,/class="order-arrow"|class="marker-coins"/);
  }
});

test('one persistent skip control stays outside every animation panel and displays the vote count', async () => {
  const base={phase:'SETTLEMENT',players:[{id:'A',currentCoin:2},{id:'B',currentCoin:1}],result:{success:false,comparisons:[{higherCoin:2,lowerCoin:1,higherPlayerId:'A',lowerPlayerId:'B',passed:false,comparison:1}]},finalHands:[]};
  for(const stage of ['hold','select','compare','gap']){
    const output=await renderScreen(v=>{v.inRoom.value=true;v.connected.value=true;v.role.value='PLAYER';v.playerId.value='A';v.presentation.value=stage;Object.assign(v.state,base);});
    assert.match(output,/跳过全部比较/);assert.match(output,/0\/2/);
    assert.equal((output.match(/class="skip-comparison"/g)||[]).length,1);
    for(const panel of output.matchAll(/<section[^>]*class="stage-center[^>]*>[\s\S]*?<\/section>/g))assert.doesNotMatch(panel[0],/skip-comparison/);
  }
  const voted=await renderScreen(v=>{v.inRoom.value=true;v.role.value='PLAYER';v.playerId.value='A';v.presentation.value='compare';Object.assign(v.state,{...base,comparisonSkipVotes:['A']});});
  assert.match(voted,/已选择跳过/);assert.match(voted,/1\/2/);
  for(const [role,stage] of [['SPECTATOR','compare'],['PLAYER','summary'],['PLAYER','table']]){
    const output=await renderScreen(v=>{v.inRoom.value=true;v.role.value=role;v.presentation.value=stage;Object.assign(v.state,base);});
    assert.doesNotMatch(output,/class="skip-comparison"/);
  }
});
