/**
 * ARENA WARS — Game Server v2
 * npm install ws  →  node server.js  →  http://localhost:10000
 */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ws — use local install first, fallback to bundled path
let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch(e) {
  ({ WebSocketServer } = require(
    '/home/claude/.npm-global/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/ws'
  ));
}

const PORT = process.env.PORT || 10000;
const TICK_MS          = 33;   // ~30 Hz
const GAME_DURATION    = 180;  // seconds
const OVERTIME_DUR     = 60;   // seconds
const ELIX_REGEN       = 0.40; // per second normal
const ELIX_REGEN_OT    = 0.70; // per second overtime
const BRIDGE_L         = -5.5;
const BRIDGE_R         =  5.5;
const RIVER_MIN        = -1.5;
const RIVER_MAX        =  1.5;

// ─── HTTP ────────────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    const ext  = path.extname(filePath);
    const mime = { '.html':'text/html','.js':'application/javascript','.css':'text/css' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// ─── CARD DEFINITIONS ────────────────────────────────────────────────────────
const CARDS = [
  {id:'programmer', cost:3, hp:600,  dmg:110, atkSpd:1.3, range:3.8, spd:0.7,  abil:'bug',      aCD:5,  type:'troop'},
  {id:'trooper',    cost:4, hp:1100, dmg:160, atkSpd:1.5, range:2.0, spd:0.9,  abil:'landing',  aCD:99, type:'troop'},
  {id:'skinny',     cost:2, hp:320,  dmg:180, atkSpd:0.75,range:1.4, spd:1.6,  abil:'dodge',    aCD:0,  type:'troop'},
  {id:'superdog',   cost:3, hp:750,  dmg:130, atkSpd:0.9, range:1.4, spd:1.9,  abil:'rage',     aCD:0,  type:'troop'},
  {id:'surgeon',    cost:4, hp:650,  dmg:40,  atkSpd:1.5, range:1.8, spd:0.8,  abil:'heal',     aCD:7,  type:'troop'},
  {id:'father',     cost:5, hp:2800, dmg:90,  atkSpd:2.2, range:1.7, spd:0.5,  abil:'armor',    aCD:0,  type:'troop'},
  {id:'ninja',      cost:3, hp:480,  dmg:220, atkSpd:0.6, range:1.6, spd:2.2,  abil:'crit',     aCD:4,  type:'troop'},
  {id:'grandma',    cost:2, hp:900,  dmg:50,  atkSpd:1.8, range:1.5, spd:0.4,  abil:'taunt',    aCD:0,  type:'troop'},
  {id:'cannon',     cost:3, hp:800,  dmg:120, atkSpd:1.2, range:5.5, spd:0,    abil:'building', aCD:0,  type:'building', lifetime:30},
  {id:'hut',        cost:4, hp:700,  dmg:0,   atkSpd:0,   range:0,   spd:0,    abil:'spawner',  aCD:5,  type:'building', lifetime:30},
  {id:'fireball',   cost:4, hp:0,    dmg:350, atkSpd:0,   range:2.5, spd:0,    abil:'spell_aoe',aCD:0,  type:'spell'},
  {id:'freeze',     cost:4, hp:0,    dmg:0,   atkSpd:0,   range:2.5, spd:0,    abil:'spell_frz',aCD:0,  type:'spell'},
  {id:'lightning',  cost:3, hp:0,    dmg:500, atkSpd:0,   range:5.5, spd:0,    abil:'spell_ltg',aCD:0,  type:'spell'},
  {id:'heal_spell', cost:3, hp:0,    dmg:0,   atkSpd:0,   range:2.5, spd:0,    abil:'spell_hl', aCD:0,  type:'spell'},
];
const CMAP = Object.fromEntries(CARDS.map(c=>[c.id,c]));

// ─── STATE ───────────────────────────────────────────────────────────────────
const queue  = [];
const games  = new Map();
let nextGid  = 1;
let nextPid  = 1;
let nextUid  = 1;

function send(ws, obj) {
  if (ws && !ws.isAI && ws.readyState === 1)
    ws.send(JSON.stringify(obj));
}
function broadcast(g, obj) { g.players.forEach(p => send(p, obj)); }

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.pid   = nextPid++;
  ws.gid   = null;
  ws.side  = null;
  ws.alive = true;
  ws.isAI  = false;
  ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    handleMsg(ws, m);
  });
  ws.on('close', () => {
    const qi = queue.indexOf(ws);
    if (qi !== -1) queue.splice(qi, 1);
    if (ws.gid) {
      const g = games.get(ws.gid);
      if (g && g.running) {
        g.running = false;
        clearInterval(g.interval);
        g.players.forEach(p => { if (p !== ws) send(p, { type:'opponent_left' }); });
        games.delete(ws.gid);
      }
    }
  });

  send(ws, { type:'connected', pid: ws.pid });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false; ws.ping();
  });
}, 15000);

