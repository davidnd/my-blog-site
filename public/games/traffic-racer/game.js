/* Traffic Racer — endless top-down traffic survival.
   Plain canvas, no dependencies. All audio is synthesized with WebAudio. */
(() => {
'use strict';

// ---------- helpers ----------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const chance = p => Math.random() < p;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = irand(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const $ = id => document.getElementById(id);

// ---------- canvas ----------
const canvas = $('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

// road geometry (recomputed on resize)
const LANES = 4;
const road = { x: 0, w: 0, laneW: 0 };
let PK = 3;            // px per (km/h) per second — sets scroll speed
const laneX = i => road.x + road.laneW * (i + 0.5);

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth || 800; H = window.innerHeight || 600;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const frac = road.w ? (player.x - road.x) / road.w : 0.5;
  road.w = clamp(W * 0.72, 280, 640);
  road.x = (W - road.w) / 2;
  road.laneW = road.w / LANES;
  PK = H / 135;
  player.w = road.laneW * 0.5;
  player.h = player.w * 2.0;
  player.x = road.x + road.w * frac;
  player.y = H * 0.76;
}
window.addEventListener('resize', resize);

// ---------- persistent settings ----------
const store = {
  get best() { return +(localStorage.getItem('trafficRacer.best') || 0); },
  set best(v) { localStorage.setItem('trafficRacer.best', v); },
  get music() { return localStorage.getItem('trafficRacer.music') !== '0'; },
  set music(v) { localStorage.setItem('trafficRacer.music', v ? '1' : '0'); },
  get sfx() { return localStorage.getItem('trafficRacer.sfx') !== '0'; },
  set sfx(v) { localStorage.setItem('trafficRacer.sfx', v ? '1' : '0'); },
};

// ---------- audio ----------
const A = {
  ctx: null, master: null, musicBus: null, sfxBus: null,
  engine: null, sirenNodes: null, skidNodes: null,
  musicTimer: null, musicStep: 0, musicNext: 0,

  init() {
    if (this.ctx) return;
    const C = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = C;
    this.master = C.createGain(); this.master.gain.value = 0.9; this.master.connect(C.destination);
    this.musicBus = C.createGain(); this.musicBus.gain.value = store.music ? 0.5 : 0; this.musicBus.connect(this.master);
    this.sfxBus = C.createGain(); this.sfxBus.gain.value = store.sfx ? 1 : 0; this.sfxBus.connect(this.master);

    const eg = C.createGain(); eg.gain.value = 0;
    const ef = C.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = 500; ef.Q.value = 2;
    const o1 = C.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 70;
    const o2 = C.createOscillator(); o2.type = 'square'; o2.frequency.value = 35;
    const g2 = C.createGain(); g2.gain.value = 0.4;
    o1.connect(ef); o2.connect(g2); g2.connect(ef); ef.connect(eg); eg.connect(this.sfxBus);
    o1.start(); o2.start();
    this.engine = { o1, o2, gain: eg, filter: ef };

    const nb = this.noiseBuffer(1);
    const ns = C.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const nf = C.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.7;
    const ng = C.createGain(); ng.gain.value = 0;
    ns.connect(nf); nf.connect(ng); ng.connect(this.sfxBus); ns.start();
    this.skidNodes = { gain: ng };

    this.startMusic();
  },
  noiseBuffer(sec) {
    const C = this.ctx, b = C.createBuffer(1, C.sampleRate * sec, C.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  setMusic(on) { store.music = on; if (this.musicBus) this.musicBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.05); },
  setSfx(on) { store.sfx = on; if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05); },

  updateEngine(speed, nitro, playing) {
    if (!this.engine) return;
    const C = this.ctx, t = C.currentTime;
    const f = 55 + speed * 0.6 + (nitro ? 55 : 0);
    this.engine.o1.frequency.setTargetAtTime(f, t, 0.08);
    this.engine.o2.frequency.setTargetAtTime(f / 2, t, 0.08);
    this.engine.filter.frequency.setTargetAtTime(300 + speed * 3 + (nitro ? 900 : 0), t, 0.1);
    this.engine.gain.gain.setTargetAtTime(playing ? (nitro ? 0.1 : 0.055) : 0, t, 0.1);
  },
  setSkid(on) { if (this.skidNodes) this.skidNodes.gain.gain.setTargetAtTime(on ? 0.12 : 0, this.ctx.currentTime, 0.05); },
  setSiren(on) {
    if (!this.ctx) return;
    if (on && !this.sirenNodes) {
      const C = this.ctx;
      const o = C.createOscillator(); o.type = 'triangle'; o.frequency.value = 700;
      const g = C.createGain(); g.gain.value = 0.045;
      o.connect(g); g.connect(this.sfxBus); o.start();
      this.sirenNodes = { o, g, phase: 0 };
    } else if (!on && this.sirenNodes) {
      const { o, g } = this.sirenNodes;
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
      setTimeout(() => { try { o.stop(); } catch (e) {} }, 600);
      this.sirenNodes = null;
    }
  },
  updateSiren(dt) {
    if (!this.sirenNodes) return;
    const s = this.sirenNodes;
    s.phase += dt;
    const hi = (s.phase % 0.9) < 0.45;
    s.o.frequency.setTargetAtTime(hi ? 940 : 660, this.ctx.currentTime, 0.03);
  },

  blip(freq, dur, type = 'square', vol = 0.12, slide = 0) {
    if (!this.ctx) return;
    const C = this.ctx, t = C.currentTime;
    const o = C.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    const g = C.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfxBus); o.start(t); o.stop(t + dur + 0.05);
  },
  noiseHit(dur, vol, freq = 800, q = 0.5) {
    if (!this.ctx) return;
    const C = this.ctx, t = C.currentTime;
    const s = C.createBufferSource(); s.buffer = this.noiseBuffer(dur + 0.1);
    const f = C.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = C.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.sfxBus); s.start(t); s.stop(t + dur + 0.1);
  },
  whoosh() { this.noiseHit(0.25, 0.2, 1400, 0.8); this.blip(1200, 0.12, 'sine', 0.08, 600); },
  crash() { this.noiseHit(0.7, 0.55, 300, 0.3); this.blip(90, 0.5, 'sawtooth', 0.3, -60); },
  explode() { this.noiseHit(0.5, 0.5, 200, 0.2); this.noiseHit(0.35, 0.35, 900, 0.5); this.blip(70, 0.45, 'sawtooth', 0.25, -40); },
  bump() { this.noiseHit(0.14, 0.25, 260, 0.4); this.blip(130, 0.16, 'sine', 0.16, -50); },
  horn() { this.blip(pick([310, 360, 420]), 0.35, 'square', 0.07); },
  pickupSfx() { this.blip(660, 0.1, 'square', 0.1); setTimeout(() => this.blip(990, 0.14, 'square', 0.1), 80); },
  alarm() { this.blip(520, 0.22, 'square', 0.12); setTimeout(() => this.blip(520, 0.22, 'square', 0.12), 300); },
  nitroBurst() { this.noiseHit(0.5, 0.25, 2200, 0.4); this.blip(200, 0.4, 'sawtooth', 0.12, 500); },
  thud() { this.blip(120, 0.2, 'sine', 0.2, -60); },

  startMusic() {
    if (this.musicTimer) return;
    const C = this.ctx;
    this.musicNext = C.currentTime + 0.1; this.musicStep = 0;
    const bass = [45, 45, 48, 48, 43, 43, 50, 50];
    const arp = [69, 72, 76, 72, 69, 72, 76, 79];
    const midi = m => 440 * Math.pow(2, (m - 69) / 12);
    const stepDur = 60 / 124 / 2;
    this.musicTimer = setInterval(() => {
      if (!this.ctx) return;
      while (this.musicNext < C.currentTime + 0.15) {
        const t = this.musicNext, s = this.musicStep;
        const bar = Math.floor(s / 8) % bass.length;
        this.tone(midi(bass[bar]), t, stepDur * 0.9, 'sawtooth', 0.12, this.musicBus, 300);
        this.tone(midi(arp[s % 8] + (Math.floor(s / 32) % 2) * 3), t, stepDur * 0.7, 'square', 0.045, this.musicBus, 2400);
        if (s % 2 === 0) this.hat(t, 0.03);
        this.musicNext += stepDur; this.musicStep++;
      }
    }, 60);
  },
  tone(freq, t, dur, type, vol, bus, cutoff) {
    const C = this.ctx;
    const o = C.createOscillator(); o.type = type; o.frequency.value = freq;
    const f = C.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = C.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f); f.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.05);
  },
  hat(t, vol) {
    const C = this.ctx;
    const s = C.createBufferSource(); s.buffer = this.noiseBuffer(0.06);
    const f = C.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
    const g = C.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f); f.connect(g); g.connect(this.musicBus); s.start(t); s.stop(t + 0.08);
  },
};

// ---------- input ----------
const input = { left: false, right: false, nitro: false, drag: 0 };

window.addEventListener('keydown', e => {
  const k = e.key;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(k)) e.preventDefault();
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') input.left = true;
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') input.right = true;
  else if (k === ' ') input.nitro = true;
  else if (k === 'Escape' || k === 'p' || k === 'P') { if (G.state === 'playing') pauseGame(); else if (G.state === 'paused') resumeGame(); }
  else if (k === 'Enter' && G.state === 'menu') startGame();
});
window.addEventListener('keyup', e => {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') input.left = false;
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') input.right = false;
  else if (k === ' ') input.nitro = false;
});

let dragging = false, lastPX = 0;
function pointerDown(x) { dragging = true; lastPX = x; }
function pointerMove(x) { if (dragging) { input.drag += x - lastPX; lastPX = x; } }
function pointerUp() { dragging = false; }

