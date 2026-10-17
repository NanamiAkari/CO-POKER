const test = require('node:test');
const assert = require('node:assert/strict');
const TomatoInteractions = require('../public/tomato-interactions');

function clock() {
  let now = 1000, serial = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++serial; tasks.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      const due = now + ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.due <= due).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due; tasks.delete(next[0]); next[1].fn();
      }
      now = due;
    }
  };
}

function fakeDom(anchors = {}) {
  const all = Object.values(anchors);
  const body = { children: [], appendChild(node) { node.parentNode = this; node.isConnected = true; this.children.push(node); }, removeChild(node) { this.children = this.children.filter(item => item !== node); node.parentNode = null; node.isConnected = false; } };
  function element(dataset = {}, rect = {left:0,top:0,width:40,height:40}) {
    const listeners = new Map();
    const node = {
      dataset, isConnected:true, parentNode:null, children:[], style:{values:{}, setProperty(key,value){this.values[key]=value;}},
      className:'', hidden:false, src:'', alt:'', draggable:false,
      attributes:{}, setAttribute(name,value){this.attributes[name]=value;},
      classList:{values:new Set(), add(...names){names.forEach(name=>this.values.add(name));},remove(...names){names.forEach(name=>this.values.delete(name));},contains(name){return this.values.has(name);}},
      appendChild(child){child.parentNode=this;child.isConnected=true;this.children.push(child);return child;},
      removeChild(child){this.children=this.children.filter(item=>item!==child);child.parentNode=null;child.isConnected=false;},
      addEventListener(type,fn){listeners.set(type,fn);}, removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);},
      getBoundingClientRect(){return {...rect,right:rect.left+rect.width,bottom:rect.top+rect.height};}
    };
    return node;
  }
  const doc = {
    body, defaultView:{innerWidth:1200,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),matchMedia:()=>({matches:false})},
    createElement(tag){return element({_tag:tag});},
    querySelectorAll(selector){
      if(selector==='[data-player]')return all.filter(node=>node.dataset.player);
      if(selector==='[data-owner-anchor]')return all.filter(node=>node.dataset.ownerAnchor);
      if(selector==='[data-spectator-anchor]')return all.filter(node=>node.dataset.spectatorAnchor);
      return [];
    }
  };
  return {doc, body, element};
}

test('sendTomato emits an independent TOMATO_THROW action', () => {
  const sent = [], timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, send: payload => sent.push(payload), setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  const action = controller.sendTomato('Bob');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'TOMATO_THROW');
  assert.equal(sent[0].roomId, 'ABC123');
  assert.deepEqual(sent[0].action, action);
  assert.equal(action.fromPlayerId, 'Alice');
  assert.equal(action.toPlayerId, 'Bob');
  assert.equal(controller.sendTomato('Alice'), false);
  assert.equal(controller.sendTomato(''), false);
});

test('sendTomato unwraps Vue-style ref getters', () => {
  const sent = [];
  const roomId = {}; Object.defineProperty(roomId, 'value', { get: () => 'REF123' });
  const playerId = {}; Object.defineProperty(playerId, 'value', { get: () => 'Alice' });
  const controller = TomatoInteractions.create({ roomId, playerId, send: payload => sent.push(payload) });
  assert.equal(controller.sendTomato('Bob').fromPlayerId, 'Alice');
  assert.equal(sent[0].roomId, 'REF123');
});

