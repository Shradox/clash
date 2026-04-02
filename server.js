/**
 * ARENA WARS — Authoritative Game Server
 * 
 * Установка:  npm install ws
 * Запуск:     node server.js
 * Открыть:    http://localhost:3000
 * 
 * Архитектура:
 *  - Вся игровая логика на сервере (авторитетный сервер)
 *  - Клиент отправляет только ВХОДНЫЕ ДАННЫЕ (какую карту, куда поставить)
 *  - Сервер тикает 20 раз/сек и рассылает полный снэпшот состояния
 *  - Нет рассинхрона: у всех игроков одинаковое состояние
 */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_MS = 50; // 20 Hz

// ──────────────────────────────────────────────────────────────────────────────
// HTTP — раздаём статику из папки public/
// ──────────────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// ──────────────────────────────────────────────────────────────────────────────
// ИГРОВЫЕ КОНСТАНТЫ
// ──────────────────────────────────────────────────────────────────────────────
const BRIDGE_L = -5.5, BRIDGE_R = 5.5;
const RIVER_MIN = -1.5, RIVER_MAX = 1.5;
const ELIXIR_REGEN = 0.4;   // единиц/сек
const GAME_DURATION = 180;   // секунд

const CARDS = [
  {id:'programmer', cost:3, hp:600,  dmg:110, atkSpd:1.3, range:3.8, spd:0.7,  ability:'bug',       aCD:5,   type:'troop'},
  {id:'trooper',    cost:4, hp:1100, dmg:160, atkSpd:1.5, range:2.0, spd:0.9,  ability:'landing',   aCD:99,  type:'troop'},
  {id:'skinny',     cost:2, hp:320,  dmg:180, atkSpd:0.75,range:1.4, spd:1.6,  ability:'dodge',     aCD:0,   type:'troop'},
  {id:'superdog',   cost:3, hp:750,  dmg:130, atkSpd:0.9, range:1.4, spd:1.9,  ability:'rage',      aCD:0,   type:'troop'},
  {id:'surgeon',    cost:4, hp:650,  dmg:40,  atkSpd:1.5, range:1.8, spd:0.8,  ability:'heal',      aCD:7,   type:'troop'},
  {id:'father',     cost:5, hp:2800, dmg:90,  atkSpd:2.2, range:1.7, spd:0.5,  ability:'armor',     aCD:0,   type:'troop'},
  {id:'ninja',      cost:3, hp:480,  dmg:220, atkSpd:0.6, range:1.6, spd:2.2,  ability:'crit',      aCD:4,   type:'troop'},
  {id:'grandma',    cost:2, hp:900,  dmg:50,  atkSpd:1.8, range:1.5, spd:0.4,  ability:'taunt',     aCD:0,   type:'troop'},
  {id:'cannon',     cost:3, hp:800,  dmg:120, atkSpd:1.2, range:5.5, spd:0,    ability:'building',  aCD:0,   type:'building', lifetime:30},
  {id:'hut',        cost:4, hp:700,  dmg:0,   atkSpd:0,   range:0,   spd:0,    ability:'spawner',   aCD:5,   type:'building', lifetime:30},
  {id:'fireball',   cost:4, hp:0,    dmg:350, atkSpd:0,   range:2.5, spd:0,    ability:'spell_aoe', aCD:0,   type:'spell'},
  {id:'freeze',     cost:4, hp:0,    dmg:0,   atkSpd:0,   range:2.5, spd:0,    ability:'spell_frz', aCD:0,   type:'spell'},
  {id:'lightning',  cost:3, hp:0,    dmg:500, atkSpd:0,   range:0,   spd:0,    ability:'spell_ltg', aCD:0,   type:'spell'},
  {id:'heal_spell', cost:3, hp:0,    dmg:0,   atkSpd:0,   range:2.5, spd:0,    ability:'spell_hl',  aCD:0,   type:'spell'},
];
const CMAP = Object.fromEntries(CARDS.map(c=>[c.id,c]));

