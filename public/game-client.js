/* A single presentation layer owns the table. Server snapshots remain authoritative. */
(() => {
  'use strict';
  const { createApp, ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } = Vue;
  const Art = window.TabletopArt;
  const Highlights = window.HandHighlights;
  const COIN_PHASES = ['ROUND_1_COINS', 'ROUND_2_COINS', 'ROUND_3_COINS', 'ROUND_4_COINS'];
  const freshState = () => ({phase:'WAITING',players:[],spectators:[],communityCards:[],ownHoleCards:[],coinHistory:[],finalHands:[],result:null,hostId:null,options:{handCardCount:2,handUsageRule:'any',historyVisibility:'all'},successCount:0,failureCount:0,rematchConfirmed:[],comparisonSkip:false,comparisonSkipVotes:[]});
  const saved = (() => { try { return JSON.parse(localStorage.getItem('poker.preferences.v2') || '{}'); } catch { return {}; } })();
  const app = createApp({setup() {
    const inRoom=ref(false), panel=ref(null), ruleStep=ref(0), roomId=ref(''), playerId=ref(''), role=ref('PLAYER');
    const name=ref(saved.name || ''), joinCode=ref(''), joinRole=ref('PLAYER');
    const connected=ref(false), pending=ref(false), busy=ref(false), scale=ref(1), fullscreen=ref(false);
    const state=reactive(freshState()), presentation=ref('idle'), revealIndex=ref(0), selectionLit=ref(false), compareIndex=ref(0), verdictVisible=ref(false), summaryIndex=ref(0);
    const completedComparisonCount=ref(0), comparisonHover=ref(null), comparisonFocus=ref(null), comparisonPinned=ref(null);
    const notice=ref(''), noticeError=ref(false);
    const prefs=reactive({sound:saved.sound===true,reducedMotion:saved.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches,pace:saved.pace==='standard'?'standard':'relaxed'});
    const roomSettings=reactive({handCardCount:2,handUsageRule:'any',historyVisibility:'all',spectatorSlots:2});
    let socket=null, socketSerial=0, queue=Promise.resolve(), generation=0, noticeTimer, pendingTimer, audioContext;
    let lastResultKey='', activeFlights=new Set(), focusBeforePanel=null, detailCloseTimer;
    const isHost=computed(()=>state.hostId===playerId.value);
    const isResult=computed(()=>Boolean(state.result));
    const displayedSuccessCount=computed(()=>Math.max(0,state.successCount-(state.result?.success&&presentation.value!=='summary'?1:0)));
    const displayedFailureCount=computed(()=>Math.max(0,state.failureCount-(state.result&&!state.result.success&&presentation.value!=='summary'?1:0)));
    const handCount=computed(()=>state.options?.handCardCount || 2);
    const opponents=computed(()=>state.players.filter(p=>p.id!==playerId.value));
    const myCoin=computed(()=>state.players.find(p=>p.id===playerId.value)?.currentCoin ?? null);
    const availableCoins=computed(()=>state.phase==='WAITING'?[]:Array.from({length:state.players.length},(_,i)=>i+1).filter(n=>!state.players.some(p=>p.currentCoin===n)));
    const canAct=computed(()=>connected.value&&role.value==='PLAYER'&&!pending.value&&!busy.value&&COIN_PHASES.includes(state.phase));
    const canTakeCoin=computed(()=>canAct.value&&myCoin.value===null);
    const canSkipComparison=computed(()=>role.value==='PLAYER'&&presentation.value==='compare'&&Boolean(state.result)&&!state.comparisonSkip);
    const hasSkippedComparison=computed(()=>state.comparisonSkipVotes.includes(playerId.value));
    const confirmed=computed(()=>state.rematchConfirmed.includes(playerId.value));
    const communitySlots=computed(()=>Array.from({length:5},(_,i)=>state.communityCards[i] || null));
    const phases=['发牌','翻牌','转牌','河牌','揭示'];
    const phaseIndex=computed(()=>isResult.value?4:COIN_PHASES.indexOf(state.phase));
    const sortedFinalHands=computed(()=>[...state.finalHands].sort((a,b)=>b.coin-a.coin));
    const revealEntry=computed(()=>sortedFinalHands.value[revealIndex.value]);
    const comparison=computed(()=>state.result?.comparisons[compareIndex.value]);
    const compareEntries=computed(()=>comparison.value?[comparison.value.higherPlayerId,comparison.value.lowerPlayerId].map(id=>state.finalHands.find(p=>p.playerId===id)).filter(Boolean):[]);
    const comparisonSymbol=computed(()=>comparison.value?.comparison===0?'=':comparison.value?.comparison<0?'＜':'＞');
    const summaryEntry=computed(()=>sortedFinalHands.value[summaryIndex.value] || sortedFinalHands.value[0]);
    const comparisonSteps=computed(()=>(state.result?.comparisons || []).map((item,index)=>({
      ...item,index,
      completed:presentation.value==='summary'||index<completedComparisonCount.value,
      active:presentation.value==='compare'&&index===compareIndex.value,
      entries:[item.higherPlayerId,item.lowerPlayerId].map(id=>state.finalHands.find(entry=>entry.playerId===id)).filter(Boolean),
      symbol:item.comparison===0?'＝':item.comparison<0?'＜':'＞',
      resultLabel:item.comparison===0?'平局 · 顺序正确':item.passed?'由弱到强 · 顺序正确':'后一位牌力更弱 · 顺序错误'
    })));
    const inspectedComparison=computed(()=>{
      const index=comparisonHover.value ?? comparisonFocus.value ?? comparisonPinned.value;
      return index===null?null:comparisonSteps.value.find(step=>step.index===index&&step.completed) || null;
    });
    const comparisonDetail=computed(()=>inspectedComparison.value&&window.SettlementDetails?window.SettlementDetails.describe(inspectedComparison.value,state.finalHands):null);
    const activeSettlementPlayers=computed(()=>presentation.value==='select'&&revealEntry.value?[revealEntry.value.playerId]:presentation.value==='compare'&&comparison.value?[comparison.value.higherPlayerId,comparison.value.lowerPlayerId]:[]);
    function toggleComparisonDetail(index){if(comparisonPinned.value===index){closeComparisonDetail();return;}comparisonPinned.value=index;}
    function hoverComparison(index){clearTimeout(detailCloseTimer);comparisonHover.value=index;}
    function keepComparisonDetail(){clearTimeout(detailCloseTimer);}
    function leaveComparisonDetail(){clearTimeout(detailCloseTimer);detailCloseTimer=setTimeout(()=>{comparisonHover.value=null;},350);}
    function closeComparisonDetail(){clearTimeout(detailCloseTimer);comparisonHover.value=null;comparisonFocus.value=null;comparisonPinned.value=null;}
    const historyLabel=computed(()=>({all:'历史公开',self:'历史仅自己可见',none:'隐藏历史'})[state.options?.historyVisibility]);
    const panelTitle=computed(()=>({create:'创建房间',join:'加入房间',rules:'玩法手册',settings:'游戏设置','room-settings':'下一场规则',leave:'离开牌桌'})[panel.value]);
    const heroCards=[{rank:13,suit:'c'},{rank:14,suit:'h'},{rank:12,suit:'s'}];
    const rulePages=[
      {title:'游戏目标',topic:'目标',intro:'这是一款 2–5 人的合作游戏。每位玩家根据自己的手牌和公共牌，判断自己的牌力在全桌的排名。',items:[
        '使用标准 52 张扑克牌，不含大小王。手牌只对本人可见，公共牌所有人共用。',
        '有几名玩家，就有几枚硬币：1 号代表最强，2 号代表第二强，依此类推。观战者不占用硬币。',
        '没有下注或筹码输赢。全体玩家共同挑战：累计成功 3 局获胜，累计失败 3 局结束，不要求连续。'
      ],note:'一局包括四轮选币和一次最终结算；一场游戏可以包含多局。'},
      {title:'一局如何进行',topic:'流程',intro:'开局先发手牌，再摆出五张盖住的公共牌。公共牌按 3、1、1 张翻开，共有四轮选币。',table:{head:['阶段','可见牌','本轮操作'],rows:[
        ['发牌','每人 2 或 3 张手牌；公共牌全盖住','判断牌力，选硬币'],
        ['翻牌','翻开前 3 张公共牌','重新选硬币'],
        ['转牌','再翻开第 4 张公共牌','重新选硬币'],
        ['河牌','翻开第 5 张公共牌','选出最终排名硬币'],
        ['揭示与结算','依次展示玩家手牌与最大五张牌','按最后一轮硬币比较']
      ]},items:['每轮硬币分完后自动进入下一阶段。进入下一轮时硬币回到公共区，上一轮选择锁定。','前三轮的选择只是参考，只有河牌这一轮的硬币参与结算。'],note:'当前没有选币倒计时。发牌阶段不足五张牌，还不能组成完整牌型。'},
      {title:'拿取、归还与抢夺',topic:'硬币',intro:'每名玩家同时最多持有一枚硬币。硬币数字始终表示预测的排名。',table:{head:['点击的位置','会发生什么'],rows:[
        ['公共区硬币','你没有硬币时，可以拿到自己面前'],
        ['自己的硬币','归还到公共区，之后可以重新选'],
        ['其他玩家的硬币','抢到自己面前，对方变为未持币状态']
      ]},items:['已持币时不能直接点击公共区的另一枚来替换；其他公共硬币仍然可见。','已持币时抢夺别人的硬币，你原先的硬币会自动归还公共区。','同时争抢按服务器收到操作的先后顺序处理。每次操作以所有人同步后的归属为准。'],note:'所有玩家各持一枚、公共区为空时，本轮立即锁定。动画结束后进入下一阶段，不能再改上一轮的选择。'},
      {title:'如何组成最大牌组',topic:'组牌',intro:'系统按房间设置自动选出最大的五张牌，不需要玩家手动挑牌。房主可以设置 2 张或 3 张手牌，以及以下两种组牌方式。',items:[
        '任意组牌：从自己的手牌和已翻开的公共牌中任选五张。可以只用部分手牌，也可以完全不用手牌。',
        '手牌全部使用：2 张手牌必须再搭配 3 张公共牌；3 张手牌必须再搭配 2 张公共牌。系统只在符合条件的组合中选最大值。',
        '翻牌后，自己的牌区会出现“!”提示，可查看当前可见牌能组成的最大牌型。后续公共牌还可能改变它。'
      ],note:'例如，公共牌本身构成最佳五张牌时，“任意组牌”允许直接使用；“手牌全部使用”仍必须带上全部手牌。'},
      {title:'牌型与点数大小',topic:'牌型',intro:'先比较牌型，再比较组成牌的点数。下表由强到弱排列。',table:{head:['牌型','组成'],rows:[
        ['同花顺','五张同花色且连续；10、J、Q、K、A 为皇家同花顺'],['四条','四张同点数'],['葫芦','三张同点数，加一对'],['同花','五张同花色，不要求连续'],['顺子','五张连续点数，不要求同花色'],['三条','三张同点数'],['两对','两组不同点数的对子'],['一对','两张同点数'],['高牌','不构成以上牌型']
      ]},items:['通常 A 最大，接着是 K、Q、J、10…2。A 也可以组成 A–2–3–4–5，此时按 5 点顺子算；Q–K–A–2–3 不算顺子。','顺子、同花顺比较最高一张的点数；同花、高牌按五张牌点数从大到小逐张比较。','一对先比对子，两对先比大对再比小对。三条、四条先比相同点数的那组牌；以上仍相同时，再从大到小比较剩余牌（踢脚牌）。葫芦先比三条，再比对子。','花色不分高低。所有用于比较的点数都相同，算平局。'],note:'例如：双方都是一对 K，剩余牌分别为 A、9、3 和 Q、J、8，则带 A 的一方更大。'},
      {title:'最终顺序如何判定',topic:'结算',intro:'按硬币从大到小依次揭示。后出现的牌组必须比前一位更大或相等，才算顺序正确。',example:true,items:[
        '例如三人局：3 号高牌、2 号一对、1 号两对。先比较 3 与 2，再比较 2 与 1，两个比较都通过，本局成功。',
        '如果 2 号是一对，而 1 号是高牌，最后一步变弱，本局失败。',
        '平局通过；不要求每个人都严格大于前一位。N 名玩家共比较 N−1 次，即使前面失败也会比完全部相邻组合。'
      ],note:'一局只计一次成功或失败，不会因多处顺序错误而扣多次。揭示中会高亮系统选中的五张牌，再展示比较结果。'},
      {title:'下一局与房间设置',topic:'房间',intro:'普通结算后，全体玩家选择“下一局”才重新发牌，成功和失败次数继续累计。',items:[
        '累计三胜或三负后，整场结束。全员选择“再来一场”会将成功、失败计数归零。观战者不参与确认。',
        '历史硬币显示每个已完成轮次锁定的选择。房主可设为所有人可见、仅本人可见、全部隐藏；历史选择不能修改，也不计入结算。',
        '观战者只能查看公共信息；在最终揭示前不能看到玩家手牌，也不能拿取或抢夺硬币。',
        '当前版本中，开局后的玩家主动离开或掉线会结束房间，其他人返回主菜单。观战者离开不影响牌局。'
      ],note:'个人设置里的音效、减少动态效果和演出速度只影响自己的观看体验，不改变游戏规则。'}
    ];
    const cardKey=c=>`${c.rank}-${c.suit}`;
    const isChosen=(entry,card)=>entry.hand.cards.some(c=>cardKey(c)===cardKey(card));
    const cardHighlight=(hand,card)=>hand&&card&&Highlights?Highlights.getHighlights(hand).find(item=>item.card.rank===card.rank&&item.card.suit===card.suit):null;
    const timings=()=>prefs.pace==='relaxed'?{select:3000,compare:5600,gap:1000,hold:1700}:{select:2300,compare:4300,gap:800,hold:1200};
    const skipRequested=ref(false), skipWaiters=new Set();
    const sleep=ms=>{if(skipRequested.value){skipRequested.value=false;return Promise.resolve();}return new Promise(resolve=>{let timer;const finish=()=>{skipWaiters.delete(finish);clearTimeout(timer);resolve();};skipWaiters.add(finish);timer=setTimeout(finish,ms);});};
    const live=epoch=>epoch===generation && inRoom.value;
    function notify(text,error=false){clearTimeout(noticeTimer);notice.value=text;noticeError.value=error;noticeTimer=setTimeout(()=>notice.value='',5000);}
    function unlock(){pending.value=false;clearTimeout(pendingTimer);}
    function tone(kind='coin') {
      if(!prefs.sound)return;
      try {
        audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
        if(audioContext.state==='suspended')audioContext.resume();
        const t=audioContext.currentTime, oscillator=audioContext.createOscillator(), gain=audioContext.createGain();
        oscillator.type=kind==='card'?'sine':'triangle';oscillator.frequency.setValueAtTime(kind==='coin'?900:kind==='win'?660:350,t);
        oscillator.frequency.exponentialRampToValueAtTime(kind==='win'?880:240,t+.18);
        gain.gain.setValueAtTime(.035,t);gain.gain.exponentialRampToValueAtTime(.001,t+.24);
        oscillator.connect(gain).connect(audioContext.destination);oscillator.start(t);oscillator.stop(t+.25);
      } catch { /* Unsupported audio must never block game input. */ }
    }
    function previewSound(){tone('coin');}
    function openPanel(which){focusBeforePanel=document.activeElement;panel.value=which;notice.value='';if(which==='rules')ruleStep.value=0;nextTick(()=>document.querySelector('.modal input,.modal .modal-close')?.focus());tone('card');}
    function prepareRoomSettings(){if(!isHost.value||state.phase!=='GAME_OVER')return;Object.assign(roomSettings,state.options||{});openPanel('room-settings');}
    function saveRoomSettings(){if(!isHost.value||state.phase!=='GAME_OVER')return;command('UPDATE_ROOM_OPTIONS',{options:{...roomSettings}});panel.value=null;}
    function closePanel(){if(pending.value&&!inRoom.value)return;panel.value=null;nextTick(()=>focusBeforePanel?.focus?.());}
    function goRulePage(index){
      ruleStep.value=Math.max(0,Math.min(rulePages.length-1,index));
      nextTick(()=>{const body=document.querySelector('.rule-body');if(body)body.scrollTop=0;});
    }
    function ruleKey(event){
      if(panel.value!=='rules'||event.altKey||event.ctrlKey||event.metaKey)return;
      if(['ArrowLeft','ArrowUp','PageUp','ArrowRight','ArrowDown','PageDown'].includes(event.key)){
        event.preventDefault();goRulePage(ruleStep.value+(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)?-1:1));
      }
    }
    function trapFocus(event){if(event.key==='Escape'&&inspectedComparison.value){event.preventDefault();closeComparisonDetail();return;}if(!panel.value||event.key!=='Tab')return;const elements=[...document.querySelectorAll('.modal button:not(:disabled),.modal input,.modal select')];const first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
    function resize(){scale.value=Math.min((window.innerWidth-12)/1200,(window.innerHeight-12)/760);fullscreen.value=Boolean(document.fullscreenElement);}
    async function toggleFullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();resize();}catch{notify('当前浏览器不支持全屏',true);}}
    function copyRoomLegacy(text){
      // HTTP origins do not expose Clipboard API. Keep this path synchronous
      // so the original click still grants permission for the copy operation.
      const focused=document.activeElement;
      const selection=window.getSelection?.();
      const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
      const inputSelection=focused&&typeof focused.selectionStart==='number'
        ? [focused.selectionStart,focused.selectionEnd,focused.selectionDirection] : null;
      const field=document.createElement('textarea');
      field.value=text;field.readOnly=true;field.tabIndex=-1;
      field.style.cssText='position:fixed;left:-9999px;top:0;width:1px;height:1px;font-size:16px;';
      try {
        document.body.appendChild(field);
        field.focus({preventScroll:true});field.select();field.setSelectionRange(0,text.length);
        return typeof document.execCommand==='function'&&document.execCommand('copy')===true;
      } catch { return false; }
      finally {
        field.remove();
        try {
          focused?.focus?.({preventScroll:true});
          if(inputSelection)focused.setSelectionRange(...inputSelection);
          else if(selection){selection.removeAllRanges();ranges.forEach(range=>selection.addRange(range));}
        } catch { /* Focus restoration is best effort and cannot undo a copy. */ }
      }
    }
    async function copyRoom(){
      const code=roomId.value;
      if(!code)return;
      let copied=false;
      if(window.isSecureContext&&typeof navigator.clipboard?.writeText==='function'){
        try {await navigator.clipboard.writeText(code);copied=true;}catch{/* Try the click-based fallback below. */}
      }
      if(!copied)copied=copyRoomLegacy(code);
      if(copied)notify('房间号已复制');
      else notify(`无法自动复制，请手动复制房间号：${code}`,true);
    }
    function resetRoom(text=''){
      completedComparisonCount.value=0;closeComparisonDetail();
      generation++;activeFlights.forEach(el=>el.remove());activeFlights.clear();unlock();busy.value=false;inRoom.value=false;panel.value=null;presentation.value='idle';lastResultKey='';queue=Promise.resolve();Object.assign(state,freshState());roomId.value='';
      if(socket){socket.onclose=null;socket.close();socket=null;}connected.value=false;
      if(text)notify(text);
    }
    function command(type,extra={}) {
      if(pending.value)return;
      if(!socket||socket.readyState!==WebSocket.OPEN){notify('连接已断开，请返回主菜单重新入座',true);return;}
      pending.value=true;pendingTimer=setTimeout(()=>{unlock();notify('操作等待超时，请检查连接',true);},8000);
      socket.send(JSON.stringify({type,roomId:roomId.value,...extra}));
    }
    function connectAndSend(payload){
      if(pending.value)return;
      const nickname=name.value.trim();if(!nickname){notify('请先取一个昵称',true);return;}
      playerId.value=nickname;role.value=payload.role || 'PLAYER';pending.value=true;const serial=++socketSerial;
      if(socket){socket.onclose=null;socket.close();}
      const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}`);socket=ws;
      pendingTimer=setTimeout(()=>{unlock();ws.close();notify('连接超时，请稍后再试',true);},8000);
      ws.onopen=()=>{if(serial!==socketSerial)return;connected.value=true;ws.send(JSON.stringify({...payload,playerId:nickname}));};
      ws.onmessage=event=>{
        if(serial!==socketSerial)return;
        let msg;try{msg=JSON.parse(event.data);}catch{return;}
        if(msg.type==='ERROR'){unlock();notify(translateError(msg.message),true);return;}
        if(msg.type==='ROOM_LEFT'||msg.type==='ROOM_ENDED'){resetRoom(msg.reason==='PLAYER_DISCONNECTED'?'有玩家断开连接，这桌已结束':'已回到主菜单');return;}
        if(msg.state){if(msg.state.comparisonSkip){skipRequested.value=true;for(const finish of [...skipWaiters])finish();}if(!inRoom.value){inRoom.value=true;panel.value=null;}roomId.value=msg.state.roomId || msg.roomId;const epoch=generation;queue=queue.then(()=>present(msg,epoch)).catch(error=>{busy.value=false;unlock();notify('牌桌更新遇到问题，请重新入座',true);console.error(error);});}
      };
      ws.onerror=()=>{unlock();notify('暂时连接不上牌桌，请稍后重试',true);};
      ws.onclose=()=>{if(serial!==socketSerial)return;connected.value=false;unlock();if(inRoom.value)notify('连接已断开，可从右上角返回主菜单',true);};
    }
    function translateError(text){return ({'Room not found':'没有找到这个房间，请核对房间号','Game already started':'这桌已开局，可以选择观战','Spectator positions are full':'观战席已满','Player positions are full':'这桌已经坐满了，可以选择观战','Player already owns a coin':'先归还自己的硬币，再取公共硬币','Only host can start':'等待房主开始','At least two players are required':'还需要一位朋友入座','Player name is already in use':'这个昵称已被使用，请换一个','Coin selection is closed':'这一轮已经结束，请等待下一阶段','Invalid source player':'这枚硬币刚被拿走，请重新选择'})[text] || (/[\u4e00-\u9fff]/.test(text)?text:'操作未完成，请检查当前牌局状态。');}
    function createRoom(){tone('card');connectAndSend({type:'CREATE_ROOM',options:{...roomSettings}});}
    function joinRoom(){const code=joinCode.value.trim().toUpperCase();if(!/^[A-F0-9]{6}$/.test(code)){notify('请输入六位房间号',true);return;}tone('card');connectAndSend({type:'JOIN_ROOM',roomId:code,role:joinRole.value});}
    function requestLeave(){openPanel('leave');}
    function leaveRoom(){if(!connected.value){resetRoom();return;}command('LEAVE_ROOM');}
    function takeCoin(coin){if(canTakeCoin.value)command('MOVE_COIN',{coin});}
    function returnCoin(coin){if(canAct.value)command('RETURN_COIN',{coin});}
    function stealCoin(coin,id){if(canAct.value)command('MOVE_COIN',{coin,fromPlayerId:id});}
    function captureCoins(){const map=new Map();document.querySelectorAll('[data-live-coin]').forEach(el=>map.set(Number(el.dataset.liveCoin),el.getBoundingClientRect()));return map;}
    async function animateMoves(before,epoch){
      await nextTick();if(!live(epoch)||prefs.reducedMotion)return;
      const animations=[];
      for(const el of document.querySelectorAll('[data-live-coin]')){
        const coin=Number(el.dataset.liveCoin),from=before.get(coin),to=el.getBoundingClientRect();
        if(!from||Math.hypot(from.x-to.x,from.y-to.y)<5)continue;
        const chip=document.createElement('img');chip.className='coin-flight';chip.src=Art.coinImage(coin);chip.alt='';chip.style.cssText=`left:${from.x}px;top:${from.y}px;width:${from.width}px;height:${from.height}px`;
        document.body.appendChild(chip);activeFlights.add(chip);el.classList.add('flight-hidden');
        const dx=to.x-from.x,dy=to.y-from.y,s=to.width/from.width;
        const anim=chip.animate([{transform:'translate(0,0) scale(1)'},{transform:`translate(${dx*.48}px,${dy*.48-35}px) scale(1.08)`,offset:.5},{transform:`translate(${dx}px,${dy}px) scale(${s})`}],{duration:900,easing:'cubic-bezier(.2,.65,.3,1)',fill:'forwards'});
        animations.push(anim.finished.catch(()=>{}).then(()=>{chip.remove();activeFlights.delete(chip);el.classList.remove('flight-hidden');el.classList.add('land');setTimeout(()=>el.classList.remove('land'),550);}));
      }
      await Promise.all(animations);
    }
    async function present(msg,epoch){
      if(!live(epoch))return;
      const next=msg.state,oldPhase=state.phase,stageChange=oldPhase!==next.phase;
      const before=captureCoins();busy.value=true;
      // The final coin must reach its player before a reset/reveal replaces the table.
      if(msg.coinAction&&stageChange&&COIN_PHASES.includes(oldPhase)){
        const action=msg.coinAction;
        state.players=state.players.map(p=>({...p,currentCoin:p.id===action.toPlayerId?action.coin:p.currentCoin===action.coin?null:p.currentCoin}));
        await animateMoves(before,epoch);tone('coin');await sleep(timings().hold);if(!live(epoch))return;
      }
      const newHand=next.phase==='ROUND_1_COINS'&&oldPhase!==next.phase;
      Object.assign(state,next);unlock();
      if(!next.result){lastResultKey='';summaryIndex.value=0;completedComparisonCount.value=0;closeComparisonDetail();}
      if(newHand){presentation.value='deal';await nextTick();tone('card');await sleep(prefs.reducedMotion?300:1600);}
      else if(msg.coinAction&&!stageChange){await animateMoves(before,epoch);tone('coin');}
      else if(stageChange&&!next.result&&COIN_PHASES.includes(next.phase)){tone('card');await sleep(prefs.reducedMotion?300:1450);}
      if(!live(epoch))return;
      if(next.result){
        const key=JSON.stringify([next.successCount,next.failureCount,next.finalHands,next.result]);
        if(key!==lastResultKey){lastResultKey=key;await playReveal(epoch);}
      } else presentation.value='idle';
      if(live(epoch))busy.value=false;
    }
    async function playReveal(epoch){
      completedComparisonCount.value=0;closeComparisonDetail();
      presentation.value='hold';await sleep(650);if(!live(epoch))return;
      for(let i=0;i<sortedFinalHands.value.length;i++){
        revealIndex.value=i;selectionLit.value=false;presentation.value='select';tone('card');await sleep(800);if(!live(epoch))return;
        selectionLit.value=true;await sleep(timings().select-800);if(!live(epoch))return;
        presentation.value='gap';await sleep(500);if(!live(epoch))return;
      }
      for(let i=0;i<(state.result?.comparisons.length || 0);i++){
        if(state.comparisonSkip){completedComparisonCount.value=state.result.comparisons.length;presentation.value='summary';break;}
        compareIndex.value=i;verdictVisible.value=false;presentation.value='compare';await sleep(1700);if(!live(epoch))return;
        if(state.comparisonSkip){completedComparisonCount.value=state.result.comparisons.length;presentation.value='summary';break;}
        verdictVisible.value=true;tone(comparison.value.passed?'win':'card');await sleep(timings().compare-1700);if(!live(epoch))return;
        completedComparisonCount.value=i+1;
        presentation.value='gap';await sleep(timings().gap);if(!live(epoch))return;
      }
      presentation.value='summary';tone(state.result?.success?'win':'card');
    }
    async function replayReveal(){if(busy.value)return;busy.value=true;const epoch=generation;await playReveal(epoch);if(live(epoch))busy.value=false;}
    watch([prefs,name],()=>{try{localStorage.setItem('poker.preferences.v2',JSON.stringify({...prefs,name:name.value}));}catch{}},{deep:true});
    onMounted(()=>{resize();window.addEventListener('resize',resize);document.addEventListener('fullscreenchange',resize);document.addEventListener('keydown',trapFocus);document.getElementById('boot-status').hidden=true;});
    onBeforeUnmount(()=>{resetRoom();window.removeEventListener('resize',resize);document.removeEventListener('keydown',trapFocus);document.removeEventListener('fullscreenchange',resize);});
  return {inRoom,panel,panelTitle,ruleStep,rulePages,goRulePage,ruleKey,prefs,roomSettings,name,joinCode,joinRole,playerId,role,roomId,connected,pending,busy,fullscreen,state,scale,presentation,revealIndex,selectionLit,revealEntry,compareIndex,comparison,compareEntries,comparisonSymbol,verdictVisible,summaryIndex,summaryEntry,sortedFinalHands,comparisonSteps,completedComparisonCount,inspectedComparison,comparisonDetail,activeSettlementPlayers,comparisonHover,comparisonFocus,comparisonPinned,toggleComparisonDetail,hoverComparison,keepComparisonDetail,leaveComparisonDetail,closeComparisonDetail,displayedSuccessCount,displayedFailureCount,canSkipComparison,hasSkippedComparison,opponents,myCoin,canAct,canTakeCoin,availableCoins,communitySlots,handCount,historyLabel,confirmed,isHost,isResult,phases,phaseIndex,notice,noticeError,heroCards,openPanel,prepareRoomSettings,saveRoomSettings,closePanel,previewSound,toggleFullscreen,copyRoom,createRoom,joinRoom,command,requestLeave,leaveRoom,takeCoin,returnCoin,stealCoin,replayReveal,isChosen,cardHighlight,...Art};
  }});
  app.component('playing-card',{props:['card','highlight'],template:`<span class="playing-card" :class="['playing-card',cardClasses]" :aria-label="card?art.cardText(card):'牌背'"><span class="flip-inner"><span class="card-back"><img :src="art.cardBack" alt=""></span><span class="card-front"><img v-if="card" :src="art.cardImage(card)" :alt="art.cardText(card)"></span></span></span>`,setup(props){const cardClasses=computed(()=>({ 'is-face':Boolean(props.card), 'hand-highlight':Boolean(props.highlight?.meta?.primary), 'hand-kicker':Boolean(props.highlight?.meta?.kicker), ['highlight-'+(props.highlight?.meta?.role||'none')]:Boolean(props.highlight) }));return {art:Art,cardClasses};}});
  app.config.errorHandler=error=>{console.error(error);const boot=document.getElementById('boot-status');if(boot&&!boot.hidden)boot.textContent='牌桌未能加载，请刷新页面。';};
  app.mount('#app');
})();