canvas.addEventListener('mousedown', e => pointerDown(e.clientX));
window.addEventListener('mousemove', e => pointerMove(e.clientX));
window.addEventListener('mouseup', pointerUp);
canvas.addEventListener('touchstart', e => { document.body.classList.add('touch'); pointerDown(e.touches[0].clientX); e.preventDefault(); if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume(); }, { passive: false });
canvas.addEventListener('touchmove', e => { pointerMove(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchend', e => { pointerUp(); e.preventDefault(); }, { passive: false });
window.addEventListener('touchmove', e => { if (G.state === 'playing') e.preventDefault(); }, { passive: false });

function bindHold(el, prop) {
  if (!el) return;
  const on = e => { e.preventDefault(); input[prop] = true; el.classList.add('held'); };
  const off = e => { e.preventDefault(); input[prop] = false; el.classList.remove('held'); };
  el.addEventListener('touchstart', on, { passive: false });
  el.addEventListener('touchend', off, { passive: false });
  el.addEventListener('touchcancel', off, { passive: false });
  el.addEventListener('mousedown', on); el.addEventListener('mouseup', off); el.addEventListener('mouseleave', off);
}

// ---------- game state ----------
const player = { x: 0, y: 0, w: 40, h: 80, vx: 0, speed: 0, tilt: 0, shoveT: 0, bumpT: 0 };

const G = {
  state: 'menu',
  time: 0,
  score: 0, dist: 0, topSpeed: 0, nearMisses: 0, chasesEscaped: 0, wrecked: 0,
  combo: 0, comboT: 0, slowDriveT: 0,
  nitro: 50, nitroOn: false,
  integrity: 100, smokeT: 0, crashCause: '',
  heat: 0, wanted: 0, smashT: 0, copSpawnCd: 0, escapeT: 0,
  shield: false, multT: 0, ramT: 0, oilT: 0,
  crashed: false, crashT: 0,
  shake: 0, lampOff: 0, night: 0,
  spawnT: 1.0, pickupT: 6, congestT: 0,
  event: { next: 0, bag: [] },
  weather: { type: '', t: 0, dur: 0 },
  theme: { order: [0, 1, 2, 3], idx: 0, blend: 1, nextAt: 0 },
  debug: { god: false },
};

const vehicles = [];
const cops = [];
const obstacles = [];
const pickups = [];
const particles = [];
const popups = [];
const skids = [];
const scenery = [];
const groups = {};

const CAR_COLORS = ['#e8574a', '#4a7be8', '#4ac47e', '#e8b64a', '#b06ae0', '#5ad5e0', '#e07a3a', '#8a92a8', '#d94a8c', '#68a83c'];
const TYPES = {
  car:   { w: 0.50, h: 0.95, spd: [0.50, 0.74] },
  sport: { w: 0.48, h: 0.90, spd: [0.62, 0.86] },
  taxi:  { w: 0.50, h: 0.95, spd: [0.50, 0.72] },
  ute:   { w: 0.54, h: 1.30, spd: [0.48, 0.66] },  // pickup truck
  van:   { w: 0.56, h: 1.18, spd: [0.46, 0.62] },
  truck: { w: 0.60, h: 1.95, spd: [0.40, 0.54] },
  bus:   { w: 0.60, h: 2.10, spd: [0.42, 0.56] },
  moto:  { w: 0.26, h: 0.70, spd: [0.60, 0.85] },
};

// terrain themes (ground + which roadside props appear)
const THEMES = [
  { name: 'forest', gTop: '#3f8f4b', gBot: '#2c6b38', kinds: ['tree', 'tree', 'tree', 'bush', 'rock', 'flower', 'flower', 'pond', 'patch', 'patch'] },
  { name: 'desert', gTop: '#c9a15a', gBot: '#a8823f', kinds: ['cactus', 'cactus', 'rock', 'dune', 'dune', 'scrub', 'scrub', 'patch', 'patch'] },
  { name: 'city',   gTop: '#59627a', gBot: '#3d4457', kinds: ['building', 'building', 'building', 'sign', 'tree', 'patch'] },
  { name: 'coast',  gTop: '#3fa06b', gBot: '#2f7d54', kinds: ['palm', 'palm', 'rock', 'bush', 'pond', 'pond', 'flower', 'patch'] },
];

// per-run difficulty ramps fast: challenging well before 60s, near-max by ~2min
const difficulty = () => clamp(G.time / 115, 0, 1);
const cruiseSpeed = () => 178 + Math.min(G.time, 240) * 0.62;   // km/h, always fast
const NITRO_MULT = 1.5;

function resetRun() {
  G.time = 0; G.score = 0; G.dist = 0; G.topSpeed = 0;
  G.nearMisses = 0; G.chasesEscaped = 0; G.wrecked = 0;
  G.combo = 0; G.comboT = 0; G.slowDriveT = 0;
  G.nitro = 50; G.nitroOn = false; G.crashCause = '';
  G.integrity = 100; G.smokeT = 0;
  G.heat = 0; G.wanted = 0; G.smashT = 0; G.copSpawnCd = 0; G.escapeT = 0;
  G.shield = false; G.multT = 0; G.ramT = 0; G.oilT = 0;
  G.crashed = false; G.crashT = 0; G.shake = 0; G.night = 0;
  G.spawnT = 1.0; G.pickupT = rand(5, 8); G.congestT = 0;
  G.event = { next: rand(9, 15), bag: [] };
  G.weather = { type: '', t: 0, dur: 0 };
  G.theme = { order: shuffle([0, 1, 2, 3]), idx: 0, blend: 1, nextAt: rand(32, 46) };
  vehicles.length = 0; cops.length = 0; obstacles.length = 0;
  pickups.length = 0; particles.length = 0; popups.length = 0; skids.length = 0;
  for (const k in groups) delete groups[k];
  player.x = road.x + road.w / 2; player.vx = 0; player.tilt = 0; player.shoveT = 0; player.bumpT = 0;
  player.speed = cruiseSpeed();
  initScenery();
  hideBanner();
  updateHUD(true);
}

function curTheme() { return THEMES[G.theme.order[G.theme.idx]]; }
function prevTheme() { return THEMES[G.theme.order[(G.theme.idx - 1 + THEMES.length) % THEMES.length]]; }

function initScenery() {
  scenery.length = 0;
  for (let side = 0; side < 2; side++) {
    let y = -100;
    while (y < H + 100) { scenery.push(makeSceneryItem(side, y)); y += rand(45, 110); }
  }
}
function makeSceneryItem(side, y) {
  const kind = pick(curTheme().kinds);
  return { side, y, kind, off: rand(16, Math.max(30, (W - road.w) / 2 - 30)), size: rand(0.7, 1.5), hue: rand(-18, 14), seed: rand(0, 100) };
}

// ---------- spawning ----------
function laneBlocked(lane, yMin, yMax) {
  for (const v of vehicles) {
    if (v.burnT) continue;
    // a lane-changer occupies both its source and target lane
    if ((v.lane === lane || (v.state === 'changing' && v.targetLane === lane)) && v.y > yMin && v.y < yMax) return true;
  }
  for (const o of obstacles) if (o.solid && Math.abs(o.x - laneX(lane)) < road.laneW * 0.5 && o.y > yMin && o.y < yMax) return true;
  return false;
}
function openLaneCount(yMin, yMax) {
  let n = 0;
  for (let i = 0; i < LANES; i++) if (!laneBlocked(i, yMin, yMax)) n++;
  return n;
}
function trafficWeights() { return { car: 3.5, sport: 1.6, taxi: 1.4, ute: 1.6, moto: 2, van: 2, truck: 1.8, bus: 1.4 }; }
function weightedPick(w) {
  let sum = 0; for (const k in w) sum += w[k];
  let r = Math.random() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'car';
}

function spawnVehicle() {
  const type = weightedPick(trafficWeights());
  const T = TYPES[type];
  const cruise = cruiseSpeed();
  let sf = rand(T.spd[0], T.spd[1]);
  if (G.congestT > 0) sf = rand(0.30, 0.42);
  const spd = cruise * sf;
  const w = road.laneW * T.w, h = road.laneW * T.h;
  const rel = Math.max(20, player.speed - spd);
  const gap = clamp(rel * PK * 0.8, 160, 640);
  const cand = [];
  for (let i = 0; i < LANES; i++) if (!laneBlocked(i, -gap - h, h + 200)) cand.push(i);
  if (!cand.length) return;
  const lane = pick(cand);
  if (openLaneCount(-500, 300) <= 1 && !laneBlocked(lane, -500, 300)) return;
  addVehicle(type, lane, spd);
}

function addVehicle(type, lane, spd) {
  const T = TYPES[type];
  const w = road.laneW * T.w, h = road.laneW * T.h;
  vehicles.push({
    type, lane, x: laneX(lane), y: -h - 60, w, h, speed: spd, baseSpeed: spd,
    color: pick(CAR_COLORS), state: 'cruise', targetLane: lane,
    brakeT: 0, brakeLight: false, blinker: 0, honked: false,
    overlap: false, minGap: 999, missed: false,
    rot: 0, spin: 0, pushVX: 0, hitCd: 0, burnT: 0,
  });
}

// a partial row of traffic sharing one speed, leaving 1-2 clear lanes to weave through
function spawnCluster() {
  const cruise = cruiseSpeed();
  const rowSpd = cruise * rand(0.5, 0.72);
  // require a clear band up top so the row itself isn't dropped onto existing cars
  for (let i = 0; i < LANES; i++) if (laneBlocked(i, -road.laneW * 3.2, road.laneW * 2)) return;
  const openWanted = difficulty() > 0.45 ? 1 : 2;   // harder later = fewer gaps
  const lanes = shuffle([0, 1, 2, 3]);
  const fillCount = LANES - openWanted;
  for (let k = 0; k < fillCount; k++) {
    const type = weightedPick({ car: 4, taxi: 1.2, ute: 1.2, van: 2, truck: 1.2, bus: 1 }); // motos ride solo
    addVehicle(type, lanes[k], rowSpd * rand(0.95, 1.05));
  }
}

function spawnPickup() {
  let types = ['nitro', 'nitro', 'shield', 'mult', 'ram', 'cash', 'repair'];
  if (G.integrity < 65) types.push('repair', 'repair');
  if (G.wanted > 0 || cops.length) types.push('jammer', 'jammer');
  const type = pick(types);
  const lane = irand(0, LANES - 1);
  if (laneBlocked(lane, -300, 100)) return;
  // pickups ride along below your speed so there's time to spot and reach them
  pickups.push({ type, x: laneX(lane), y: -320, t: 0, r: road.laneW * 0.22, speed: cruiseSpeed() * 0.62, driftLane: lane, driftT: rand(1.5, 3.5) });
}

// ---------- police ----------
function spawnCop(offsetLane = 0) {
  const lane = clamp(Math.round((player.x - road.x) / road.laneW - 0.5) + offsetLane, 0, LANES - 1);
  cops.push({
    x: laneX(lane), y: H + 150 + Math.abs(offsetLane) * 150,
    w: road.laneW * 0.52, h: road.laneW * 0.52 * 1.95,
    speed: player.speed + 20, state: 'chase', spinT: 0, rot: 0, lightPhase: rand(0, 2),
    hp: 100, hitCd: 0, pushVX: 0,
  });
}
// ambush: a cruiser waiting up the road that pulls in as you pass
function spawnAmbushCop() {
  const lane = irand(0, LANES - 1);
  if (laneBlocked(lane, -500, 200)) return;
  cops.push({
    x: laneX(lane), y: -180,
    w: road.laneW * 0.52, h: road.laneW * 0.52 * 1.95,
    speed: player.speed * 0.5, state: 'chase', spinT: 0, rot: 0, lightPhase: rand(0, 2),
    hp: 100, hitCd: 0, pushVX: 0,
  });
  showBanner('🚨 AMBUSH AHEAD 🚨', '', 1.6);
}

// Wanted "heat" drives the police. It climbs with survival time and spikes
// whenever you cause carnage (smashing cars, wrecking cops). Driving clean lets
// it cool off early on, but late-game pressure outpaces the cooldown.
function addHeat(v) { G.heat = clamp(G.heat + v, 0, 100); if (v > 0) G.smashT = 1.6; }

function updateHeat(dt) {
  if (G.crashed) return;
  const d = difficulty();
  // Heat model: a suspicion "floor" rises over the run (you can never look fully
  // innocent late game). Carnage spikes heat above the floor; driving clean cools
  // back DOWN TO the floor; while cops are actively on you the chase escalates.
  const floor = lerp(0, 50, d);
  G.smashT = Math.max(0, G.smashT - dt);
  const contact = cops.some(k => k.state === 'chase' && Math.abs(k.y - player.y) < H * 0.5);
  if (G.heat < floor) G.heat = Math.min(floor, G.heat + 4 * dt);
  else if (contact) G.heat = Math.min(100, G.heat + 1.5 * dt);
  else if (G.smashT <= 0) G.heat = Math.max(floor, G.heat - 3.5 * dt);
  G.heat = clamp(G.heat, 0, 100);

  const wanted = Math.floor(G.heat / 20);                 // 0..5 stars
  if (wanted >= 1 && G.wanted === 0) { showBanner('🚨 POLICE ON YOUR TAIL 🚨', '', 2.2); A.alarm(); }
  if (wanted === 0 && G.wanted >= 1) { for (const k of cops) if (k.state === 'chase') k.state = 'retreat'; }
  G.wanted = wanted;

  // escape: hold every cruiser out of contact range long enough and you shed one
  // wanted level. Each level demands a longer hold, so escapes get progressively
  // harder — but the requirement is always finite, so a getaway is never impossible.
  // Brief re-contact bleeds progress instead of wiping it.
  const holdReq = 2.2 + wanted * 1.1;             // L1 3.3s … L5 7.7s
  if (wanted > 0 && cops.length > 0 && !contact) {
    G.escapeT += dt;
    if (G.escapeT >= holdReq) {
      G.escapeT = 0;
      G.heat = Math.max(0, G.heat - 24);          // shed one level (and a bit)
      G.copSpawnCd = 5;                            // they need time to find you again
      G.chasesEscaped++;
      const b = Math.round((500 + 400 * wanted) * comboMult());
      G.score += b;
      showBanner(G.heat < 20 ? `LOST THEM  +${b}` : `DROPPED A LEVEL  +${b}`, 'good', 2.2);
      addPopup(player.x, player.y - 70, `+${b}`, '#58e88b');
    }
  } else G.escapeT = Math.max(0, G.escapeT - dt * 2.5);

  // reinforcements: cops only call backup while they can see you.
  // At 3+ stars, dispatch coordinates ambushes ahead even when you've dropped them.
  const target = Math.min(wanted, 4);
  const active = cops.filter(k => k.state === 'chase').length;
  G.copSpawnCd -= dt;
  if (active < target && G.copSpawnCd <= 0) {
    if (active === 0) { spawnCop(0); G.copSpawnCd = lerp(2.6, 0.9, d); }
    else if (contact) {
      if (wanted >= 3 && chance(0.4)) spawnAmbushCop();
      else spawnCop(chance(0.5) ? -1 : 1);
      G.copSpawnCd = lerp(2.6, 0.9, d);
    } else if (wanted >= 3) { spawnAmbushCop(); G.copSpawnCd = 4.5; }
  } else if (active > target) {
    const k = cops.find(c => c.state === 'chase'); if (k) k.state = 'retreat';
  }
  // siren follows actual pursuit, not the abstract wanted level
  A.setSiren(cops.some(k => k.state === 'chase'));
  A.updateSiren(dt);
}

function updateCops(dt, sdt) {
  for (let i = cops.length - 1; i >= 0; i--) {
    const p = cops[i];
    p.lightPhase += dt * 6;
    if (p.hitCd > 0) p.hitCd -= dt;
    if (p.pushVX) { p.x += p.pushVX * dt; p.pushVX *= 1 - Math.min(1, dt * 3); }

    if (p.state === 'chase') {
      const aggr = 0.7 + G.wanted * 0.18;            // higher wanted = more aggressive lunges
      const targetY = player.y + player.h * 1.05;
      const closing = p.y > targetY ? 26 : (chance(aggr * dt) ? 55 + G.wanted * 8 : 10);
      const want = player.speed + closing;
      p.speed += clamp(want - p.speed, -70 * dt, 55 * dt);
      // cruisers have a top speed: full nitro simply outruns them
      p.speed = Math.min(p.speed, cruiseSpeed() * (1.1 + G.wanted * 0.04));
      p.y += (player.speed - p.speed) * PK * sdt;
      // outrun cops trail at a distance (well out of contact range) instead of vanishing
      p.y = Math.min(p.y, player.y + H * 0.66);

      // steer toward player, dodge traffic
      let tx = player.x;
      for (const v of vehicles) {
        if (v.burnT) continue;
        const dy = p.y - (v.y + v.h / 2);
        if (dy > 0 && dy < 240 && Math.abs(v.x - p.x) < (v.w + p.w) / 2 + 14) { tx = v.x > p.x ? p.x - road.laneW : p.x + road.laneW; break; }
      }
      const steer = road.laneW * 2.4;
      p.x += clamp(tx - p.x, -steer * dt, steer * dt);
      p.x = clamp(p.x, road.x + p.w / 2, road.x + road.w - p.w / 2);
      p.rot = clamp((tx - p.x) * 0.002, -0.1, 0.1);

      // cop hits traffic → spins out
      if (p.y < H - 10) {
        for (const v of vehicles) {
          if (!v.burnT && rectHit(p, v, 4)) { copSpin(p); burst(p.x, p.y, 14, '#9fb6ff'); A.bump(); break; }
        }
      }

      // contact with player
      if (!G.crashed && p.hitCd <= 0 && rectHit(p, player, 4)) {
        p.hitCd = 0.3;
        const dx = player.x - p.x, dy = player.y - p.y;
        const ox = (p.w + player.w) / 2 - Math.abs(dx);
        const oy = (p.h + player.h) / 2 - Math.abs(dy);
        burst((player.x + p.x) / 2, (player.y + p.y) / 2, 12, '#9fb6ff');
        if (ox < oy) {
          // PIT: chips your car, and slides you off the road once you're already slowed
          const dir = dx >= 0 ? 1 : -1;
          const slowed = player.speed < cruiseSpeed() * 0.72;
          shovePlayer(dir, road.laneW * (slowed ? 11 : 4.5), 'police', slowed);
          if (!slowed) damagePlayer(4, 'police');
          p.x -= dir * ox * 0.5; p.pushVX = -dir * road.laneW * 1.2;
          if (G.ramT > 0 || G.nitroOn) damageCop(p, 55);
          A.bump();
        } else if (dy < 0) {
          // rammed from behind: nudge forward + a small dent (never fatal on its own)
          p.y = player.y + (p.h + player.h) / 2 + 2; p.speed = Math.max(0, p.speed - 30);
          player.speed = Math.max(cruiseSpeed() * 0.55, player.speed - 12);
          player.bumpT = 0.12;
          damagePlayer(3, 'police');
          if (G.ramT > 0) damageCop(p, 30);
          A.bump();
        } else {
          // we ram the cop ahead
          p.y = player.y - (p.h + player.h) / 2 - 2; p.speed += 25;
          damageCop(p, (G.ramT > 0 || G.nitroOn ? 60 : 34));
          player.speed = Math.max(cruiseSpeed() * 0.6, player.speed - 8);
          A.bump();
        }
      }
    } else if (p.state === 'spin') {
      p.spinT += dt; p.rot += dt * 9; p.speed = Math.max(0, p.speed - 120 * dt);
      p.y += (player.speed - p.speed) * PK * sdt;
    } else {
      p.speed = Math.max(0, player.speed - 40);
      p.y += (player.speed - p.speed) * PK * sdt + 60 * sdt;
    }
    if ((p.state !== 'chase' && p.y > H + 420) || p.y < -640) cops.splice(i, 1);
  }
}
function copSpin(p) { if (p.state === 'chase') p.state = 'spin'; }
function damageCop(p, dmg) {
  if (p.state !== 'chase') return;
  p.hp -= dmg;
  if (p.hp <= 0) {
    p.state = 'spin';
    igniteAt(p.x, p.y, '#9fb6ff');
    A.explode();
    G.wrecked++;
    addHeat(12);                                  // wrecking a cop enrages the rest
    const b = Math.round(1500 * comboMult());
    G.score += b;
    addPopup(p.x, p.y - 60, `COP WRECKED +${b}`, '#4ae0ff');
  }
}

// ---------- road events ----------
const EVENT_DEFS = [
  { id: 'roadworks', min: 0.0 },
  { id: 'breakdown', min: 0.0 },
  { id: 'oil', min: 0.05 },
  { id: 'debris', min: 0.05 },
  { id: 'fog', min: 0.1 },
  { id: 'rain', min: 0.1 },
  { id: 'tunnel', min: 0.15 },
  { id: 'bridge', min: 0.2 },
  { id: 'congestion', min: 0.25 },
  { id: 'roadblock', min: 0.3 },
];
const EVENT_NAMES = {
  roadworks: '⚠ ROADWORKS AHEAD', breakdown: '⚠ STALLED VEHICLE', oil: '⚠ OIL SPILL AHEAD',
  debris: '⚠ DEBRIS ON ROAD', fog: '⚠ FOG BANK AHEAD', rain: '⚠ HEAVY RAIN', tunnel: 'TUNNEL AHEAD',
  bridge: '⚠ NARROW BRIDGE', congestion: '⚠ TRAFFIC JAM', roadblock: '🚨 POLICE ROADBLOCK 🚨',
};
let groupSeq = 0;

function nextEventId() {
  const d = difficulty();
  if (!G.event.bag.length) G.event.bag = shuffle(EVENT_DEFS.filter(e => d >= e.min).map(e => e.id));
  return G.event.bag.pop();
}
function updateEvents(dt) {
  if (G.time < G.event.next || G.crashed) return;
  const d = difficulty();
  const id = nextEventId();
  G.event.next = G.time + lerp(15, 7, d) * rand(0.75, 1.3);
  showBanner(EVENT_NAMES[id], id === 'roadblock' ? '' : 'info', 2.0);
  setTimeout(() => { if (G.state === 'playing' && !G.crashed) triggerEvent(id); }, 1200);
}

function freeLaneNear(y0) {
  const free = [];
  for (let i = 0; i < LANES; i++) if (!laneBlocked(i, y0 - 1000, y0 + 400)) free.push(i);
  return free.length ? pick(free) : irand(0, LANES - 1);
}
function clearTraffic(lanes, yMin, yMax) {
  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i];
    if (lanes.includes(v.lane) && v.y > yMin && v.y < yMax) vehicles.splice(i, 1);
  }
}

function triggerEvent(id) {
  const topY = -H * 0.6;
  const lane = freeLaneNear(topY);
  if (id === 'roadworks') {
    const gid = 'g' + (groupSeq++);
    clearTraffic([lane], topY - 1000, topY + 200);
    obstacles.push({ type: 'worksign', x: laneX(lane), y: topY, w: road.laneW * 0.8, h: 26, solid: true, gid });
    for (let i = 1; i <= 8; i++)
      obstacles.push({ type: 'cone', x: laneX(lane) + rand(-6, 6), y: topY - i * 110, w: 16, h: 16, solid: true, gid });
  } else if (id === 'breakdown') {
    const T = TYPES[pick(['car', 'van'])];
    clearTraffic([lane], topY - 400, topY + 300);
    obstacles.push({ type: 'wreck', x: laneX(lane), y: topY, w: road.laneW * T.w, h: road.laneW * T.h, solid: true, color: pick(CAR_COLORS), blink: 0 });
  } else if (id === 'oil') {
    obstacles.push({ type: 'oil', x: laneX(lane) + rand(-12, 12), y: topY, w: road.laneW * 1.15, h: road.laneW * 1.5, solid: false });
  } else if (id === 'debris') {
    for (let i = 0; i < irand(3, 6); i++)
      obstacles.push({ type: 'cone', x: laneX(lane) + rand(-road.laneW * 0.3, road.laneW * 0.3), y: topY - i * rand(50, 130), w: 15, h: 15, solid: true });
  } else if (id === 'fog' || id === 'rain' || id === 'tunnel') {
    G.weather = { type: id, t: 0, dur: id === 'tunnel' ? 8 : 10 };
  } else if (id === 'bridge') {
    const len = H * 1.6;
    clearTraffic([0, LANES - 1], topY - len - 200, topY + 300);
    obstacles.push({ type: 'barrier', x: laneX(0), y: topY - len / 2, w: road.laneW * 0.8, h: len, solid: true });
    obstacles.push({ type: 'barrier', x: laneX(LANES - 1), y: topY - len / 2, w: road.laneW * 0.8, h: len, solid: true });
  } else if (id === 'congestion') {
    G.congestT = 4.5;
  } else if (id === 'roadblock') {
    const gap = freeLaneNear(topY);
    const gid = 'g' + (groupSeq++);
    groups[gid] = { bonus: 600, done: false };
    const blocked = [];
    for (let i = 0; i < LANES; i++) if (i !== gap) blocked.push(i);
    clearTraffic(blocked, topY - 400, topY + 300);
    for (const i of blocked)
      obstacles.push({ type: 'copcar', x: laneX(i), y: topY, w: road.laneW * 0.92, h: road.laneW * 0.55, solid: true, gid, lightPhase: rand(0, 2) });
  }
}

// ---------- scoring / physics ----------
function comboMult() { return (1 + G.combo * 0.25) * (G.multT > 0 ? 2 : 1); }
function rectHit(a, b, shrink = 6) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - shrink &&
         Math.abs(a.y - b.y) < (a.h + b.h) / 2 - shrink;
}