// ──────────────────────────────────────────────────────────────────────────────
// MATCHMAKING
// ──────────────────────────────────────────────────────────────────────────────
const queue   = [];
const games   = new Map();
let nextGid   = 1;
let nextPid   = 1;
let nextUid   = 1;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(game, obj) {
  game.players.forEach(p => send(p, obj));
}

wss.on('connection', ws => {
  ws.pid  = nextPid++;
  ws.gid  = null;
  ws.side = null;
  ws.alive = true;
  ws.on('pong', () => ws.alive = true);

  console.log(`[+] P${ws.pid} connected  queue=${queue.length}`);
  send(ws, { type:'connected', pid: ws.pid });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    onMessage(ws, m);
  });

  ws.on('close', () => {
    console.log(`[-] P${ws.pid} disconnected`);
    const qi = queue.indexOf(ws);
    if (qi !== -1) queue.splice(qi, 1);
    if (ws.gid) {
      const g = games.get(ws.gid);
      if (g && g.running) {
        g.running = false;
        clearInterval(g.interval);
        g.players.forEach(p => {
          if (p !== ws && p.readyState === 1)
            send(p, { type:'opponent_left' });
        });
        games.delete(ws.gid);
      }
    }
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
}, 15000);

function onMessage(ws, m) {
  if (m.type === 'ping') { send(ws, {type:'pong'}); return; }
  if (m.type === 'find_game') {
    if (!queue.includes(ws) && !ws.gid) {
      queue.push(ws);
      send(ws, { type:'searching', queue: queue.length });
      console.log(`[Q] P${ws.pid} searching  queue=${queue.length}`);
      tryMatch();
    }
    return;
  }
  if (m.type === 'cancel_search') {
    const i = queue.indexOf(ws); if (i !== -1) queue.splice(i,1);
    return;
  }
  if (m.type === 'place') {
    const g = games.get(ws.gid);
    if (g && g.running) placeCard(g, ws.side, m.cardId, m.x, m.z);
    return;
  }
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift(), b = queue.shift();
    if (a.readyState!==1) { if (b.readyState===1) queue.unshift(b); continue; }
    if (b.readyState!==1) { if (a.readyState===1) queue.unshift(a); continue; }
    startGame(a, b);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ИГРОВАЯ ЛОГИКА (авторитетный сервер)
// ──────────────────────────────────────────────────────────────────────────────
function shuffle(n) {
  const a = [...Array(n).keys()];
  for (let i=a.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

function startGame(p1, p2) {
  const gid  = nextGid++;
  const d1   = shuffle(CARDS.length);
  const d2   = shuffle(CARDS.length);

  const g = {
    id: gid,
    players: [p1, p2],
    running: true,
    timeLeft: GAME_DURATION,
    crowns:  {p1:0, p2:0},
    elixir:  {p1:5, p2:5},
    deck:    {p1:d1, p2:d2},
    dpos:    {p1:4,  p2:4},
    hand:    {p1:[...d1.slice(0,4)], p2:[...d2.slice(0,4)]},
    next:    {p1:d1[4], p2:d2[4]},
    leftCapture:  false,
    rightCapture: false,
    towers: [
      mkTower('p1',false,-4.5, 9),
      mkTower('p1',false, 4.5, 9),
      mkTower('p1',true,  0,  11.5),
      mkTower('p2',false,-4.5,-9),
      mkTower('p2',false, 4.5,-9),
      mkTower('p2',true,  0, -11.5),
    ],
    units: [],
    events: [],   // накапливаем за тик: [{type,…}]
    interval: null,
  };

  p1.gid=gid; p1.side='p1';
  p2.gid=gid; p2.side='p2';
  games.set(gid, g);
  console.log(`[G${gid}] P${p1.pid}(p1) vs P${p2.pid}(p2)`);

  const tuids=g.towers.map(t=>t.uid);
  // Стартовый пакет — каждому своя колода
  send(p1, { type:'game_start', side:'p1', hand:g.hand.p1.map(i=>CARDS[i].id), next:CARDS[g.next.p1].id, towerUids:tuids });
  send(p2, { type:'game_start', side:'p2', hand:g.hand.p2.map(i=>CARDS[i].id), next:CARDS[g.next.p2].id, towerUids:tuids });


  // Запускаем тик
  let last = Date.now();
  g.interval = setInterval(() => {
    const now = Date.now();
    const dt  = (now - last) / 1000;
    last = now;
    if (g.running) gameTick(g, dt);
  }, TICK_MS);
}

function mkTower(side,isKing,x,z) {
  return { uid:nextUid++, side, isKing, x, z,
    hp: isKing?6000:3000, maxHp: isKing?6000:3000,
    atkRange: isKing?6.5:5.5, dmg: isKing?75:60,
    atkSpd:1.8, atkTimer: Math.random()*1.5, destroyed:false };
}

function mkUnit(cardId, side, x, z) {
  const c = CMAP[cardId];
  return { uid:nextUid++, cardId, side, x, z,
    hp:c.hp, maxHp:c.hp,
    atkTimer:Math.random()*0.4,
    aTimer:c.aCD||99,
    slowTimer:0, freezeTimer:0,
    bridge: Math.abs(x-BRIDGE_L)<=Math.abs(x-BRIDGE_R)?BRIDGE_L:BRIDGE_R,
    dead:false };
}

function cycleCard(g, side, handIdx) {
  const pool = g.deck[side];
  const pos  = g.dpos[side];
  g.hand[side][handIdx] = g.next[side];
  g.next[side] = pool[pos % pool.length];
  g.dpos[side]++;
}

function canPlace(g, side, x, z) {
  if (side==='p1') {
    if (z >= 0.5) return true;  // своя сторона
    if (z < -0.5) {
      if (x < 0 && g.leftCapture)  return true;
      if (x >= 0 && g.rightCapture) return true;
    }
    return false;
  } else {
    return z <= -0.5;  // p2 своя сторона
  }
}

function placeCard(g, side, cardId, x, z) {
  const ci = CARDS.findIndex(c=>c.id===cardId);
  if (ci<0) return;
  const c  = CARDS[ci];
  if (g.elixir[side] < c.cost) return;
  const hi = g.hand[side].indexOf(ci);
  if (hi<0) return;

  if (c.type==='spell') {
    g.elixir[side] -= c.cost;
    castSpell(g, c, side, x, z);
    cycleCard(g, side, hi);
    pushHandUpdate(g, side);
    return;
  }
  if (!canPlace(g, side, x, z)) return;

  g.elixir[side] -= c.cost;
  const u = mkUnit(cardId, side, Math.max(-8,Math.min(8,x)), side==='p1'?Math.max(-12,Math.min(12.5,z)):Math.max(-12.5,Math.min(12,z)));
  g.units.push(u);
  if (c.ability==='landing') landingAoe(g, u);
  cycleCard(g, side, hi);
  pushHandUpdate(g, side);
}

function pushHandUpdate(g, side) {
  const ws = g.players.find(p=>p.side===side);
  send(ws, { type:'hand_update', hand:g.hand[side].map(i=>CARDS[i].id), next:CARDS[g.next[side]].id });
}

// ──────────────── СПЕЛЛЫ ────────────────────────────────────────────────────
function castSpell(g, c, side, tx, tz) {
  const enemySide = side==='p1'?'p2':'p1';
  g.events.push({ type:'spell', id:c.id, x:tx, z:tz });
  if (c.ability==='spell_aoe') {
    aoeHit(g, enemySide, tx, tz, c.range, c.dmg);
  } else if (c.ability==='spell_frz') {
    const units = g.units.filter(u=>u.side===enemySide&&!u.dead);
    units.forEach(u=>{ if(dist2d(u.x,u.z,tx,tz)<c.range){ u.freezeTimer=3; }});
  } else if (c.ability==='spell_ltg') {
    const targets=[...g.units.filter(u=>u.side===enemySide&&!u.dead),...g.towers.filter(t=>t.side===enemySide&&!t.destroyed)];
    if(targets.length){
      const top=targets.reduce((a,b)=>a.hp>b.hp?a:b);
      top.hp-=500;
      g.events.push({type:'lightning',x:top.x||top.x,z:top.z||top.z});
      checkDeath(g,top);
    }
  } else if (c.ability==='spell_hl') {
    const allies=g.units.filter(u=>u.side===side&&!u.dead);
    allies.forEach(u=>{ if(dist2d(u.x,u.z,tx,tz)<c.range) u.hp=Math.min(u.maxHp,u.hp+300); });
  }
}

function aoeHit(g,enemySide,tx,tz,r,dmg){
  g.units.filter(u=>u.side===enemySide&&!u.dead).forEach(u=>{if(dist2d(u.x,u.z,tx,tz)<r){u.hp-=dmg;checkDeath(g,u);}});
  g.towers.filter(t=>t.side===enemySide&&!t.destroyed).forEach(t=>{if(dist2d(t.x,t.z,tx,tz)<r){t.hp-=dmg;checkTowerDeath(g,t);}});
}

// ──────────────── LANDING AoE ────────────────────────────────────────────────
function landingAoe(g, u) {
  const enemySide = u.side==='p1'?'p2':'p1';
  g.units.filter(e=>e.side===enemySide&&!e.dead).forEach(e=>{ if(dist2d(e.x,e.z,u.x,u.z)<2.5){e.hp-=150;checkDeath(g,e);} });
  g.events.push({type:'aoe',x:u.x,z:u.z,r:2.5,color:'#22c55e'});
}

// ──────────────── HELPERS ────────────────────────────────────────────────────
function dist2d(ax,az,bx,bz){ const dx=ax-bx,dz=az-bz; return Math.sqrt(dx*dx+dz*dz); }

function checkDeath(g,u){
  if(u.hp<=0&&!u.dead){ u.dead=true; g.events.push({type:'unit_dead',uid:u.uid}); }
}
function checkTowerDeath(g,t){
  if(t.hp<=0&&!t.destroyed){
    t.destroyed=true;
    const winner=t.side==='p1'?'p2':'p1';
    g.crowns[winner]++;
    if(!t.isKing){
      if(t.x<0) g.leftCapture=true;
      else       g.rightCapture=true;
    }
    g.events.push({type:'tower_dead',uid:t.uid,side:t.side,isKing:t.isKing});
    if(t.isKing) endGame(g,winner);
  }
}

function endGame(g,winner){
  if(!g.running) return;
  g.running=false;
  clearInterval(g.interval);
  broadcast(g,{ type:'game_over', winner, crowns:g.crowns });
  g.players.forEach(p=>{ p.gid=null; p.side=null; });
  setTimeout(()=>games.delete(g.id), 5000);
  console.log(`[G${g.id}] Over. Winner=${winner||'draw'} crowns p1=${g.crowns.p1} p2=${g.crowns.p2}`);
}

// ──────────────── ГЛАВНЫЙ ТИК ────────────────────────────────────────────────
function gameTick(g, dt) {
  dt = Math.min(dt, 0.1); // clamp

  // Элексир
  g.elixir.p1 = Math.min(10, g.elixir.p1 + ELIXIR_REGEN * dt);
  g.elixir.p2 = Math.min(10, g.elixir.p2 + ELIXIR_REGEN * dt);

  // Таймер
  g.timeLeft -= dt;
  if (g.timeLeft <= 0) {
    const w = g.crowns.p1>g.crowns.p2?'p1':g.crowns.p2>g.crowns.p1?'p2':null;
    endGame(g, w); return;
  }

  // Юниты
  g.units.forEach(u => tickUnit(g, u, dt));
  g.units = g.units.filter(u=>!u.dead);

  // Башни
  g.towers.forEach(t => { if(!t.destroyed) tickTower(g,t,dt); });

  // Отправляем снэпшот
  const snap = buildSnap(g);
  g.players.forEach(p => send(p, snap));
  g.events = [];
}

// ──────────────── ТИК ЮНИТА ──────────────────────────────────────────────────
function tickUnit(g, u, dt) {
  if (u.dead) return;
  if (u.freezeTimer>0) { u.freezeTimer-=dt; return; }
  if (u.slowTimer>0) u.slowTimer-=dt;
  u.aTimer-=dt;

  const c = CMAP[u.cardId];

  // Строение: убывает HP по lifetime
  if (c.type==='building') {
    if (!u._lifeInit) { u._lifeLeft=c.lifetime||30; u._lifeInit=true; }
    u._lifeLeft-=dt;
    u.hp = u.maxHp*(u._lifeLeft/(c.lifetime||30));
    if (u._lifeLeft<=0) { checkDeath(g,{...u,hp:0}); u.dead=true; return; }
    // Spawner: спавнит Программиста
    if (c.ability==='spawner' && u.aTimer<=0) {
      u.aTimer=c.aCD;
      const nu=mkUnit('programmer',u.side,u.x+(Math.random()-.5)*.5,u.z+(u.side==='p1'?-.8:.8));
      g.units.push(nu);
    }
    // Cannon: атакует
    if (c.ability==='building') {
      u.atkTimer-=dt;
      if (u.atkTimer<=0) {
        u.atkTimer=c.atkSpd;
        const tgt=findTarget(g,u);
        if (tgt) { applyDmg(g,tgt,c.dmg); g.events.push({type:'shot',fx:u.x,fz:u.z,tx:tgt.x||tgt.x,tz:tgt.z}); }
      }
    }
    return;
  }

  // Саппорт (хирург)
  if (c.ability==='heal') {
    const allies=g.units.filter(a=>a.side===u.side&&!a.dead&&a!==u);
    allies.forEach(a=>{ if(dist2d(a.x,a.z,u.x,u.z)<3) a.hp=Math.min(a.maxHp,a.hp+80*dt); });
    if(u.aTimer<=0){
      const w=allies.find(a=>a.hp<a.maxHp*.5);
      if(w){w.hp=Math.min(w.maxHp,w.hp+300);u.aTimer=c.aCD;g.events.push({type:'heal',x:w.x,z:w.z});}
    }
  }

  const tgt=findTarget(g,u);
  if (!tgt) { moveBridge(g,u,dt,c); return; }

  const d=dist2d(u.x,u.z,tgt.x,tgt.z);

  if (d<=c.range) {
    // Атака
    u.atkTimer-=dt;
    if (u.atkTimer<=0) {
      u.atkTimer=c.atkSpd;
      let dmg=c.dmg;
      // Rage
      if(c.ability==='rage'&&u.hp<u.maxHp*.5) dmg*=1.5;
      // Crit
      if(c.ability==='crit'&&u.aTimer<=0){dmg*=2;u.aTimer=c.aCD;g.events.push({type:'crit',x:tgt.x,z:tgt.z});}
      applyDmg(g,tgt,dmg);
      // Bug
      if(c.ability==='bug'&&u.aTimer<=0&&tgt.slowTimer!==undefined){tgt.slowTimer=2;u.aTimer=c.aCD;g.events.push({type:'bug',x:tgt.x,z:tgt.z});}
      g.events.push({type:'shot',fx:u.x,fz:u.z,tx:tgt.x,tz:tgt.z,col:c.id});
    }
  } else {
    moveBridge(g,u,dt,c);
  }
}

function applyDmg(g,tgt,dmg){
  if(tgt.destroyed!==undefined){
    // башня
    if(tgt.card&&CMAP[tgt.card]&&CMAP[tgt.card].ability==='dodge'&&Math.random()<.2) return;
    tgt.hp-=dmg; checkTowerDeath(g,tgt);
  } else {
    // юнит
    if(CMAP[tgt.cardId]&&CMAP[tgt.cardId].ability==='dodge'&&Math.random()<.2){g.events.push({type:'dodge',x:tgt.x,z:tgt.z});return;}
    if(CMAP[tgt.cardId]&&CMAP[tgt.cardId].ability==='armor') dmg=Math.floor(dmg*.8);
    tgt.hp-=dmg; checkDeath(g,tgt);
  }
}

// Bridge pathfinding (идентично клиенту)
function moveBridge(g,u,dt,c){
  const tgt=findTarget(g,u);
  let gx,gz;
  if(!tgt){
    // Идти к вражеской башне напрямую
    const eTower=g.towers.find(t=>t.side!==u.side&&!t.destroyed&&t.isKing);
    if(!eTower)return;
    gx=eTower.x; gz=eTower.z;
  } else {
    gx=tgt.x; gz=tgt.z;
  }

  const rage=(c.ability==='rage'&&u.hp<u.maxHp*.5)?1.5:1;
  const slow=u.slowTimer>0?.55:1;
  const spd=c.spd*rage*slow * dt;

  const px=u.x, pz=u.z;
  const inRiver=pz>RIVER_MIN&&pz<RIVER_MAX;
  const pastRiver=u.side==='p1'?pz<=RIVER_MIN:pz>=RIVER_MAX;
  const bx=u.bridge;

  let mx,mz;
  if(pastRiver){
    u.bridge=null;
    // Re-assign if needed
    if(!u.bridge) u.bridge=(Math.abs(px-BRIDGE_L)<=Math.abs(px-BRIDGE_R))?BRIDGE_L:BRIDGE_R;
    mx=gx; mz=gz;
  } else if(inRiver){
    mx=bx; mz=u.side==='p1'?RIVER_MIN-.05:RIVER_MAX+.05;
  } else {
    const eZ=u.side==='p1'?RIVER_MAX+.1:RIVER_MIN-.1;
    if(Math.abs(px-bx)>0.3){mx=bx;mz=pz;}
    else{mx=bx;mz=eZ;}
  }

  const dx=mx-px,dz=mz-pz,len=Math.sqrt(dx*dx+dz*dz);
  if(len>0.02){u.x+=dx/len*spd;u.z+=dz/len*spd;}
}

function findTarget(g,u){
  const eSide=u.side==='p1'?'p2':'p1';
  let best=null,bd=Infinity;
  g.units.filter(e=>e.side===eSide&&!e.dead).forEach(e=>{
    const d=dist2d(u.x,u.z,e.x,e.z);
    const w=CMAP[e.cardId]&&CMAP[e.cardId].ability==='taunt'?d*.5:d;
    if(w<bd){best=e;bd=d;}
  });
  g.towers.filter(t=>t.side===eSide&&!t.destroyed).forEach(t=>{
    const d=dist2d(u.x,u.z,t.x,t.z);
    if(d<bd){best=t;bd=d;}
  });
  return best;
}

// ──────────────── ТИК БАШНИ ──────────────────────────────────────────────────
function tickTower(g,t,dt){
  t.atkTimer-=dt;
  if(t.atkTimer>0) return;
  const eSide=t.side==='p1'?'p2':'p1';
  let best=null,bd=Infinity;
  g.units.filter(u=>u.side===eSide&&!u.dead).forEach(u=>{
    const d=dist2d(t.x,t.z,u.x,u.z);
    if(d<t.atkRange&&d<bd){best=u;bd=d;}
  });
  if(best){
    t.atkTimer=t.atkSpd;
    applyDmg(g,best,t.dmg);
    g.events.push({type:'shot',fx:t.x,fz:t.z,tx:best.x,tz:best.z,col:'tower'});
  }
}

// ──────────────── СНЭПШОТ ────────────────────────────────────────────────────
function buildSnap(g){
  return {
    type:'snap',
    t: g.timeLeft,
    crowns: g.crowns,
    elixir: { p1:Math.floor(g.elixir.p1), p2:Math.floor(g.elixir.p2) },
    towers: g.towers.map(t=>({uid:t.uid,hp:t.hp,maxHp:t.maxHp,destroyed:t.destroyed})),
    units:  g.units.filter(u=>!u.dead).map(u=>({uid:u.uid,cardId:u.cardId,side:u.side,x:u.x,z:u.z,hp:u.hp,maxHp:u.maxHp,frozen:u.freezeTimer>0})),
    events: g.events,
    lc: g.leftCapture,
    rc: g.rightCapture,
  };
}

httpServer.listen(PORT, () =>
  console.log(`\n🏟  ARENA WARS Server запущен\n   → http://localhost:${PORT}\n`)
);