test('handleTomatoMessage validates room and deduplicates action ids', () => {
  const timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  const message = { type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-1', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 1000 } };
  assert.deepEqual(controller.handleTomatoMessage(message), message.action);
  assert.equal(controller.handleTomatoMessage(message), false);
  assert.equal(controller.handleTomatoMessage({ ...message, roomId: 'OTHER', action: { ...message.action, actionId: 'throw-2' } }), false);
  assert.deepEqual(controller.handleTomatoMessage({ ...message, action: { ...message.action, actionId: 'throw-3', fromPlayerId: 'Alice', toPlayerId: 'Bob' } }), { ...message.action, actionId: 'throw-3', fromPlayerId: 'Alice', toPlayerId: 'Bob' });
  assert.equal(controller.tomatoFlights.length, 2);
});

test('flights clean up after the flight and impact windows and reset cancels them', () => {
  const timer = clock();
  const controller = TomatoInteractions.create({ roomId: 'ABC123', playerId: 'Alice', now: timer.now, flightMs: 900, impactMs: 240, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  controller.handleTomatoMessage({ type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-1', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 1000 } });
  assert.equal(controller.tomatoFlights.length, 1);
  timer.advance(899);
  assert.equal(controller.tomatoFlights.length, 1);
  timer.advance(341);
  assert.equal(controller.tomatoFlights.length, 0);
  controller.handleTomatoMessage({ type: 'TOMATO_THROW', roomId: 'ABC123', action: { actionId: 'throw-2', fromPlayerId: 'Bob', toPlayerId: 'Alice', timestamp: 2200 } });
  controller.reset();
  assert.equal(controller.tomatoFlights.length, 0);
});

test('local SVG fruit is replaced by a splat and particles at impact, then the whole visual is removed', () => {
  const timer = clock();
  const dom = fakeDom({A: null, B: null});
  dom.doc.querySelectorAll = selector => {
    if(selector === '[data-player]') return [dom.source, dom.target].filter(Boolean);
    return [];
  };
  dom.source = dom.element({player:'Alice'}, {left:40,top:40,width:50,height:50});
  dom.target = dom.element({player:'Bob'}, {left:540,top:160,width:50,height:50});
  const controller = TomatoInteractions.create({roomId:'ABC123',playerId:'Alice',document:dom.doc,frame:dom.doc.defaultView,now:timer.now,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout,flightMs:100,impactMs:1000});
  controller.handleTomatoMessage({type:'TOMATO_THROW',roomId:'ABC123',action:{actionId:'throw-svg',fromPlayerId:'Alice',toPlayerId:'Bob',timestamp:1000}});
  assert.equal(dom.body.children.length,1);
  const visual = dom.body.children[0];
  assert.equal(visual.children[0].src,'/assets/tomato.svg');
  assert.match(visual.children[1].children[0].src,/tomato-splat\.svg$/);
  assert.equal(visual.children[1].children.filter(child=>child.className==='tomato-droplet').length,10);
  assert.equal(visual.children[1].children.filter(child=>child.className==='tomato-seed').length,5);
  timer.advance(160);
  assert.equal(visual.classList.contains('tomato-impact'),true);
  assert.equal(visual.children[0].hidden,true,'fruit is removed as soon as it hits');
  assert.equal(dom.target.classList.contains('tomato-hit'),true);
  timer.advance(999);
  assert.equal(dom.body.children.length,1,'splat remains visible during the readable hold');
  timer.advance(1);
  assert.equal(dom.body.children.length,0);
  assert.equal(controller.tomatoFlights.length,0);
});

test('multiple impacts share a target safely and reset removes every node and hit state', () => {
  const timer = clock();
  const dom = fakeDom();
  dom.source = dom.element({player:'Alice'}, {left:20,top:20,width:40,height:40});
  dom.other = dom.element({player:'Cara'}, {left:20,top:100,width:40,height:40});
  dom.target = dom.element({player:'Bob'}, {left:420,top:180,width:40,height:40});
  dom.doc.querySelectorAll = selector => selector === '[data-player]' ? [dom.source,dom.other,dom.target] : [];
  const controller = TomatoInteractions.create({roomId:'ABC123',playerId:'Alice',document:dom.doc,now:timer.now,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout,flightMs:0,impactMs:800});
  for(const [id,from] of [['one','Alice'],['two','Cara']])controller.handleTomatoMessage({type:'TOMATO_THROW',roomId:'ABC123',action:{actionId:id,fromPlayerId:from,toPlayerId:'Bob',timestamp:1000}});
  assert.equal(dom.body.children.length,2);
  assert.equal(dom.target.classList.contains('tomato-hit'),true);
  controller.reset();
  assert.equal(dom.body.children.length,0);
  assert.equal(dom.target.classList.contains('tomato-hit'),false);
  assert.equal(controller.tomatoFlights.length,0);
});

test('reduced motion still uses the local fruit and splat but skips the particle flight', () => {
  const timer = clock();
  const dom = fakeDom();
  dom.source = dom.element({player:'Alice'}, {left:20,top:20,width:40,height:40});
  dom.target = dom.element({player:'Bob'}, {left:220,top:120,width:40,height:40});
  dom.doc.querySelectorAll = selector => selector === '[data-player]' ? [dom.source,dom.target] : [];
  const controller = TomatoInteractions.create({roomId:'ABC123',playerId:'Alice',document:dom.doc,reducedMotion:()=>true,now:timer.now,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout,impactMs:800});
  controller.handleTomatoMessage({type:'TOMATO_THROW',roomId:'ABC123',action:{actionId:'reduced',fromPlayerId:'Alice',toPlayerId:'Bob',timestamp:1000}});
  const visual = dom.body.children[0];
  assert.match(visual.className,/tomato-reduced/);
  assert.equal(visual.children[1].children.filter(child=>child.className==='tomato-droplet').length,10,'DOM is stable while CSS hides motion particles');
  timer.advance(500);
  assert.equal(dom.body.children.length,0);
});

test('impact callback fires once per accepted action and never blocks cleanup', () => {
  const timer = clock();
  const impacts = [];
  const dom = fakeDom();
  dom.source = dom.element({player:'Bob'}, {left:20,top:20,width:40,height:40});
  dom.target = dom.element({player:'Alice'}, {left:220,top:120,width:40,height:40});
  dom.doc.querySelectorAll = selector => selector === '[data-player]' ? [dom.source,dom.target] : [];
  const controller = TomatoInteractions.create({ roomId:'ABC123', playerId:'Alice', document:dom.doc, frame:dom.doc.defaultView, now:timer.now, setTimeout:timer.setTimeout, clearTimeout:timer.clearTimeout, onImpact:action => impacts.push(action.actionId), flightMs:0, impactMs:100 });
  controller.handleTomatoMessage({type:'TOMATO_THROW',roomId:'ABC123',action:{actionId:'impact-1',fromPlayerId:'Bob',toPlayerId:'Alice',timestamp:1000}});
  assert.deepEqual(impacts,['impact-1']);
  timer.advance(100);
  assert.equal(controller.tomatoFlights.length,0);
});