function handleMsg(ws, m) {
  if (m.type === 'ping') { send(ws, { type:'pong' }); return; }

  if (m.type === 'find_game') {
    if (ws.gid || queue.includes(ws)) return;
    queue.push(ws);
    send(ws, { type:'searching', queue: queue.length });
    tryMatch();
    return;
  }
  if (m.type === 'cancel_search') {
    const i = queue.indexOf(ws); if (i !== -1) queue.splice(i, 1);
    return;
  }
  if (m.type === 'solo_game') {
    if (ws.gid) return;
    const qi = queue.indexOf(ws); if (qi !== -1) queue.splice(qi, 1);
    startSoloGame(ws);
    return;
  }
  if (m.type === 'place') {
    const g = games.get(ws.gid);
    if (g && g.running) playerPlace(g, ws.side, m.cardId, m.x, m.z);
  }
}

// ─── MATCHMAKING ─────────────────────────────────────────────────────────────
function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift(), b = queue.shift();
    if (a.readyState !== 1) { if (b.readyState === 1) queue.unshift(b); continue; }
    if (b.readyState !== 1) { if (a.readyState === 1) queue.unshift(a); continue; }
    startGame(a, b);
  }
}

// ─── AI PLAYER ───────────────────────────────────────────────────────────────
function makeAI() {
  return { pid: nextPid++, gid: null, side: null, isAI: true, alive: true, readyState: 1,
           send:()=>{}, ping:()=>{} };
}

function startSoloGame(realWs) {
  const ai = makeAI();
  startGame(realWs, ai);
}

function tickAI(g, dt) {
  const ai = g.players.find(p => p.isAI);
  if (!ai) return;
  const side = ai.side;

  if (g._aiTimer === undefined) g._aiTimer = 2 + Math.random() * 2;
  g._aiTimer -= dt;
  if (g._aiTimer > 0) return;

  // Pick affordable troop/building from AI's actual hand
  const hand = g.hand[side]; // array of card indices
  const affordable = hand
    .map(ci => CARDS[ci])
    .filter(c => c && c.cost <= g.elixir[side] && c.type !== 'spell');

  if (!affordable.length) { g._aiTimer = 1.0; return; }

  const card = affordable[Math.floor(Math.random() * affordable.length)];
  const handIdx = hand.indexOf(CARDS.indexOf(card));

  const x = (Math.random() - 0.5) * 10;
  const z = side === 'p1'
    ? (Math.random() * 8 + 1.5)      // p1 spawns on positive z
    : -(Math.random() * 8 + 1.5);    // p2 spawns on negative z

  doPlace(g, side, handIdx, card, x, z);
  g._aiTimer = 2.5 + Math.random() * 3.5;
}