function consumeShield() {
  G.shield = false; G.shake = 10;
  burst(player.x, player.y, 20, '#4ae0ff');
  A.thud();
  addPopup(player.x, player.y - 60, 'SHIELD DOWN', '#4ae0ff');
}

// lateral shove. A "hard" shove disables the road clamp so momentum can carry
// the player onto the grass (a wreck). Soft shoves just bump you around.
function shovePlayer(dir, force, cause, hard) {
  if (G.crashed) return;
  if (G.shield) { consumeShield(); player.vx = dir * road.laneW * 2; return; }
  player.vx = dir * force;
  if (hard) { player.shoveT = Math.max(player.shoveT, 0.5); G._shoveCause = cause; }
  player.speed = Math.max(cruiseSpeed() * 0.5, player.speed - 18);
  G.combo = 0;
  G.shake = Math.max(G.shake, hard ? 12 : 7);
}

// collisions grind down the car's integrity; hitting zero ends the run
function damagePlayer(dmg, cause) {
  if (G.crashed || G.debug.god) return;
  if (G.shield && dmg >= 8) { consumeShield(); return; }
  G.integrity = Math.max(0, G.integrity - dmg);
  G.shake = Math.max(G.shake, Math.min(16, 4 + dmg * 0.4));
  if (G.integrity <= 0) crash(cause);
}

// player wrecks a traffic vehicle
function igniteVehicle(v, dirX) {
  if (v.burnT) return;
  v.burnT = 1.3;
  v.spin = rand(-6, 6) * (dirX || 1);
  v.pushVX = (dirX || (chance(0.5) ? 1 : -1)) * road.laneW * rand(1.5, 3);
  v.speed *= 0.5;
  igniteAt(v.x, v.y, v.color);
  A.explode();
  G.wrecked++;
  addHeat(6);                                   // carnage draws the cops
  const b = Math.round(180 * comboMult());
  G.score += b;
  addPopup(v.x, v.y - 30, `SMASHED +${b}`, '#ff9346');
}
// player smashing through a car damages the player's car too (unless bulldozing)
function playerSmash(v, dirX) {
  if (G.ramT <= 0) damagePlayer(v.type === 'van' ? 15 : 11, 'traffic');
  igniteVehicle(v, dirX);
}
function igniteAt(x, y, color) {
  burst(x, y, 26, color || '#ff9346');
  burst(x, y, 16, '#ffd24a');
  for (let i = 0; i < 8; i++) particles.push({ x, y, vx: rand(-40, 40), vy: rand(-60, 40), life: rand(0.5, 1), t: 0, size: rand(6, 12), color: pick(['#ff7a2a', '#ffd24a', '#ff4a2a']), fire: true });
}

function crash(what) {
  if (G.debug.god || G.crashed) return;
  G.crashCause = what;
  G.crashed = true; G.crashT = 0;
  G.shake = 22; G.nitroOn = false;
  igniteAt(player.x, player.y, '#ff9346');
  burst(player.x, player.y, 40, '#ffd24a');
  A.crash();
  A.setSkid(false); A.setSiren(false);
}

function nearMiss(v) {
  v.missed = true;
  G.nearMisses++;
  G.combo = Math.min(G.combo + 1, 12);
  G.comboT = 5;
  const bonus = Math.round(100 * comboMult());
  G.score += bonus;
  G.nitro = Math.min(100, G.nitro + 12);
  addPopup(v.x, v.y, `NEAR MISS +${bonus}`, '#4ae0ff');
  A.whoosh();
  if (!v.honked && chance(0.3)) { v.honked = true; A.horn(); }
  const el = $('combo');
  el.classList.add('pop'); setTimeout(() => el.classList.remove('pop'), 140);
}

// ---------- fx ----------
function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    if (particles.length > 460) break;
    const a = rand(0, Math.PI * 2), s = rand(40, 340);
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.4, 1), t: 0, size: rand(2, 6), color });
  }
}
function addPopup(x, y, text, color) { popups.push({ x: clamp(x, 70, W - 70), y, text, color, t: 0 }); }
function addSkid(x, y) { if (skids.length > 260) skids.splice(0, 20); skids.push({ x, y, a: 0.5 }); }

