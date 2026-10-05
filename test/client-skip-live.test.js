const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Vue = require('vue');

const script = fs.readFileSync(path.join(__dirname, '../public/game-client.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

function settlement() {
  const cards = [{rank:14,suit:'s'},{rank:13,suit:'h'},{rank:11,suit:'d'},{rank:9,suit:'c'},{rank:7,suit:'s'}];
  const finalHands = ['A','B','C','D'].map((playerId, index) => ({
    playerId, coin:4-index, holeCards:cards.slice(0,2),
    hand:{category:0,categoryName:'高牌',tiebreak:[14,13,11,9,7],cards}
  }));
  return {
    roomId:'ABC123',phase:'SETTLEMENT',hostId:'A',successCount:1,failureCount:0,
    players:finalHands.map(entry=>({id:entry.playerId,currentCoin:entry.coin,coinHistory:[entry.coin,entry.coin,entry.coin,entry.coin]})),
    spectators:[],ownHoleCards:cards.slice(0,2),communityCards:cards,finalHands,
    comparisonSkip:false,comparisonSkipVotes:[],rematchConfirmed:[],
    result:{success:true,comparisons:finalHands.slice(0,-1).map((entry,i)=>({
      higherCoin:entry.coin,lowerCoin:finalHands[i+1].coin,higherPlayerId:entry.playerId,lowerPlayerId:finalHands[i+1].playerId,comparison:0,passed:true
    }))}
  };
}

async function client() {
  let view, socket, now = 0, nextId = 0;
  const timers = new Map(), sent = [], errors = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send(raw) { sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, {at:now+ms,fn}); return id; };
  const clearTimeout = id => timers.delete(id);
  vm.runInNewContext(script, {
    Vue:{...Vue,onMounted(){},onBeforeUnmount(){},createApp(options){
      view = options.setup();
      return {component(){},config:{},mount(){}};
    }},
    window:{TabletopArt:{},matchMedia:()=>({matches:false})},
    document:{querySelectorAll:()=>[],querySelector:()=>null},
    location:{protocol:'http:',host:'localhost'},WebSocket:FakeWebSocket,
    localStorage:{getItem:()=>null,setItem(){}},setTimeout,clearTimeout,
    console:{error:error=>errors.push(error)}
  });
  const receive = snapshot => socket.onmessage({data:JSON.stringify({type:'ROOM_STATE',state:snapshot})});
  async function advance(ms) {
    const target = now+ms;
    for(let guard=0;guard<1000;guard++) {
      const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
      if(!first||first[1].at>target)break;
      timers.delete(first[0]);now=first[1].at;first[1].fn();await flush();
    }
    now=target;await flush();
  }
  async function until(condition) {
    for(let guard=0;guard<100&&!condition();guard++) {
      const first=[...timers.values()].sort((a,b)=>a.at-b.at)[0];
      assert.ok(first,'presentation should have a pending timer');
      await advance(first.at-now);
    }
    assert.ok(condition(),'presentation should reach the requested stage');
    assert.deepEqual(errors,[]);
  }
  view.name.value='A';view.joinCode.value='ABC123';view.joinRoom();socket.onopen();
  receive({...settlement(),phase:'WAITING',result:null,finalHands:[],successCount:0});await flush();
  return {view,receive,advance,until,sent,now:()=>now,errors};
}

test('live four-player skip votes show 0→1→2→3→4 during playback and skip all remaining comparisons', async () => {
  const c=await client(), round=settlement(), counts=[];
  const stop=Vue.watch(()=>c.view.state.comparisonSkipVotes.length,count=>counts.push(count),{flush:'sync'});
  c.receive(round);await flush();
  await c.until(()=>c.view.presentation.value==='compare');
  assert.equal(c.view.compareIndex.value,0);
  assert.equal(c.view.showSkipComparison.value,true);
  assert.equal(c.view.canSkipComparison.value,true);
  c.view.requestComparisonSkip();
  assert.equal(c.sent.at(-1).type,'SKIP_COMPARISON');
  assert.equal(c.view.pending.value,true);
  const at=c.now();
  for(let count=1;count<=4;count++) {
    c.receive({...round,comparisonSkipVotes:['A','B','C','D'].slice(0,count),comparisonSkip:count===4});
    assert.equal(c.view.state.comparisonSkipVotes.length,count,'vote count updates synchronously on each WebSocket message');
    assert.equal(c.view.pending.value,false,'own vote acknowledgement releases the pending operation immediately');
    assert.equal(c.view.hasSkippedComparison.value,true);
    assert.equal(c.view.canSkipComparison.value,false);
    if(count<4)assert.equal(c.view.presentation.value,'compare');
  }
  await flush();
  assert.equal(c.now(),at,'unanimous votes finish comparison playback without another animation timer');
  assert.equal(c.view.presentation.value,'summary');
  assert.equal(c.view.completedComparisonCount.value,3);
  assert.equal(c.view.busy.value,false);
  assert.equal(c.view.showSkipComparison.value,false);
  assert.deepEqual(counts,[1,2,3,4],'queued snapshots must never roll live vote progress backwards');
  stop();
  c.view.showFinalTable();assert.equal(c.view.displayedSuccessCount.value,1);
  c.view.showSettlementSummary();assert.equal(c.view.displayedSuccessCount.value,1);
  await c.advance(10000);assert.equal(c.view.notice.value,'','acknowledged vote must not later report a timeout');
  assert.deepEqual(c.errors,[]);
});

test('unanimous votes during hand selection preserve all selection timings and cannot leak into the next round', async () => {
  const c=await client(), round=settlement(), selected=[];
  const stop=Vue.watch(()=>[c.view.presentation.value,c.view.revealIndex.value],([stage,index])=>{
    if(stage==='select'&&!selected.includes(index))selected.push(index);
  },{flush:'sync'});
  c.receive(round);await flush();await c.advance(1450);
  assert.equal(c.view.presentation.value,'select');assert.equal(c.view.selectionLit.value,true);
  assert.equal(c.view.showSkipComparison.value,true);
  c.view.requestComparisonSkip();
  const voted={...round,comparisonSkip:true,comparisonSkipVotes:['A','B','C','D']};
  c.receive(voted);await flush();
  assert.equal(c.view.pending.value,false);assert.equal(c.view.state.comparisonSkipVotes.length,4);
  await c.advance(2199);assert.equal(c.view.presentation.value,'select','full votes must not shorten hand selection');
  await c.advance(1);assert.equal(c.view.presentation.value,'gap');
  await c.until(()=>c.view.presentation.value==='summary');
  assert.deepEqual(selected,[0,1,2,3]);
  assert.equal(c.now(),650+4*(3000+500),'every selection and its spacing plays for its complete duration');
  assert.equal(c.view.completedComparisonCount.value,3);stop();

  const next={...round,phase:'ROUND_1_COINS',result:null,finalHands:[],comparisonSkip:false,comparisonSkipVotes:[],communityCards:[],players:round.players.map(p=>({...p,currentCoin:null}))};
  c.receive(next);await flush();await c.advance(1600);
  assert.equal(c.view.presentation.value,'idle');
  c.receive(voted);await flush();
  assert.equal(c.view.state.phase,'ROUND_1_COINS','a late vote from the previous result cannot restore its settlement');
  assert.equal(c.view.state.comparisonSkip,false);assert.equal(c.view.state.comparisonSkipVotes.length,0);
  c.receive({...round,successCount:2});await flush();
  assert.equal(c.view.presentation.value,'hold');
  assert.equal(c.view.state.comparisonSkip,false);assert.equal(c.view.state.comparisonSkipVotes.length,0);
});

test('all-player skip also interrupts the gap between comparisons', async () => {
  const c=await client(), round=settlement();c.receive(round);await flush();
  await c.until(()=>c.view.presentation.value==='gap'&&c.view.completedComparisonCount.value===1);
  const at=c.now();
  assert.equal(c.view.showSkipComparison.value,true);
  c.receive({...round,comparisonSkip:true,comparisonSkipVotes:['A','B','C','D']});await flush();
  assert.equal(c.now(),at);assert.equal(c.view.presentation.value,'summary');
  assert.equal(c.view.completedComparisonCount.value,3);
  c.view.role.value='SPECTATOR';c.view.presentation.value='compare';
  assert.equal(c.view.showSkipComparison.value,false);assert.equal(c.view.canSkipComparison.value,false);
  const sent=c.sent.length;c.view.requestComparisonSkip();assert.equal(c.sent.length,sent);
});

test('reviewing the final table preserves the visible failure total', async () => {
  const c=await client();
  Object.assign(c.view.state,{result:{success:false,comparisons:[]},successCount:1,failureCount:2});
  c.view.presentation.value='summary';
  assert.equal(c.view.displayedSuccessCount.value,1);assert.equal(c.view.displayedFailureCount.value,2);
  c.view.showFinalTable();
  assert.equal(c.view.displayedSuccessCount.value,1);assert.equal(c.view.displayedFailureCount.value,2);
  c.view.showSettlementSummary();assert.equal(c.view.displayedFailureCount.value,2);
});