// ─── GAME FACTORY ────────────────────────────────────────────────────────────
function shuffle(n) {
  const a = [...Array(n).keys()];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function startGame(p1, p2) {
  const gid = nextGid++;
  const d1  = shuffle(CARDS.length);
  const d2  = shuffle(CARDS.length);

  const g = {
    id: gid,
    players: [p1, p2],
    running: true,
    timeLeft: GAME_DURATION,
    overtime: false,
    overtimeLeft: OVERTIME_DUR,
    crowns:  { p1:0, p2:0 },
    stars:   { p1:0, p2:0 },
    elixir:  { p1:5, p2:5 },
    deck:    { p1:d1, p2:d2 },
    dpos:    { p1:4,  p2:4  },
    hand:    { p1:d1.slice(0,4), p2:d2.slice(0,4) },
    next:    { p1:d1[4], p2:d2[4] },
    leftCapture:  false,
    rightCapture: false,
    towers: [
      mkTower('p1',false,-4.5,  9),
      mkTower('p1',false, 4.5,  9),
      mkTower('p1',true,  0,   11.5),
      mkTower('p2',false,-4.5, -9),
      mkTower('p2',false, 4.5, -9),
      mkTower('p2',true,  0,  -11.5),
    ],
    units:  [],
    events: [],
    interval: null,
    _aiTimer: undefined,
  };

  p1.gid = gid; p1.side = 'p1';
  p2.gid = gid; p2.side = 'p2';
  games.set(gid, g);
  console.log(`[G${gid}] ${p1.isAI?'AI':('P'+p1.pid)}(p1) vs ${p2.isAI?'AI':('P'+p2.pid)}(p2)`);

  const tuids = g.towers.map(t => t.uid);
  send(p1, { type:'game_start', side:'p1', hand:g.hand.p1.map(i=>CARDS[i].id), next:CARDS[g.next.p1].id, towerUids:tuids });
  send(p2, { type:'game_start', side:'p2', hand:g.hand.p2.map(i=>CARDS[i].id), next:CARDS[g.next.p2].id, towerUids:tuids });

  let last = Date.now();
  g.interval = setInterval(() => {
    if (!g.running) { clearInterval(g.interval); return; }
    const now = Date.now();
    const dt  = Math.min((now - last) / 1000, 0.1);
    last = now;
    gameTick(g, dt);
  }, TICK_MS);
}

function mkTower(side, isKing, x, z) {
  return {
    uid: nextUid++, side, isKing, x, z,
    hp: isKing ? 6000 : 3000,
    maxHp: isKing ? 6000 : 3000,
    atkRange: isKing ? 6.5 : 5.5,
    dmg: isKing ? 75 : 60,
    atkSpd: 1.8,
    atkTimer: Math.random() * 1.5,
    destroyed: false,
  };
}

function mkUnit(cardId, side, x, z) {
  const c = CMAP[cardId];
  return {
    uid: nextUid++, cardId, side, x, z,
    hp: c.hp, maxHp: c.hp,
    atkTimer: Math.random() * 0.4,
    aTimer: c.aCD || 99,
    slowTimer: 0,
    freezeTimer: 0,
    bridge: x < 0 ? BRIDGE_L : BRIDGE_R,
    dead: false,
    lifeLeft: c.lifetime || 0,
  };
}

// ─── CARD CYCLING ────────────────────────────────────────────────────────────
function cycleCard(g, side, handIdx) {
  g.hand[side][handIdx] = g.next[side];
  const pool = g.deck[side];
  g.dpos[side]++;
  g.next[side] = pool[g.dpos[side] % pool.length];
}

function pushHandUpdate(g, side) {
  const ws = g.players.find(p => p.side === side);
  send(ws, {
    type: 'hand_update',
    hand: g.hand[side].map(i => CARDS[i].id),
    next: CARDS[g.next[side]].id,
  });
}

// ─── PLACEMENT ───────────────────────────────────────────────────────────────
function canPlace(g, side, x, z) {
  if (side === 'p1') {
    if (z >= 0.5) return true;
    if (z < -0.5) {
      if (x < 0 && g.leftCapture)  return true;
      if (x >= 0 && g.rightCapture) return true;
    }
    return false;
  } else {
    return z <= -0.5;
  }
}

// Called when a real player sends 'place'
function playerPlace(g, side, cardId, x, z) {
  const ci = CARDS.findIndex(c => c.id === cardId);
  if (ci < 0) return;
  const c = CARDS[ci];
  if (g.elixir[side] < c.cost) return;

  const handIdx = g.hand[side].indexOf(ci);
  if (handIdx < 0) return; // card not in hand

  doPlace(g, side, handIdx, c, x, z);
}

// Shared placement logic for both player and AI
function doPlace(g, side, handIdx, c, x, z) {
  if (g.elixir[side] < c.cost) return;

  if (c.type === 'spell') {
    g.elixir[side] -= c.cost;
    castSpell(g, c, side, x, z);
    cycleCard(g, side, handIdx);
    pushHandUpdate(g, side);
    return;
  }

  if (!canPlace(g, side, x, z)) return;

  g.elixir[side] -= c.cost;
  const cx = Math.max(-8, Math.min(8, x));
  const cz = side === 'p1'
    ? Math.max(-12, Math.min(12.5, z))
    : Math.max(-12.5, Math.min(12, z));

  const u = mkUnit(c.id, side, cx, cz);
  g.units.push(u);

  if (c.abil === 'landing') landingAoe(g, u);
  cycleCard(g, side, handIdx);
  pushHandUpdate(g, side);
}

// ─── SPELLS ──────────────────────────────────────────────────────────────────
function castSpell(g, c, side, tx, tz) {
  const eS = side === 'p1' ? 'p2' : 'p1';
  g.events.push({ type:'spell', id:c.id, x:tx, z:tz, r:c.range });

  if (c.abil === 'spell_aoe') {
    aoeHit(g, eS, tx, tz, c.range, c.dmg);

  } else if (c.abil === 'spell_frz') {
    g.units.filter(u => u.side === eS && !u.dead).forEach(u => {
      if (dist(u.x,u.z,tx,tz) < c.range) u.freezeTimer = 3;
    });

  } else if (c.abil === 'spell_ltg') {
    const targets = [
      ...g.units.filter(u => u.side === eS && !u.dead && dist(u.x,u.z,tx,tz) <= c.range),
      ...g.towers.filter(t => t.side === eS && !t.destroyed && dist(t.x,t.z,tx,tz) <= c.range),
    ];
    if (targets.length) {
      const top = targets.reduce((a,b) => a.hp > b.hp ? a : b);
      hitTarget(g, top, c.dmg);
      g.events.push({ type:'lightning', x:top.x, z:top.z });
    } else {
      g.events.push({ type:'lightning_miss', x:tx, z:tz });
    }

  } else if (c.abil === 'spell_hl') {
    g.units.filter(u => u.side === side && !u.dead).forEach(u => {
      if (dist(u.x,u.z,tx,tz) < c.range) {
        u.hp = Math.min(u.maxHp, u.hp + 300);
      }
    });
    g.events.push({ type:'heal', x:tx, z:tz, r:c.range });
  }
}

function aoeHit(g, eSide, tx, tz, r, dmg) {
  g.units.filter(u => u.side === eSide && !u.dead).forEach(u => {
    if (dist(u.x,u.z,tx,tz) < r) hitTarget(g, u, dmg);
  });
  g.towers.filter(t => t.side === eSide && !t.destroyed).forEach(t => {
    if (dist(t.x,t.z,tx,tz) < r) hitTarget(g, t, dmg);
  });
}

function landingAoe(g, u) {
  const eS = u.side === 'p1' ? 'p2' : 'p1';
  g.units.filter(e => e.side === eS && !e.dead).forEach(e => {
    if (dist(e.x,e.z,u.x,u.z) < 2.5) hitTarget(g, e, 150);
  });
  g.events.push({ type:'aoe', x:u.x, z:u.z, r:2.5 });
}

// ─── DAMAGE ──────────────────────────────────────────────────────────────────
function hitTarget(g, tgt, dmg) {
  if (tgt.destroyed !== undefined) {
    // tower
    tgt.hp -= dmg;
    if (tgt.hp <= 0) destroyTower(g, tgt);
  } else {
    // unit
    const c = CMAP[tgt.cardId];
    if (c && c.abil === 'dodge' && Math.random() < 0.2) {
      g.events.push({ type:'dodge', x:tgt.x, z:tgt.z }); return;
    }
    if (c && c.abil === 'armor') dmg = Math.floor(dmg * 0.8);
    tgt.hp -= dmg;
    if (tgt.hp <= 0 && !tgt.dead) {
      tgt.dead = true;
      g.events.push({ type:'unit_dead', uid:tgt.uid });
    }
  }
}

function destroyTower(g, t) {
  if (t.destroyed) return;
  t.destroyed = true;
  const winner = t.side === 'p1' ? 'p2' : 'p1';
  g.crowns[winner]++;
  g.stars[winner]++;
  if (!t.isKing) {
    if (t.x < 0) g.leftCapture  = true;
    else          g.rightCapture = true;
  }
  g.events.push({ type:'tower_dead', uid:t.uid, side:t.side, isKing:t.isKing });
  if (t.isKing) {
    g.stars[winner] = 3;
    endGame(g, winner);
  }
}

function endGame(g, winner) {
  if (!g.running) return;
  g.running = false;
  clearInterval(g.interval);
  broadcast(g, { type:'game_over', winner, crowns:g.crowns, stars:g.stars, overtime:g.overtime });
  g.players.forEach(p => { p.gid = null; p.side = null; });
  setTimeout(() => games.delete(g.id), 5000);
  console.log(`[G${g.id}] End winner=${winner||'draw'} p1=${g.crowns.p1} p2=${g.crowns.p2}`);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function dist(ax,az,bx,bz) {
  const dx=ax-bx, dz=az-bz; return Math.sqrt(dx*dx+dz*dz);
}

// ─── GAME TICK ───────────────────────────────────────────────────────────────
function gameTick(g, dt) {
  // Elixir
  const er = g.overtime ? ELIX_REGEN_OT : ELIX_REGEN;
  g.elixir.p1 = Math.min(10, g.elixir.p1 + er * dt);
  g.elixir.p2 = Math.min(10, g.elixir.p2 + er * dt);

  // Timer / overtime
  if (!g.overtime) {
    g.timeLeft -= dt;
    if (g.timeLeft <= 0) {
      g.timeLeft = 0;
      if (g.crowns.p1 !== g.crowns.p2) {
        endGame(g, g.crowns.p1 > g.crowns.p2 ? 'p1' : 'p2'); return;
      }
      // Tie → overtime
      g.overtime = true;
      g.overtimeLeft = OVERTIME_DUR;
      broadcast(g, { type:'overtime_start' });
      console.log(`[G${g.id}] OVERTIME`);
    }
  } else {
    g.overtimeLeft -= dt;
    if (g.overtimeLeft <= 0) {
      // Decide by remaining enemy HP
      const p1EnemyHp = g.towers.filter(t=>t.side==='p2'&&!t.destroyed).reduce((a,t)=>a+Math.max(0,t.hp),0);
      const p2EnemyHp = g.towers.filter(t=>t.side==='p1'&&!t.destroyed).reduce((a,t)=>a+Math.max(0,t.hp),0);
      let w = null;
      if (p1EnemyHp < p2EnemyHp) w = 'p1';
      else if (p2EnemyHp < p1EnemyHp) w = 'p2';
      endGame(g, w); return;
    }
  }

  // AI
  tickAI(g, dt);

  // Units
  g.units.forEach(u => tickUnit(g, u, dt));
  g.units = g.units.filter(u => !u.dead);

  // Towers
  g.towers.forEach(t => { if (!t.destroyed) tickTower(g, t, dt); });

  // Snapshot
  broadcast(g, buildSnap(g));
  g.events = [];
}

// ─── UNIT TICK ───────────────────────────────────────────────────────────────
function tickUnit(g, u, dt) {
  if (u.dead) return;
  if (u.freezeTimer > 0) { u.freezeTimer -= dt; return; }
  if (u.slowTimer  > 0)    u.slowTimer  -= dt;
  u.aTimer -= dt;

  const c = CMAP[u.cardId];

  // Building: lifetime decay
  if (c.type === 'building') {
    if (u.lifeLeft > 0) {
      u.lifeLeft -= dt;
      u.hp = u.maxHp * (u.lifeLeft / (c.lifetime || 30));
      if (u.lifeLeft <= 0) { u.dead = true; g.events.push({type:'unit_dead',uid:u.uid}); return; }
    }
    // Spawner
    if (c.abil === 'spawner' && u.aTimer <= 0) {
      u.aTimer = c.aCD;
      const nu = mkUnit('programmer', u.side, u.x+(Math.random()-.5)*.5,
                        u.z + (u.side==='p1' ? -0.8 : 0.8));
      g.units.push(nu);
    }
    // Cannon: attack
    if (c.abil === 'building') {
      u.atkTimer -= dt;
      if (u.atkTimer <= 0) {
        u.atkTimer = c.atkSpd;
        const tgt = findTarget(g, u);
        if (tgt) {
          hitTarget(g, tgt, c.dmg);
          g.events.push({type:'shot',fx:u.x,fz:u.z,tx:tgt.x,tz:tgt.z,col:u.cardId});
        }
      }
    }
    return;
  }

  // Surgeon heal
  if (c.abil === 'heal') {
    const allies = g.units.filter(a => a.side === u.side && !a.dead && a !== u);
    allies.forEach(a => {
      if (dist(a.x,a.z,u.x,u.z) < 3) a.hp = Math.min(a.maxHp, a.hp + 80*dt);
    });
    if (u.aTimer <= 0) {
      const w = allies.find(a => a.hp < a.maxHp * 0.5);
      if (w) { w.hp = Math.min(w.maxHp, w.hp + 300); u.aTimer = c.aCD; g.events.push({type:'heal',x:w.x,z:w.z}); }
    }
  }

  const tgt = findTarget(g, u);
  if (!tgt) { moveBridge(u, c, null, dt); return; }

  const d = dist(u.x,u.z, tgt.x, tgt.z);

  if (d <= c.range) {
    u.atkTimer -= dt;
    if (u.atkTimer <= 0) {
      u.atkTimer = c.atkSpd;
      let dmg = c.dmg;
      if (c.abil === 'rage' && u.hp < u.maxHp * 0.5) dmg *= 1.5;
      if (c.abil === 'crit' && u.aTimer <= 0) { dmg *= 2; u.aTimer = c.aCD; g.events.push({type:'crit',x:tgt.x,z:tgt.z}); }
      if (c.abil === 'bug'  && u.aTimer <= 0 && tgt.slowTimer !== undefined) {
        tgt.slowTimer = 2; u.aTimer = c.aCD;
        g.events.push({type:'bug',x:tgt.x,z:tgt.z});
      }
      hitTarget(g, tgt, dmg);
      g.events.push({type:'shot',fx:u.x,fz:u.z,tx:tgt.x,tz:tgt.z,col:u.cardId});
    }
  } else {
    moveBridge(u, c, tgt, dt);
  }
}

function findTarget(g, u) {
  const eS = u.side === 'p1' ? 'p2' : 'p1';
  let best = null, bd = Infinity;
  g.units.filter(e => e.side === eS && !e.dead).forEach(e => {
    const d = dist(u.x,u.z,e.x,e.z);
    const w = CMAP[e.cardId]?.abil === 'taunt' ? d * 0.5 : d;
    if (w < bd) { best = e; bd = d; }
  });
  g.towers.filter(t => t.side === eS && !t.destroyed).forEach(t => {
    const d = dist(u.x,u.z,t.x,t.z);
    if (d < bd) { best = t; bd = d; }
  });
  return best;
}

function moveBridge(u, c, tgt, dt) {
  const rage = (c.abil === 'rage' && u.hp < u.maxHp * 0.5) ? 1.5 : 1;
  const slow = u.slowTimer > 0 ? 0.55 : 1;
  const spd  = c.spd * rage * slow * dt;

  const px = u.x, pz = u.z;
  const bx = u.bridge; // never changes after spawn
  const inRiver   = pz > RIVER_MIN && pz < RIVER_MAX;
  const pastRiver = u.side === 'p1' ? pz <= RIVER_MIN : pz >= RIVER_MAX;

  let gx, gz;
  if (pastRiver) {
    // Crossed — head straight to target or enemy king
    if (tgt) { gx = tgt.x; gz = tgt.z; }
    else return;
  } else if (inRiver) {
    // Walk through river strictly along bridge X
    u.x += (bx - u.x) * 0.25; // snap toward bridge center
    gx = bx;
    gz = u.side === 'p1' ? RIVER_MIN - 0.1 : RIVER_MAX + 0.1;
  } else {
    // Approach: align X first, then enter river
    if (Math.abs(px - bx) > 0.4) {
      gx = bx; gz = pz; // slide sideways
    } else {
      gx = bx;
      gz = u.side === 'p1' ? RIVER_MAX + 0.1 : RIVER_MIN - 0.1; // enter river
    }
  }

  const dx = gx - px, dz = gz - pz, len = Math.sqrt(dx*dx + dz*dz);
  if (len > 0.02) { u.x += dx/len*spd; u.z += dz/len*spd; }
}

// ─── TOWER TICK ──────────────────────────────────────────────────────────────
function tickTower(g, t, dt) {
  t.atkTimer -= dt;
  if (t.atkTimer > 0) return;
  const eS = t.side === 'p1' ? 'p2' : 'p1';
  let best = null, bd = Infinity;
  g.units.filter(u => u.side === eS && !u.dead).forEach(u => {
    const d = dist(t.x,t.z,u.x,u.z);
    if (d < t.atkRange && d < bd) { best = u; bd = d; }
  });
  if (best) {
    t.atkTimer = t.atkSpd;
    hitTarget(g, best, t.dmg);
    g.events.push({type:'shot',fx:t.x,fz:t.z,tx:best.x,tz:best.z,col:'tower'});
  }
}

// ─── SNAPSHOT ────────────────────────────────────────────────────────────────
function buildSnap(g) {
  return {
    type:   'snap',
    t:      g.timeLeft,
    ot:     g.overtime,
    otLeft: g.overtimeLeft,
    crowns: g.crowns,
    stars:  g.stars,
    elixir: { p1: Math.min(10, g.elixir.p1), p2: Math.min(10, g.elixir.p2) },
    towers: g.towers.map(t => ({ uid:t.uid, hp:t.hp, maxHp:t.maxHp, destroyed:t.destroyed })),
    units:  g.units.filter(u => !u.dead).map(u => ({
      uid:u.uid, cardId:u.cardId, side:u.side, x:u.x, z:u.z,
      hp:u.hp, maxHp:u.maxHp, frozen:u.freezeTimer > 0,
    })),
    events: g.events,
    lc: g.leftCapture,
    rc: g.rightCapture,
  };
}

// ─── START ───────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () =>
  console.log(`\n🏟  ARENA WARS Server\n   → http://localhost:${PORT}\n`)
);