// ---------- pickups ----------
function applyPickup(p) {
  A.pickupSfx();
  if (p.type === 'nitro') { G.nitro = Math.min(100, G.nitro + 60); G.score += Math.round(150 * comboMult()); addPopup(p.x, p.y, 'NITRO +60', '#4ae0ff'); }
  else if (p.type === 'shield') { G.shield = true; G.score += Math.round(150 * comboMult()); addPopup(p.x, p.y, 'SHIELD', '#4ae0ff'); }
  else if (p.type === 'mult') { G.multT = 12; addPopup(p.x, p.y, 'SCORE ×2', '#ffd24a'); }
  else if (p.type === 'ram') { G.ramT = 7; addPopup(p.x, p.y, 'BULLDOZER', '#ff7a2a'); }
  else if (p.type === 'cash') { const b = Math.round(1000 * comboMult()); G.score += b; addPopup(p.x, p.y, `+${b}`, '#ffd24a'); }
  else if (p.type === 'repair') { G.integrity = Math.min(100, G.integrity + 40); addPopup(p.x, p.y, 'REPAIRED +40', '#58e88b'); burst(player.x, player.y, 14, '#58e88b'); }
  else if (p.type === 'jammer') {
    addPopup(p.x, p.y, 'JAMMER', '#b06ae0');
    if (G.wanted > 0 || cops.length) {
      for (const k of cops) if (k.state === 'chase') copSpin(k);
      G.heat = 0; G.wanted = 0; A.setSiren(false); hideBanner();
    }
  }
  burst(p.x, p.y, 12, '#ffffff');
}

// ---------- update ----------
function update(dt) {
  const d = difficulty();
  G.time += dt;
  const sdt = dt * (G.crashed ? 0.3 : 1);

  G.multT = Math.max(0, G.multT - dt);
  G.ramT = Math.max(0, G.ramT - dt);
  G.oilT = Math.max(0, G.oilT - dt);
  G.congestT = Math.max(0, G.congestT - dt);
  G.shake = Math.max(0, G.shake - dt * 30);
  if (G.weather.type) { G.weather.t += dt; if (G.weather.t > G.weather.dur) G.weather = { type: '', t: 0, dur: 0 }; }
  // stay bright for the first ~40s, then a slow dusk→night→dawn cycle
  G.night = clamp((0.5 - 0.5 * Math.cos(Math.PI * 2 * (G.time - 40) / 320)) * (G.time > 40 ? 1 : 0), 0, 1);

  // terrain theme progression
  if (G.time >= G.theme.nextAt) {
    G.theme.idx = (G.theme.idx + 1) % THEMES.length;
    G.theme.blend = 0;
    G.theme.nextAt = G.time + rand(32, 48);
  }
  if (G.theme.blend < 1) G.theme.blend = Math.min(1, G.theme.blend + dt / 2.5);

  if (G.crashed) {
    G.crashT += dt;
    updateCops(dt, sdt); moveWorld(sdt); updatePickups(dt, sdt); updateFx(dt, sdt);
    A.updateEngine(0, false, false);
    if (G.crashT > 1.6) gameOver();
    return;
  }

  // --- speed: always fast, only nitro raises it; collisions knock it down ---
  const cruise = cruiseSpeed();
  const wantNitro = input.nitro && (G.nitroOn ? G.nitro > 0 : G.nitro > 8);
  if (wantNitro && !G.nitroOn) { G.nitroOn = true; A.nitroBurst(); }
  if (!wantNitro) G.nitroOn = false;
  if (G.nitroOn) G.nitro = Math.max(0, G.nitro - 24 * dt);
  else G.nitro = Math.min(100, G.nitro + 4 * dt);

  // a battered car is slower and sluggish (and thus easier for cops to catch)
  const integ = G.integrity / 100;
  const dmgSpeed = lerp(0.68, 1, integ);
  const target = cruise * (G.nitroOn ? NITRO_MULT : 1) * dmgSpeed;
  const accel = G.nitroOn ? 170 : 115;
  if (player.speed < target) player.speed = Math.min(target, player.speed + accel * dt);
  else player.speed = Math.max(target, player.speed - 40 * dt);
  player.speed = Math.max(player.speed, cruise * 0.45 * dmgSpeed); // recover after a bump
  G.topSpeed = Math.max(G.topSpeed, player.speed);
  if (player.bumpT > 0) player.bumpT -= dt;

  // --- steering ---
  const slip = (G.oilT > 0 ? 0.4 : (G.weather.type === 'rain' ? 0.82 : 1)) * lerp(0.78, 1, integ);
  const steerMax = road.laneW * 4.6 * (G.nitroOn ? 1.2 : 1);
  let steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  const driveMin = road.x + player.w / 2 + 2, driveMax = road.x + road.w - player.w / 2 - 2;
  const offMin = road.x - player.w * 0.35, offMax = road.x + road.w + player.w * 0.35;

  if (player.shoveT > 0) {
    // being shoved: momentum can carry us off the road; steering still fights it
    player.shoveT -= dt;
    player.vx += (steer * steerMax - player.vx) * Math.min(1, dt * 5);
    player.vx *= 1 - Math.min(1, dt * 1.6);
    player.x += player.vx * dt;
    if (G.oilT > 0) player.x += Math.sin(G.time * 13) * road.laneW * 1.4 * dt * 8;
    if (player.x < offMin || player.x > offMax) { crash(G._shoveCause || 'offroad'); return; }
  } else {
    const targetVX = steer * steerMax;
    player.vx += (targetVX - player.vx) * Math.min(1, dt * 9 * slip);
    if (G.oilT > 0) player.vx += Math.sin(G.time * 13) * road.laneW * 1.6 * dt * 8;
    player.x += player.vx * dt;
    if (input.drag) { player.x += input.drag * 1.35 * slip; player.vx = input.drag * 22 * slip; input.drag = 0; }
    if (player.x < driveMin) { player.x = driveMin; if (player.vx < 0) player.vx *= -0.25; }
    if (player.x > driveMax) { player.x = driveMax; if (player.vx > 0) player.vx *= -0.25; }
  }
  player.tilt = clamp(player.vx / steerMax, -1, 1) * 0.14;

  // skids
  const hardSteer = Math.abs(player.vx) > steerMax * 0.7;
  const skidding = G.oilT > 0 || player.shoveT > 0 || (hardSteer && !G.nitroOn);
  if (skidding) { addSkid(player.x - player.w * 0.3, player.y + player.h * 0.42); addSkid(player.x + player.w * 0.3, player.y + player.h * 0.42); }
  A.setSkid(skidding);

  // combo upkeep
  G.comboT -= dt;
  if (G.comboT <= 0) G.combo = 0;

  // score / distance
  const rate = player.speed * 0.55 * comboMult() * (G.nitroOn ? 1.5 : 1);
  G.score += rate * dt;
  G.dist += player.speed / 3.6 * dt;

  // spawns — dense
  G.spawnT -= sdt * (G.congestT > 0 ? 4 : 1);
  if (G.spawnT <= 0) {
    if (d > 0.08 && chance(lerp(0.3, 0.65, d))) spawnCluster();
    else { spawnVehicle(); if (chance(lerp(0.5, 0.95, d))) spawnVehicle(); }
    G.spawnT = lerp(0.85, 0.28, d) * rand(0.7, 1.2);
  }
  G.pickupT -= dt;
  if (G.pickupT <= 0) { spawnPickup(); G.pickupT = rand(6, 11); }

  updateTraffic(dt, sdt, d);
  updateHeat(dt);
  updateCops(dt, sdt);
  updateEvents(dt);
  moveWorld(sdt);
  updatePickups(dt, sdt);
  updateFx(dt, sdt);

  A.updateEngine(player.speed, G.nitroOn, true);
  updateHUD();
}

function updateTraffic(dt, sdt, d) {
  const laneChangeRate = lerp(0.08, 0.5, d);
  const brakeRate = lerp(0.04, 0.22, d);

  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i];

    // burning wreck: spin off and fade
    if (v.burnT) {
      v.burnT -= dt;
      v.rot += v.spin * dt;
      v.x += v.pushVX * dt; v.pushVX *= 1 - Math.min(1, dt * 1.5);
      v.speed = Math.max(0, v.speed - 60 * dt);
      v.y += (player.speed - v.speed) * PK * sdt;
      if (chance(20 * dt) && particles.length < 440)
        particles.push({ x: v.x + rand(-v.w / 3, v.w / 3), y: v.y + rand(-v.h / 3, v.h / 3), vx: rand(-30, 30), vy: rand(-50, 10), life: rand(0.4, 0.9), t: 0, size: rand(5, 11), color: pick(['#ff7a2a', '#ffd24a', '#555']), fire: true });
      if (v.burnT <= 0 || v.y > H + 300) vehicles.splice(i, 1);
      continue;
    }

    v.brakeLight = false;
    // follow vehicle ahead; never tuck under it
    for (const u of vehicles) {
      if (u === v || u.burnT || u.lane !== v.lane) continue;
      if (u.y >= v.y) continue;
      const gap = v.y - u.y - (u.h + v.h) / 2;   // bumper-to-bumper distance
      if (gap < 90) {
        if (v.speed > u.speed) { v.speed = u.speed; v.brakeLight = true; }
        if (gap < 6) { v.y = u.y + (u.h + v.h) / 2 + 8; v.speed = Math.min(v.speed, u.speed * 0.95); }
      }
    }
    // react to solid obstacles
    for (const o of obstacles) {
      if (!o.solid) continue;
      if (Math.abs(o.x - v.x) > (o.w + v.w) / 2 + 10) continue;
      const dy = v.y - (o.y + o.h / 2 + v.h / 2);
      if (dy < -10 || dy > 340) continue;
      let dodged = false;
      if (v.state === 'cruise') {
        for (const dir of [1, -1]) {
          const nl = v.lane + dir;
          if (nl >= 0 && nl < LANES && !laneBlocked(nl, v.y - 380, v.y + 260)) { v.state = 'changing'; v.targetLane = nl; v.blinker = dir; dodged = true; break; }
        }
      }
      if (!dodged && dy < 220) { v.speed = Math.max(0, v.speed - 140 * dt); v.brakeLight = true; }
      break;
    }
    // random braking
    if (v.brakeT > 0) { v.brakeT -= dt; v.speed = Math.max(v.speed - 60 * dt, v.baseSpeed * 0.5); v.brakeLight = true; }
    else if (v.state === 'cruise' && chance(brakeRate * dt)) { v.brakeT = rand(0.7, 1.7); }
    else if (v.speed < v.baseSpeed) v.speed = Math.min(v.baseSpeed, v.speed + 30 * dt);

    // lane changes
    if (v.state === 'cruise' && v.type !== 'truck' && v.type !== 'bus' && chance(laneChangeRate * dt) && v.y > -100 && v.y < player.y - 180) {
      const dir = chance(0.5) ? -1 : 1, nl = v.lane + dir;
      if (nl >= 0 && nl < LANES && !laneBlocked(nl, v.y - 300, v.y + 300)) { v.state = 'changing'; v.targetLane = nl; v.blinker = dir; }
    }
    if (v.state === 'changing') {
      const tx = laneX(v.targetLane);
      v.x += clamp(tx - v.x, -road.laneW * 1.1 * sdt, road.laneW * 1.1 * sdt);
      if (Math.abs(tx - v.x) < 2) { v.x = tx; v.lane = v.targetLane; v.state = 'cruise'; v.blinker = 0; }
    }
    // residual push from a glancing hit
    if (v.pushVX) {
      v.x += v.pushVX * dt; v.pushVX *= 1 - Math.min(1, dt * 3);
      if (v.state !== 'changing') v.lane = clamp(Math.round((v.x - road.x) / road.laneW - 0.5), 0, LANES - 1);
    }
    if (v.spin) { v.rot += v.spin * dt; v.spin *= 1 - Math.min(1, dt * 4); if (Math.abs(v.spin) < 0.05) v.spin = 0; }
    else if (v.rot) v.rot *= 1 - Math.min(1, dt * 5);

    v.y += (player.speed - v.speed) * PK * sdt;

    // pushed off the road → wreck
    if (v.x < road.x + v.w * 0.2 || v.x > road.x + road.w - v.w * 0.2) {
      if (Math.abs(v.pushVX) > 30 || v.spin) { igniteVehicle(v, v.x < W / 2 ? -1 : 1); continue; }
    }

    // near-miss
    if (!v.missed && !G.crashed) {
      const vOverlap = Math.abs(v.y - player.y) < (v.h + player.h) / 2 + 12;
      if (vOverlap) { v.overlap = true; const gap = Math.abs(v.x - player.x) - (v.w + player.w) / 2; v.minGap = Math.min(v.minGap, gap); }
      else if (v.overlap) { if (v.minGap < 30 && v.minGap > -900 && Math.abs(player.speed - v.speed) > 15) nearMiss(v); v.overlap = false; v.missed = true; }
    }

    // contact with player
    if (v.hitCd > 0) v.hitCd -= dt;
    if (!G.crashed && v.hitCd <= 0 && rectHit(v, player, 4)) {
      v.hitCd = 0.3; v.missed = true;
      const dx = player.x - v.x, dy = player.y - v.y;
      const ox = (v.w + player.w) / 2 - Math.abs(dx);
      const oy = (v.h + player.h) / 2 - Math.abs(dy);
      const heavy = v.type === 'truck' || v.type === 'bus';
      const dir = dx >= 0 ? 1 : -1;

      // bulldozer smashes anything on contact
      if (G.ramT > 0) { igniteVehicle(v, -dir); continue; }

      burst((player.x + v.x) / 2, (player.y + v.y) / 2, 8, '#ffd24a');
      A.bump();
      if (ox < oy) {
        // side swipe: fully separate the two cars, both deflect, other car spins away
        const sep = ox + 1;
        player.x += dir * sep * 0.55; v.x -= dir * sep * 0.45;
        player.vx = dir * (Math.abs(player.vx) * 0.3 + road.laneW * 1.2);
        player.speed = Math.max(cruiseSpeed() * 0.55, player.speed - (heavy ? 22 : 10));
        v.pushVX = -dir * road.laneW * (heavy ? 1.2 : 2.6);
        v.spin = -dir * rand(2, 5) * (heavy ? 0.3 : 1);
        v.state = 'cruise'; v.blinker = 0; v.hitCd = 0.4;
        damagePlayer(heavy ? 4 : 2, 'traffic');
      } else if (dy > 0) {
        // rammed the car ahead
        const rel = Math.max(0, player.speed - v.speed);
        if (heavy && rel > 40) {
          // slamming the back of a truck/bus at speed: heavy damage + hard stop (survivable if healthy)
          damagePlayer(46, 'traffic');
          player.speed = Math.max(cruiseSpeed() * 0.35, player.speed * 0.4);
          v.y = player.y - (v.h + player.h) / 2 - 3; v.speed = Math.max(v.speed, player.speed);
          player.bumpT = 0.2;
        } else {
          // knock it clear ahead and set it spinning/veering by where we hit it
          v.y = player.y - (v.h + player.h) / 2 - 3;
          v.speed = Math.max(v.speed, player.speed);        // lurches to our speed so it pulls away (no overlap)
          v.baseSpeed = Math.max(v.baseSpeed, v.speed);
          v.spin = dir * rand(3, 7);
          v.pushVX = dir * road.laneW * rand(1.4, 2.6);
          v.state = 'cruise'; v.blinker = 0; v.hitCd = 0.4; v.missed = true;
          player.speed = Math.max(cruiseSpeed() * 0.55, player.speed - rel * 0.3 - 8);
          player.bumpT = 0.12;
          // explode only on a boosted or genuinely high-speed hit, otherwise just shove it
          if (!heavy && (G.nitroOn || rel > 140)) playerSmash(v, dir);
          else damagePlayer(heavy ? 5 : 3, 'traffic');
        }
      } else {
        // rear-ended by faster traffic (rare)
        v.speed = Math.min(v.speed, player.speed * 0.8);
        v.y = player.y + (v.h + player.h) / 2 + 3;
        damagePlayer(2, 'traffic');
      }
    }

    if (v.y > H + 300 || v.y < -H * 1.8) vehicles.splice(i, 1);
  }

  // un-stick pass: no two vehicles may ride glued together
  for (let a = 0; a < vehicles.length; a++) {
    const u = vehicles[a];
    if (u.burnT) continue;
    for (let b = a + 1; b < vehicles.length; b++) {
      const w = vehicles[b];
      if (w.burnT || !rectHit(u, w, 2)) continue;
      const need = (u.h + w.h) / 2 + 8;
      const dy = u.y - w.y, s = dy >= 0 ? 1 : -1;
      const push = (need - Math.abs(dy)) / 2;
      if (push > 0) { u.y += s * push; w.y -= s * push; }
      const slow = Math.min(u.speed, w.speed);
      if (s > 0) u.speed = slow; else w.speed = slow;   // the one behind matches speed
    }
  }
}

function moveWorld(sdt) {
  const scroll = player.speed * PK * sdt;
  G.lampOff = (G.lampOff + scroll) % 300;

  for (const s of scenery) {
    s.y += scroll;
    if (s.y > H + 140) { const ns = makeSceneryItem(s.side, -rand(30, 110)); Object.assign(s, ns); }
  }
  for (let i = skids.length - 1; i >= 0; i--) { const k = skids[i]; k.y += scroll; k.a -= sdt * 0.25; if (k.a <= 0 || k.y > H + 40) skids.splice(i, 1); }
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.y += scroll;
    if (o.blink !== undefined) o.blink += sdt * 4;
    if (o.lightPhase !== undefined) o.lightPhase += sdt * 6;
    if (o.hitCd > 0) o.hitCd -= 1 / 60;
    if (!G.crashed) {
      if (o.type === 'oil') {
        if (rectHit(o, player, 4) && G.oilT <= 0) { G.oilT = 2.2; A.setSkid(true); addPopup(player.x, player.y - 60, 'OIL SLICK!', '#e8b64a'); }
      } else if (o.solid && (o.hitCd || 0) <= 0 && rectHit(o, player, o.type === 'cone' ? 2 : 5)) {
        if (o.type === 'cone') { burst(o.x, o.y, 10, '#ff7a2a'); A.noiseHit(0.14, 0.2, 600, 0.6); player.speed = Math.max(cruiseSpeed() * 0.7, player.speed - 6); damagePlayer(2, 'offroad'); obstacles.splice(i, 1); continue; }
        // bulldozer plows a stalled car aside
        if (G.ramT > 0 && o.type === 'wreck') { igniteAt(o.x, o.y, o.color); A.explode(); G.score += Math.round(200 * comboMult()); obstacles.splice(i, 1); continue; }
        o.hitCd = 0.5;
        const dx = player.x - o.x, dy = player.y - o.y;
        const ox = (o.w + player.w) / 2 - Math.abs(dx);
        const oy = (o.h + player.h) / 2 - Math.abs(dy);
        const dir = dx >= 0 ? 1 : -1;
        burst(player.x - dir * player.w / 2, player.y, 14, '#ffd24a');
        A.bump();
        if (oy < ox && player.speed > cruiseSpeed() * 0.5) {
          // head-on into a solid wall / car / roadblock at speed: heavy damage + hard stop
          player.speed = Math.max(cruiseSpeed() * 0.35, player.speed * 0.4);
          damagePlayer(o.type === 'copcar' ? 30 : 44, o.type === 'copcar' ? 'police' : 'offroad');
        } else {
          // glancing scrape: big slow + soft shove, survivable
          player.speed = Math.max(cruiseSpeed() * 0.4, player.speed * 0.6);
          damagePlayer(6, 'offroad');
          shovePlayer(dir, road.laneW * 4.5, 'offroad', false);
        }
      }
      if (o.gid && groups[o.gid] && !groups[o.gid].done && o.y - o.h / 2 > player.y + player.h) {
        groups[o.gid].done = true;
        const b = Math.round(groups[o.gid].bonus * comboMult());
        G.score += b;
        addPopup(player.x, player.y - 80, `ROADBLOCK DODGED +${b}`, '#58e88b');
      }
    }
    if (o.y - o.h / 2 > H + 200) obstacles.splice(i, 1);
  }
}

function updatePickups(dt, sdt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    // never slide underneath slower traffic ahead: fall in line behind it
    for (const v of vehicles) {
      if (v.burnT) continue;
      if (Math.abs(v.x - p.x) < v.w / 2 + p.r && v.y < p.y && p.y - v.y < v.h / 2 + p.r + 60 && (p.speed || 0) > v.speed) { p.speed = v.speed * 0.96; break; }
    }
    p.y += (player.speed - (p.speed || 0)) * PK * sdt; p.t += dt;
    // lane drift only while still off screen; once you can see it, its lane is locked
    if (p.y < -60) {
      p.driftT -= dt;
      if (p.driftT <= 0) { p.driftT = rand(1.5, 3); p.driftLane = clamp(p.driftLane + (chance(0.5) ? -1 : 1), 0, LANES - 1); }
    }
    p.x += clamp(laneX(p.driftLane) - p.x, -road.laneW * 0.8 * dt, road.laneW * 0.8 * dt);
    // gentle magnet: a near line-up snaps in instead of slipping past
    if (Math.abs(p.y - player.y) < 220 && Math.abs(p.x - player.x) < road.laneW * 0.8)
      p.x += clamp(player.x - p.x, -road.laneW * 2.4 * dt, road.laneW * 2.4 * dt);
    if (!G.crashed && Math.abs(p.x - player.x) < p.r + player.w / 2 && Math.abs(p.y - player.y) < p.r + player.h / 2) { applyPickup(p); pickups.splice(i, 1); continue; }
    if (p.y > H + 60) pickups.splice(i, 1);
  }
}

function updateFx(dt, sdt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    p.x += p.vx * dt; p.y += p.vy * dt + player.speed * PK * sdt * (p.fire ? 0.3 : 0.5);
    p.vx *= (1 - dt * 2); p.vy *= (1 - dt * 2);
    if (p.fire) p.vy -= 40 * dt;
    if (p.t >= p.life) particles.splice(i, 1);
  }
  for (let i = popups.length - 1; i >= 0; i--) { const p = popups[i]; p.t += dt; p.y -= 40 * dt; if (p.t > 1.2) popups.splice(i, 1); }

  // engine smoke when the car is battered
  if (!G.crashed && G.integrity < 45 && particles.length < 400) {
    G.smokeT -= dt;
    if (G.smokeT <= 0) {
      G.smokeT = G.integrity < 20 ? 0.05 : 0.12;
      particles.push({ x: player.x + rand(-9, 9), y: player.y - player.h / 2 + 8, vx: rand(-16, 16), vy: rand(60, 130), life: rand(0.5, 0.95), t: 0, size: rand(6, 11), color: G.integrity < 20 ? '#2c2c34' : '#8d8d99' });
    }
  }

  // nitro exhaust
  if (G.nitroOn && !G.crashed && particles.length < 420) {
    for (let i = 0; i < 3; i++) {
      particles.push({
        x: player.x + (i - 1) * player.w * 0.22 + rand(-2, 2),
        y: player.y + player.h / 2 + 4,
        vx: rand(-18, 18), vy: rand(220, 380),
        life: rand(0.16, 0.34), t: 0, size: rand(4, 9), color: pick(['#4ae0ff', '#8af2ff', '#ffffff', '#ffd24a']), fire: false,
      });
    }
  } else if (!G.crashed && particles.length < 300 && chance(30 * dt)) {
    // idle exhaust puff
    particles.push({ x: player.x + rand(-player.w * 0.2, player.w * 0.2), y: player.y + player.h / 2 + 3, vx: rand(-8, 8), vy: rand(60, 120), life: rand(0.2, 0.4), t: 0, size: rand(2, 4), color: 'rgba(210,210,220,0.7)' });
  }
}

// ---------- render ----------
function render() {
  const nf = G.night, th = curTheme(), pth = prevTheme(), tb = G.theme.blend;
  const gTop = mixColor(pth.gTop, th.gTop, tb), gBot = mixColor(pth.gBot, th.gBot, tb);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, mixColor(gTop, '#101a14', nf));
  g.addColorStop(1, mixColor(gBot, '#0a140d', nf));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-G.shake, G.shake) * 0.5, rand(-G.shake, G.shake) * 0.5);

  drawScenery(nf);
  drawRoad(nf);
  drawSkids();
  drawObstaclesGround();
  drawVehicles(nf);
  drawPickups();
  drawCops(nf);
  if (!G.crashed || G.crashT < 0.15) drawPlayer(nf);
  drawParticles();
  drawWeather();
  drawNight(nf);
  drawStreaks();
  drawPopups();
  ctx.restore();
}

function mixColor(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const h = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(lerp(pa[0], pb[0], t))}${h(lerp(pa[1], pb[1], t))}${h(lerp(pa[2], pb[2], t))}`;
}

function drawScenery(nf) {
  const dark = 1 - nf * 0.55;
  for (const s of scenery) {
    const x = s.side === 0 ? road.x - s.off : road.x + road.w + s.off;
    if (x < -60 || x > W + 60) continue;
    const sz = s.size * road.laneW * 0.3;
    ctx.save(); ctx.translate(x, s.y);
    const D = v => Math.round(v * dark);
    if (s.kind === 'tree') {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(3, 4, sz, sz * 0.8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = `rgb(${D(40 + s.hue)},${D(110 + s.hue)},${D(52)})`; ctx.beginPath(); ctx.arc(0, 0, sz, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.09 * dark})`; ctx.beginPath(); ctx.arc(-sz * 0.3, -sz * 0.3, sz * 0.5, 0, 7); ctx.fill();
    } else if (s.kind === 'bush') {
      ctx.fillStyle = `rgb(${D(60)},${D(125 + s.hue)},${D(64)})`; ctx.beginPath(); ctx.arc(0, 0, sz * 0.55, 0, 7); ctx.arc(sz * 0.4, 2, sz * 0.4, 0, 7); ctx.fill();
    } else if (s.kind === 'rock') {
      ctx.fillStyle = `rgb(${D(130)},${D(130)},${D(135)})`; ctx.beginPath(); ctx.ellipse(0, 0, sz * 0.45, sz * 0.3, 0.3, 0, 7); ctx.fill();
    } else if (s.kind === 'cactus') {
      ctx.fillStyle = `rgb(${D(48)},${D(120)},${D(58)})`;
      ctx.fillRect(-sz * 0.14, -sz, sz * 0.28, sz * 1.5);
      ctx.fillRect(-sz * 0.5, -sz * 0.3, sz * 0.36, sz * 0.16);
      ctx.fillRect(-sz * 0.5, -sz * 0.44, sz * 0.16, sz * 0.4);
      ctx.fillRect(sz * 0.14, -sz * 0.5, sz * 0.36, sz * 0.16);
      ctx.fillRect(sz * 0.34, -sz * 0.7, sz * 0.16, sz * 0.36);
    } else if (s.kind === 'dune') {
      ctx.fillStyle = `rgb(${D(214)},${D(180)},${D(120)})`; ctx.beginPath(); ctx.ellipse(0, 4, sz * 1.3, sz * 0.5, 0, Math.PI, 0); ctx.fill();
    } else if (s.kind === 'palm') {
      ctx.strokeStyle = `rgb(${D(120)},${D(90)},${D(50)})`; ctx.lineWidth = sz * 0.18; ctx.beginPath(); ctx.moveTo(0, sz * 0.6); ctx.quadraticCurveTo(sz * 0.1, -sz * 0.2, sz * 0.3, -sz * 0.7); ctx.stroke();
      ctx.fillStyle = `rgb(${D(40)},${D(130)},${D(60)})`;
      for (let a = 0; a < 5; a++) { const ang = -Math.PI / 2 + (a - 2) * 0.5; ctx.save(); ctx.translate(sz * 0.3, -sz * 0.7); ctx.rotate(ang); ctx.beginPath(); ctx.ellipse(sz * 0.5, 0, sz * 0.55, sz * 0.14, 0, 0, 7); ctx.fill(); ctx.restore(); }
    } else if (s.kind === 'building') {
      const bh = sz * (2.4 + s.seed % 3), bw = sz * 1.4;
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(-bw / 2 + 4, -bh + 4, bw, bh);
      ctx.fillStyle = `rgb(${D(96 + (s.seed % 40))},${D(102)},${D(120)})`; ctx.fillRect(-bw / 2, -bh, bw, bh);
      for (let wy = -bh + 6; wy < -6; wy += 12) for (let wx = -bw / 2 + 5; wx < bw / 2 - 4; wx += 11) {
        const lit = nf > 0.3 && (s.seed + wx + wy) % 3 === 0;
        ctx.fillStyle = lit ? `rgba(255,220,140,${0.8})` : `rgba(${D(40)},${D(46)},${D(64)},1)`;
        ctx.fillRect(wx, wy, 6, 7);
      }
    } else if (s.kind === 'patch') { // soft tonal ground variation
      ctx.fillStyle = `rgba(0,0,0,${0.07 + (s.seed % 10) * 0.004})`;
      ctx.beginPath(); ctx.ellipse(0, 0, sz * (2.2 + s.seed % 2), sz * (1.1 + (s.seed * 7) % 1), s.seed, 0, 7); ctx.fill();
    } else if (s.kind === 'flower') {
      const cols = ['#e86a8a', '#f2d24a', '#c07ae8', '#f2f2f2'];
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = cols[(i + Math.floor(s.seed)) % cols.length];
        ctx.beginPath(); ctx.arc(Math.sin(s.seed + i * 2.4) * sz * 0.8, Math.cos(s.seed * 2 + i * 1.7) * sz * 0.6, 2.6, 0, 7); ctx.fill();
      }
    } else if (s.kind === 'pond') {
      ctx.fillStyle = `rgba(60,130,190,${0.85 * dark})`;
      ctx.beginPath(); ctx.ellipse(0, 0, sz * 1.6, sz * 0.9, 0.2, 0, 7); ctx.fill();
      ctx.strokeStyle = `rgba(200,230,255,${0.35 * dark})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, sz * 1.6, sz * 0.9, 0.2, 0, 7); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.18 * dark})`;
      ctx.beginPath(); ctx.ellipse(-sz * 0.4, -sz * 0.2, sz * 0.5, sz * 0.2, 0.3, 0, 7); ctx.fill();
    } else if (s.kind === 'scrub') {
      ctx.strokeStyle = `rgb(${D(140)},${D(120)},${D(70)})`; ctx.lineWidth = 1.6;
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.45; ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(Math.cos(a) * sz * 0.8, 4 + Math.sin(a) * sz * 0.8); ctx.stroke(); }
    } else { // sign
      ctx.fillStyle = `rgb(${D(110)},${D(115)},${D(125)})`; ctx.fillRect(-2, -18, 4, 22);
      ctx.fillStyle = s.hue > 0 ? `rgba(46,125,220,${dark})` : `rgba(30,140,70,${dark})`; ctx.fillRect(-10, -30, 20, 14);
    }
    ctx.restore();
  }

  // streetlights (night + city)
  const cityish = curTheme().name === 'city';
  const lampDark = 1 - nf * 0.4;
  for (let y = (G.lampOff % 300) - 300; y < H + 40; y += 300) {
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? road.x - 14 : road.x + road.w + 14, dir = side === 0 ? 1 : -1;
      ctx.strokeStyle = `rgba(${Math.round(150 * lampDark)},${Math.round(155 * lampDark)},${Math.round(165 * lampDark)},1)`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 26); ctx.lineTo(x + dir * 16, y - 30); ctx.stroke();
      if (nf > 0.25 || cityish) {
        ctx.fillStyle = `rgba(255,220,130,${Math.max(nf, 0.4) * 0.8})`; ctx.beginPath(); ctx.arc(x + dir * 16, y - 30, 3.5, 0, 7); ctx.fill();
        const lg = ctx.createRadialGradient(x + dir * 18, y - 10, 4, x + dir * 18, y - 10, 46);
        lg.addColorStop(0, `rgba(255,215,120,${Math.max(nf, 0.35) * 0.16})`); lg.addColorStop(1, 'rgba(255,215,120,0)');
        ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(x + dir * 18, y - 10, 46, 0, 7); ctx.fill();
      }
    }
  }
}

function drawRoad(nf) {
  // gravel shoulder strips just off the tarmac
  ctx.fillStyle = 'rgba(30,26,20,0.25)';
  ctx.fillRect(road.x - 22, 0, 16, H); ctx.fillRect(road.x + road.w + 6, 0, 16, H);
  ctx.fillStyle = mixColor('#494e57', '#23262e', nf); ctx.fillRect(road.x - 8, 0, road.w + 16, H);
  ctx.fillStyle = mixColor('#e8e8e8', '#8a8f9c', nf); ctx.fillRect(road.x - 2, 0, 4, H); ctx.fillRect(road.x + road.w - 2, 0, 4, H);
  // guardrail: continuous rail over the posts
  ctx.fillStyle = mixColor('#aeb4c0', '#565c6b', nf);
  ctx.fillRect(road.x - 26, 0, 2.5, H); ctx.fillRect(road.x + road.w + 24, 0, 2.5, H);
  for (let y = (G.lampOff % 90) - 90; y < H + 20; y += 90) { ctx.fillRect(road.x - 27, y, 4.5, 10); ctx.fillRect(road.x + road.w + 23, y, 4.5, 10); }
  // no lane dashes, just faint lane boundaries so lanes still read
  ctx.strokeStyle = `rgba(210,216,228,${0.09 * (1 - nf * 0.5)})`;
  ctx.lineWidth = 2;
  for (let i = 1; i < LANES; i++) { const x = road.x + road.laneW * i; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
}

function drawSkids() {
  ctx.fillStyle = '#1b1d22';
  for (const k of skids) { ctx.globalAlpha = k.a; ctx.fillRect(k.x - 2.5, k.y - 5, 5, 10); }
  ctx.globalAlpha = 1;
}

function drawObstaclesGround() {
  for (const o of obstacles) {
    if (o.y + o.h / 2 < -60 || o.y - o.h / 2 > H + 60) continue;
    ctx.save(); ctx.translate(o.x, o.y);
    if (o.type === 'oil') {
      ctx.fillStyle = 'rgba(16,16,24,0.82)'; ctx.beginPath(); ctx.ellipse(0, 0, o.w / 2, o.h / 2, 0.15, 0, 7); ctx.ellipse(o.w * 0.18, o.h * 0.2, o.w * 0.28, o.h * 0.2, -0.3, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(120,140,255,0.12)'; ctx.beginPath(); ctx.ellipse(-o.w * 0.1, -o.h * 0.1, o.w * 0.3, o.h * 0.22, 0.4, 0, 7); ctx.fill();
    } else if (o.type === 'cone') {
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(2, 3, 10, 6, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#ff7a2a'; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(9, 8); ctx.lineTo(-9, 8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(-6, -2, 12, 4);
    } else if (o.type === 'worksign') {
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(-o.w / 2 + 3, -10, o.w, 24);
      const stripes = ctx.createLinearGradient(-o.w / 2, 0, o.w / 2, 0);
      for (let i = 0; i <= 8; i++) stripes.addColorStop(i / 8, i % 2 ? '#ff8a2a' : '#ffffff');
      ctx.fillStyle = stripes; ctx.fillRect(-o.w / 2, -13, o.w, 26);
      ctx.strokeStyle = '#933f00'; ctx.lineWidth = 2; ctx.strokeRect(-o.w / 2, -13, o.w, 26);
    } else if (o.type === 'barrier') {
      ctx.fillStyle = '#c9cdd6'; ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
      ctx.fillStyle = '#9298a5'; ctx.fillRect(-o.w / 2, -o.h / 2, 6, o.h); ctx.fillRect(o.w / 2 - 6, -o.h / 2, 6, o.h);
      const sy = o.h / 2 - 18, st = ctx.createLinearGradient(-o.w / 2, 0, o.w / 2, 0);
      for (let i = 0; i <= 6; i++) st.addColorStop(i / 6, i % 2 ? '#ffd24a' : '#1a1a20');
      ctx.fillStyle = st; ctx.fillRect(-o.w / 2, sy, o.w, 18);
    } else if (o.type === 'wreck') {
      drawCarBody(o.w, o.h, o.color, { hazard: Math.sin(o.blink * 3) > 0 });
      ctx.fillStyle = 'rgba(40,40,46,0.7)'; ctx.beginPath(); ctx.arc(0, -o.h * 0.1, o.w * 0.3, 0, 7); ctx.fill();
    } else if (o.type === 'copcar') {
      ctx.rotate(Math.PI / 2); drawCarBody(o.h, o.w * 1.7, '#f2f4f8', { police: true, lightPhase: o.lightPhase }); ctx.rotate(-Math.PI / 2);
    }
    ctx.restore();
  }
}

function drawPickups() {
  const style = {
    nitro: { c: '#2f9dff', icon: 'N' }, shield: { c: '#28d6c8', icon: 'S' },
    mult: { c: '#ffb020', icon: '×2' }, jammer: { c: '#a458e8', icon: 'J' },
    ram: { c: '#ff6a2a', icon: '⛌' }, cash: { c: '#ffd24a', icon: '$' },
    repair: { c: '#3ec77a', icon: '✚' },
  };
  // heads-up marker while a pickup is still above the screen
  for (const p of pickups) {
    if (p.y >= -20) continue;
    const s = style[p.type] || { c: '#ffffff', icon: '?' };
    const pulse = 0.6 + Math.sin(p.t * 8) * 0.3;
    ctx.save(); ctx.translate(p.x, 130); ctx.globalAlpha = pulse;
    ctx.fillStyle = s.c;
    ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(9, -24); ctx.lineTo(-9, -24); ctx.closePath(); ctx.fill(); // down chevron
    ctx.beginPath(); ctx.arc(0, 2, 12, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff'; ctx.font = '800 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.icon, 0, 3);
    ctx.restore();
  }
  for (const p of pickups) {
    if (p.y < -60 || p.y > H + 60) continue;
    const s = style[p.type] || { c: '#ffffff', icon: '?' }, bob = Math.sin(p.t * 5) * 2, r = p.r + Math.sin(p.t * 6) * 1.2;
    ctx.save(); ctx.translate(p.x, p.y + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(2, r * 0.75, r * 0.9, r * 0.42, 0, 0, 7); ctx.fill();
    const gl = ctx.createRadialGradient(0, 0, 2, 0, 0, r * 2); gl.addColorStop(0, s.c + 'aa'); gl.addColorStop(1, s.c + '00');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, r * 2, 0, 7); ctx.fill();
    ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(r * 0.95)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.icon, 0, 1);
    ctx.restore();
  }
}

// traffic body painter (origin center, facing up)
function drawCarBody(w, h, color, opt = {}) {
  const r = Math.min(8, w * 0.22);
  ctx.fillStyle = 'rgba(0,0,0,0.32)'; roundRect(-w / 2 + 3, -h / 2 + 5, w, h, r); ctx.fill();
  const bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  bg.addColorStop(0, shade(color, -22)); bg.addColorStop(0.5, color); bg.addColorStop(1, shade(color, -30));
  ctx.fillStyle = bg; roundRect(-w / 2, -h / 2, w, h, r); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5; roundRect(-w / 2, -h / 2, w, h, r); ctx.stroke();
  if (opt.police) { ctx.fillStyle = '#20242e'; ctx.fillRect(-w / 2, -h * 0.08, w, h * 0.3); ctx.fillStyle = '#2a56c8'; ctx.fillRect(-w / 2, -h * 0.02, w, h * 0.1); }
  ctx.fillStyle = 'rgba(24,30,44,0.85)';
  roundRect(-w * 0.36, -h * 0.32, w * 0.72, h * 0.2, 4); ctx.fill();
  roundRect(-w * 0.36, h * 0.14, w * 0.72, h * 0.15, 4); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.1)'; roundRect(-w * 0.32, -h * 0.1, w * 0.64, h * 0.22, 4); ctx.fill();
  ctx.fillStyle = opt.hazard ? '#ffb020' : '#fff7cf'; ctx.fillRect(-w * 0.38, -h / 2 + 2, w * 0.2, 4); ctx.fillRect(w * 0.18, -h / 2 + 2, w * 0.2, 4);
  ctx.fillStyle = opt.brake || opt.hazard ? '#ff2a2a' : '#8c1a1a'; ctx.fillRect(-w * 0.38, h / 2 - 6, w * 0.2, 4); ctx.fillRect(w * 0.18, h / 2 - 6, w * 0.2, 4);
  if (opt.brake) { ctx.fillStyle = 'rgba(255,42,42,0.35)'; ctx.fillRect(-w * 0.45, h / 2 - 4, w * 0.9, 10); }
  if (opt.police) {
    const ph = Math.sin((opt.lightPhase || 0) * Math.PI) > 0;
    ctx.fillStyle = ph ? '#ff3048' : '#2a66ff'; ctx.fillRect(-w * 0.3, -h * 0.06, w * 0.28, 7);
    ctx.fillStyle = ph ? '#2a66ff' : '#ff3048'; ctx.fillRect(w * 0.02, -h * 0.06, w * 0.28, 7);
    ctx.fillStyle = ph ? 'rgba(255,48,72,0.25)' : 'rgba(42,102,255,0.25)'; ctx.beginPath(); ctx.arc(0, -h * 0.02, w * 0.9, 0, 7); ctx.fill();
  }
  if (opt.blinker && Math.sin(performance.now() / 90) > 0) {
    ctx.fillStyle = '#ffb020'; const bx = opt.blinker < 0 ? -w / 2 : w / 2 - 5;
    ctx.fillRect(bx, -h / 2 + 2, 5, 6); ctx.fillRect(bx, h / 2 - 8, 5, 6);
  }
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${clamp((n >> 16) + amt, 0, 255)},${clamp(((n >> 8) & 255) + amt, 0, 255)},${clamp((n & 255) + amt, 0, 255)})`;
}

function drawVehicles(nf) {
  for (const v of vehicles) {
    if (v.y + v.h / 2 < -80 || v.y - v.h / 2 > H + 80) continue;
    ctx.save(); ctx.translate(v.x, v.y);
    if (v.rot) ctx.rotate(v.rot);
    else if (v.state === 'changing') ctx.rotate((laneX(v.targetLane) > v.x ? 1 : -1) * 0.06);
    if (v.type === 'moto') drawMoto(v);
    else if (v.type === 'truck') drawTruck(v);
    else if (v.type === 'bus') drawBus(v);
    else if (v.type === 'sport') drawSport(v);
    else if (v.type === 'taxi') drawTaxi(v);
    else if (v.type === 'ute') drawUte(v);
    else drawCarBody(v.w, v.h, v.color, { brake: v.brakeLight, blinker: v.blinker });
    if (v.burnT) { ctx.fillStyle = 'rgba(30,30,34,0.45)'; roundRect(-v.w / 2, -v.h / 2, v.w, v.h, 6); ctx.fill(); }
    ctx.restore();
    if (nf > 0.25 && !v.burnT) drawHeadlightCone(v.x, v.y - v.h / 2, v.w, nf);
  }
}
function drawMoto(v) {
  const w = v.w, h = v.h;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(2, 4, w * 0.6, h * 0.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#15171d'; roundRect(-w * 0.15, -h * 0.5, w * 0.3, h * 0.26, w * 0.12); ctx.fill(); roundRect(-w * 0.15, h * 0.26, w * 0.3, h * 0.26, w * 0.12); ctx.fill();
  ctx.strokeStyle = '#3a3d47'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(-w * 0.5, -h * 0.22); ctx.lineTo(w * 0.5, -h * 0.22); ctx.stroke();
  const bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0); bg.addColorStop(0, shade(v.color, -25)); bg.addColorStop(0.5, v.color); bg.addColorStop(1, shade(v.color, -30));
  ctx.fillStyle = bg; roundRect(-w * 0.3, -h * 0.36, w * 0.6, h * 0.6, w * 0.18); ctx.fill();
  ctx.fillStyle = 'rgba(24,30,44,0.85)'; roundRect(-w * 0.2, -h * 0.36, w * 0.4, h * 0.12, 3); ctx.fill();
  ctx.fillStyle = shade(v.color, -50); ctx.beginPath(); ctx.ellipse(0, h * 0.06, w * 0.36, h * 0.15, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#e8e4da'; ctx.beginPath(); ctx.arc(0, -h * 0.04, w * 0.25, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(24,30,44,0.9)'; ctx.beginPath(); ctx.arc(0, -h * 0.04, w * 0.25, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
  ctx.fillStyle = '#fff7cf'; ctx.fillRect(-w * 0.12, -h * 0.5, w * 0.24, 3);
  ctx.fillStyle = v.brakeLight ? '#ff2a2a' : '#8c1a1a'; ctx.fillRect(-w * 0.12, h * 0.48, w * 0.24, 3);
}
function drawTruck(v) {
  drawCarBody(v.w, v.h, '#b8bdc9', { brake: v.brakeLight });
  ctx.fillStyle = v.color; roundRect(-v.w / 2 + 2, -v.h / 2 + 4, v.w - 4, v.h * 0.22, 4); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(-v.w / 2 + 2, -v.h / 2 + v.h * 0.26, v.w - 4, 3);
}
function drawBus(v) {
  drawCarBody(v.w, v.h, v.color, { brake: v.brakeLight });
  ctx.fillStyle = 'rgba(230,240,255,0.75)';
  for (let i = 0; i < 5; i++) ctx.fillRect(-v.w * 0.36, -v.h * 0.34 + i * v.h * 0.16, v.w * 0.72, v.h * 0.07);
}
function drawSport(v) {
  const w = v.w, h = v.h;
  ctx.fillStyle = 'rgba(0,0,0,0.32)'; carBodyPath(w, h, 3, 5); ctx.fill();
  const bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  bg.addColorStop(0, shade(v.color, -35)); bg.addColorStop(0.5, v.color); bg.addColorStop(1, shade(v.color, -35));
  ctx.fillStyle = bg; carBodyPath(w, h, 0, 0); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.3; carBodyPath(w, h, 0, 0); ctx.stroke();
  ctx.fillStyle = 'rgba(18,24,36,0.9)';
  ctx.beginPath(); ctx.moveTo(0, -h * 0.2); ctx.lineTo(w * 0.2, 0); ctx.lineTo(w * 0.16, h * 0.22); ctx.lineTo(-w * 0.16, h * 0.22); ctx.lineTo(-w * 0.2, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#15171d'; ctx.fillRect(-w * 0.4, h * 0.4, w * 0.8, h * 0.06); // wing
  ctx.fillStyle = '#fff7cf'; ctx.fillRect(-w * 0.3, -h * 0.42, w * 0.14, 4); ctx.fillRect(w * 0.16, -h * 0.42, w * 0.14, 4);
  ctx.fillStyle = v.brakeLight ? '#ff2a2a' : '#8c1a1a'; ctx.fillRect(-w * 0.28, h * 0.34, w * 0.56, 3);
}
function drawTaxi(v) {
  drawCarBody(v.w, v.h, '#f2c530', { brake: v.brakeLight, blinker: v.blinker });
  // checker band + roof sign
  ctx.fillStyle = '#1a1a20';
  for (let i = -3; i < 3; i++) if ((i + 30) % 2 === 0) ctx.fillRect(i * v.w * 0.14, -v.h * 0.06, v.w * 0.14, 5);
  ctx.fillStyle = '#1a1a20'; ctx.fillRect(-v.w * 0.14, -v.h * 0.02, v.w * 0.28, 8);
  ctx.fillStyle = '#ffe9a0'; ctx.fillRect(-v.w * 0.1, 0, v.w * 0.2, 4);
}
function drawUte(v) {
  const w = v.w, h = v.h;
  drawCarBody(w, h, v.color, { brake: v.brakeLight, blinker: v.blinker });
  // open cargo bed over the rear half
  ctx.fillStyle = shade(v.color, -45);
  roundRect(-w * 0.42, h * 0.02, w * 0.84, h * 0.42, 4); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(-w * 0.34, h * 0.06, w * 0.68, h * 0.34, 3); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-w * 0.34, h * 0.23); ctx.lineTo(w * 0.34, h * 0.23); ctx.stroke();
}
function drawHeadlightCone(x, yTop, w, nf) {
  ctx.save(); ctx.globalCompositeOperation = 'screen';
  const len = w * 3.2, grd = ctx.createLinearGradient(0, yTop, 0, yTop - len);
  grd.addColorStop(0, `rgba(255,240,180,${0.28 * nf})`); grd.addColorStop(1, 'rgba(255,240,180,0)');
  ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(x - w * 0.35, yTop); ctx.lineTo(x - w * 0.75, yTop - len); ctx.lineTo(x + w * 0.75, yTop - len); ctx.lineTo(x + w * 0.35, yTop); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawCops(nf) {
  for (const p of cops) {
    if (p.y + p.h < -80 || p.y - p.h > H + 340) continue;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    drawCarBody(p.w, p.h, '#f2f4f8', { police: true, lightPhase: p.lightPhase, brake: p.state !== 'chase' });
    ctx.restore();
    if (nf > 0.25 && p.state === 'chase') drawHeadlightCone(p.x, p.y - p.h / 2, p.w, nf);
  }
}

// the player's supercar — sleek angular wedge, gold, glowing
function drawPlayer(nf) {
  const w = player.w, h = player.h;
  // exhaust flames behind the car
  if (G.nitroOn) {
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    for (let s = -1; s <= 1; s += 2) {
      const ex = player.x + s * w * 0.2, ey = player.y + h / 2;
      const fl = h * (0.9 + Math.random() * 0.5);
      const fg = ctx.createLinearGradient(0, ey, 0, ey + fl);
      fg.addColorStop(0, 'rgba(255,255,255,0.9)'); fg.addColorStop(0.3, 'rgba(120,220,255,0.8)'); fg.addColorStop(1, 'rgba(60,120,255,0)');
      ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(ex - w * 0.11, ey); ctx.lineTo(ex + w * 0.11, ey); ctx.lineTo(ex, ey + fl); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  ctx.save(); ctx.translate(player.x, player.y); ctx.rotate(player.tilt);

  // underglow when boosting
  if (G.nitroOn || G.ramT > 0) {
    const c = G.ramT > 0 ? 'rgba(255,120,40,0.35)' : 'rgba(74,224,255,0.35)';
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    const ug = ctx.createRadialGradient(0, 0, w * 0.2, 0, 0, w * 1.4);
    ug.addColorStop(0, c); ug.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ug; ctx.beginPath(); ctx.ellipse(0, h * 0.1, w * 1.3, h * 0.8, 0, 0, 7); ctx.fill(); ctx.restore();
  }

  // tyres at the four corners (drawn under the body, poking out at the edges)
  ctx.fillStyle = '#0e1014';
  const tw = w * 0.15, th = h * 0.16;
  for (const [tx, ty] of [[-w * 0.46, -h * 0.26], [w * 0.46, -h * 0.26], [-w * 0.48, h * 0.30], [w * 0.48, h * 0.30]]) {
    roundRect(tx - tw / 2, ty - th / 2, tw, th, 3); ctx.fill();
  }

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  carBodyPath(w, h, 4, 6); ctx.fill();

  // batmobile: matte black armor with a cold blue sheen down the spine
  const bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  bg.addColorStop(0, '#0a0b0f'); bg.addColorStop(0.28, '#1d2027'); bg.addColorStop(0.5, '#2e323d');
  bg.addColorStop(0.72, '#1d2027'); bg.addColorStop(1, '#0a0b0f');
  ctx.fillStyle = bg; carBodyPath(w, h, 0, 0); ctx.fill();
  ctx.strokeStyle = 'rgba(110,130,170,0.35)'; ctx.lineWidth = 1.4; carBodyPath(w, h, 0, 0); ctx.stroke();

  // armored nose plate
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.moveTo(0, -h * 0.5); ctx.lineTo(w * 0.24, -h * 0.38); ctx.lineTo(0, -h * 0.28); ctx.lineTo(-w * 0.24, -h * 0.38); ctx.closePath(); ctx.fill();

  // panel seams
  ctx.strokeStyle = 'rgba(120,140,180,0.18)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.28); ctx.lineTo(0, -h * 0.16);
  ctx.moveTo(-w * 0.3, -h * 0.08); ctx.lineTo(-w * 0.42, h * 0.2);
  ctx.moveTo(w * 0.3, -h * 0.08); ctx.lineTo(w * 0.42, h * 0.2);
  ctx.stroke();

  // slit cockpit canopy with a cyan glow rim
  ctx.fillStyle = '#05070c';
  ctx.beginPath(); ctx.moveTo(0, -h * 0.2); ctx.lineTo(w * 0.17, -h * 0.02); ctx.lineTo(w * 0.13, h * 0.16); ctx.lineTo(-w * 0.13, h * 0.16); ctx.lineTo(-w * 0.17, -h * 0.02); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(74,224,255,0.55)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(0, -h * 0.2); ctx.lineTo(w * 0.17, -h * 0.02); ctx.lineTo(w * 0.13, h * 0.16); ctx.lineTo(-w * 0.13, h * 0.16); ctx.lineTo(-w * 0.17, -h * 0.02); ctx.closePath(); ctx.stroke();

  // twin bat tail fins rising past the tail
  ctx.fillStyle = '#05070c';
  ctx.beginPath(); ctx.moveTo(-w * 0.34, h * 0.1); ctx.lineTo(-w * 0.24, h * 0.14); ctx.lineTo(-w * 0.28, h * 0.58); ctx.lineTo(-w * 0.4, h * 0.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(w * 0.34, h * 0.1); ctx.lineTo(w * 0.24, h * 0.14); ctx.lineTo(w * 0.28, h * 0.58); ctx.lineTo(w * 0.4, h * 0.5); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(110,130,170,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-w * 0.34, h * 0.1); ctx.lineTo(-w * 0.4, h * 0.5); ctx.moveTo(w * 0.34, h * 0.1); ctx.lineTo(w * 0.4, h * 0.5); ctx.stroke();

  // central jet turbine: dark ring, core glows with speed (blue-white on nitro)
  const over = clamp((player.speed - cruiseSpeed() * 0.8) / (cruiseSpeed() * 0.7), 0, 1);
  ctx.fillStyle = '#15171d'; ctx.beginPath(); ctx.arc(0, h * 0.4, w * 0.15, 0, 7); ctx.fill();
  ctx.strokeStyle = '#3a3e4a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, h * 0.4, w * 0.15, 0, 7); ctx.stroke();
  ctx.fillStyle = G.nitroOn ? '#bff2ff' : `rgba(255,${120 + over * 80},40,${0.35 + over * 0.55})`;
  ctx.beginPath(); ctx.arc(0, h * 0.4, w * 0.08, 0, 7); ctx.fill();

  // headlight slits
  ctx.fillStyle = '#eaf2ff';
  ctx.fillRect(-w * 0.3, -h * 0.33, w * 0.14, 3); ctx.fillRect(w * 0.16, -h * 0.33, w * 0.14, 3);
  // red taillight strip across the tail
  ctx.fillStyle = '#ff2030'; ctx.fillRect(-w * 0.3, h * 0.3, w * 0.6, 3);
  ctx.fillStyle = 'rgba(255,40,60,0.4)'; ctx.fillRect(-w * 0.3, h * 0.28, w * 0.6, 2);

  if (G.shield) {
    ctx.strokeStyle = `rgba(74,224,255,${0.6 + Math.sin(performance.now() / 150) * 0.3})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, w * 0.98, h * 0.6, 0, 0, 7); ctx.stroke();
  }
  ctx.restore();
  if (nf > 0.2) drawHeadlightCone(player.x, player.y - h / 2, w, nf);
}
// angular supercar silhouette: pointed nose, wide rear haunches
function carBodyPath(w, h, ox, oy) {
  ctx.beginPath();
  ctx.moveTo(ox, oy - h * 0.5);
  ctx.lineTo(ox + w * 0.28, oy - h * 0.4);
  ctx.lineTo(ox + w * 0.46, oy - h * 0.16);
  ctx.lineTo(ox + w * 0.5, oy + h * 0.12);
  ctx.lineTo(ox + w * 0.44, oy + h * 0.46);
  ctx.lineTo(ox + w * 0.28, oy + h * 0.5);
  ctx.lineTo(ox - w * 0.28, oy + h * 0.5);
  ctx.lineTo(ox - w * 0.44, oy + h * 0.46);
  ctx.lineTo(ox - w * 0.5, oy + h * 0.12);
  ctx.lineTo(ox - w * 0.46, oy - h * 0.16);
  ctx.lineTo(ox - w * 0.28, oy - h * 0.4);
  ctx.closePath();
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = clamp(1 - p.t / p.life, 0, 1);
    ctx.fillStyle = p.color;
    if (p.fire) { ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - p.t / p.life * 0.5), 0, 7); ctx.fill(); }
    else ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function drawStreaks() {
  const over = clamp((player.speed - cruiseSpeed()) / 120, 0, 1);
  const amt = G.nitroOn ? 1 : over * 0.6;
  if (amt < 0.08 || G.crashed) return;
  ctx.strokeStyle = `rgba(255,255,255,${0.16 * amt})`; ctx.lineWidth = 2;
  const n = Math.round(12 * amt);
  for (let i = 0; i < n; i++) { const x = rand(0, W), y = rand(0, H), len = rand(30, 100) * (1 + amt); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke(); }
}

let rainDrops = null;
function drawWeather() {
  const wt = G.weather;
  if (!wt.type) { rainDrops = null; return; }
  const fade = Math.min(1, wt.t / 1.2, (wt.dur - wt.t) / 1.2);
  if (wt.type === 'fog') {
    const fg = ctx.createLinearGradient(0, 0, 0, H);
    fg.addColorStop(0, `rgba(210,218,228,${0.85 * fade})`); fg.addColorStop(0.55, `rgba(210,218,228,${0.5 * fade})`); fg.addColorStop(1, `rgba(210,218,228,${0.15 * fade})`);
    ctx.fillStyle = fg; ctx.fillRect(0, 0, W, H);
  } else if (wt.type === 'rain') {
    ctx.fillStyle = `rgba(20,30,55,${0.3 * fade})`; ctx.fillRect(0, 0, W, H);
    if (!rainDrops) { rainDrops = []; for (let i = 0; i < 70; i++) rainDrops.push({ x: rand(0, W), y: rand(0, H), s: rand(0.6, 1.3) }); }
    ctx.strokeStyle = `rgba(180,205,240,${0.5 * fade})`; ctx.lineWidth = 1.5;
    for (const dr of rainDrops) { dr.y += 34 * dr.s; dr.x -= 6 * dr.s; if (dr.y > H) { dr.y = -20; dr.x = rand(0, W + 60); } ctx.beginPath(); ctx.moveTo(dr.x, dr.y); ctx.lineTo(dr.x - 4, dr.y - 18 * dr.s); ctx.stroke(); }
  } else if (wt.type === 'tunnel') {
    ctx.fillStyle = `rgba(8,8,16,${0.62 * fade})`; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(46,48,60,${fade})`; ctx.fillRect(0, 0, road.x - 6, H); ctx.fillRect(road.x + road.w + 6, 0, W - road.x - road.w - 6, H);
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    for (let y = (G.lampOff * 1.4 % 220) - 220; y < H + 60; y += 220) {
      const lg = ctx.createRadialGradient(W / 2, y, 6, W / 2, y, road.w * 0.65);
      lg.addColorStop(0, `rgba(255,225,150,${0.5 * fade})`); lg.addColorStop(1, 'rgba(255,225,150,0)');
      ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(W / 2, y, road.w * 0.65, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
}
function drawNight(nf) { if (nf < 0.03) return; ctx.fillStyle = `rgba(8,12,38,${nf * 0.42})`; ctx.fillRect(0, 0, W, H); }

function drawPopups() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of popups) {
    const a = clamp(1 - p.t / 1.2, 0, 1);
    ctx.font = '800 15px system-ui, sans-serif'; ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(p.text, p.x + 1, p.y + 1);
    ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
}

// ---------- HUD / banner ----------
const hud = {
  score: $('h-score'), best: $('h-best'), speed: $('h-speed'), dist: $('h-dist'), time: $('h-time'),
  combo: $('combo'), nitroWrap: $('nitro-wrap'), nitroFill: $('nitro-fill'),
  intFill: $('int-fill'), wStatus: $('w-status'),
  segs: [...document.querySelectorAll('#segs .seg i')],
};
let bannerTimer = null;
function showBanner(text, cls, dur) {
  const b = $('banner'); b.textContent = text; b.className = cls ? cls + ' on' : 'on';
  clearTimeout(bannerTimer); bannerTimer = setTimeout(hideBanner, dur * 1000);
}
function hideBanner() { $('banner').className = ''; }

function updateHUD() {
  hud.score.textContent = Math.round(G.score).toLocaleString();
  hud.best.textContent = store.best.toLocaleString();
  hud.speed.textContent = Math.round(player.speed);
  hud.dist.textContent = (G.dist / 1000).toFixed(1);
  hud.time.textContent = fmtTime(G.time);
  hud.nitroFill.style.width = G.nitro + '%';
  hud.nitroWrap.classList.toggle('ready', G.nitro > 8);
  hud.intFill.style.width = G.integrity + '%';
  hud.intFill.style.background = G.integrity > 55 ? 'linear-gradient(90deg,#2fbf5f,#7cff9e)'
    : G.integrity > 28 ? 'linear-gradient(90deg,#e8a020,#ffd24a)' : 'linear-gradient(90deg,#d63030,#ff6a6a)';
  // wanted panel: 5 segments fill with heat; lit segments = active response level
  for (let k = 0; k < 5; k++) {
    const el = hud.segs[k];
    if (!el) continue;
    el.style.width = clamp((G.heat - k * 20) / 20, 0, 1) * 100 + '%';
    el.style.background = k < 2 ? '#ffd24a' : k < 4 ? '#ff7a2a' : '#ff3048';
  }
  let txt, cls;
  if (G.wanted === 0) {
    if (G.heat < 12) { txt = 'CLEAR'; cls = 'safe'; }
    else { txt = 'HEATING UP'; cls = 'warn'; }
  } else if (G.escapeT > 0.3) { txt = `ESCAPING ${Math.round(G.escapeT / (2.2 + G.wanted * 1.1) * 100)}%`; cls = 'warn'; }
  else { txt = `WANTED LV ${G.wanted}`; cls = G.wanted >= 3 ? 'hot' : 'warn'; }
  hud.wStatus.textContent = txt; hud.wStatus.className = cls;
  if (G.combo > 0) { hud.combo.textContent = `COMBO ×${comboMult().toFixed(2).replace(/\.?0+$/, '')}`; hud.combo.classList.add('on'); }
  else hud.combo.classList.remove('on');
}

// ---------- flow ----------
function setScreen(id) {
  for (const s of ['screen-start', 'screen-pause', 'screen-over']) $(s).classList.add('hidden');
  if (id) $(id).classList.remove('hidden');
  $('hud').classList.toggle('on', !id || id !== 'screen-start');
}
function startGame() {
  A.init(); if (A.ctx.state === 'suspended') A.ctx.resume();
  resetRun();
  G.state = 'playing'; setScreen(null); $('hud').classList.add('on');
  last = performance.now();
}
function pauseGame() {
  if (G.state !== 'playing') return;
  G.state = 'paused'; setScreen('screen-pause');
  A.updateEngine(0, false, false); A.setSkid(false);
  if (A.sirenNodes) A.sirenNodes.g.gain.setTargetAtTime(0, A.ctx.currentTime, 0.05);
}
function resumeGame() {
  if (G.state !== 'paused') return;
  G.state = 'playing'; setScreen(null);
  if (A.sirenNodes) A.sirenNodes.g.gain.setTargetAtTime(0.045, A.ctx.currentTime, 0.05);
  last = performance.now();
}
function quitToMenu() {
  G.state = 'menu'; setScreen('screen-start'); $('hud').classList.remove('on');
  $('menu-best').textContent = store.best.toLocaleString();
  A.updateEngine(0, false, false); A.setSiren(false); A.setSkid(false);
}
function gameOver() {
  G.state = 'over';
  const sc = Math.round(G.score), isBest = sc > store.best;
  if (isBest) store.best = sc;
  $('over-title').textContent = G.crashCause === 'police' ? 'Busted' : 'Wrecked';
  $('over-score').textContent = sc.toLocaleString();
  $('over-newbest').classList.toggle('on', isBest);
  $('o-dist').textContent = (G.dist / 1000).toFixed(2) + ' km';
  $('o-time').textContent = fmtTime(G.time);
  $('o-topspeed').textContent = Math.round(G.topSpeed) + ' km/h';
  $('o-misses').textContent = G.nearMisses;
  $('o-chases').textContent = G.chasesEscaped;
  $('o-cops').textContent = G.wrecked;
  $('o-best').textContent = store.best.toLocaleString();
  setScreen('screen-over');
  A.updateEngine(0, false, false); A.setSkid(false); A.setSiren(false);
}

// ---------- UI wiring ----------
$('btn-play').addEventListener('click', startGame);
$('btn-pause').addEventListener('click', () => { if (G.state === 'playing') pauseGame(); });
$('btn-resume').addEventListener('click', resumeGame);
$('btn-restart-p').addEventListener('click', () => startGame());
$('btn-quit-p').addEventListener('click', quitToMenu);
$('btn-restart-o').addEventListener('click', () => startGame());
$('btn-menu-o').addEventListener('click', quitToMenu);
bindHold($('btn-nitro'), 'nitro');

function syncToggles() {
  for (const [id, on] of [['tog-music-1', store.music], ['tog-music-2', store.music], ['tog-sfx-1', store.sfx], ['tog-sfx-2', store.sfx]])
    { const el = $(id); if (el) el.classList.toggle('on', on); }
}
for (const id of ['tog-music-1', 'tog-music-2']) $(id).addEventListener('click', () => { const v = !store.music; store.music = v; if (A.ctx) A.setMusic(v); syncToggles(); });
for (const id of ['tog-sfx-1', 'tog-sfx-2']) $(id).addEventListener('click', () => { const v = !store.sfx; store.sfx = v; if (A.ctx) A.setSfx(v); syncToggles(); });
syncToggles();
$('menu-best').textContent = store.best.toLocaleString();

if ('ontouchstart' in window) document.body.classList.add('touch');
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'playing' && !G.crashed) pauseGame(); });

// ---------- main loop ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.05) dt = 0.05;
  if (G.state === 'playing') update(dt);
  render();
}

resize();
resetRun();
G.state = 'menu';
setScreen('screen-start');
requestAnimationFrame(frame);

// debug hooks for automated testing
window.__game = {
  G, player, vehicles, cops, obstacles, pickups, input,
  start: startGame, crash, triggerEvent,
  setTime: t => { G.time = t; },
  forceChase: () => { G.heat = 45; },
  setHeat: h => { G.heat = h; },
  step: (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) if (G.state === 'playing') update(dt); render(); },
};

})();
