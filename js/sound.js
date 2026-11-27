// 効果音（ゲームの match_audio.gd と同じ音。置いた音は -6 dB）
// ブラウザは最初の操作まで音を出せないので、最初のクリック・タップ・キーで AudioContext を作る
const FILES = {
  place_wall: 'assets/sfx/sfx_place_wall.wav',
  set: 'assets/sfx/set.wav',
  chest: 'assets/sfx/sfx_chest.wav',
  undo: 'assets/sfx/sfx_undo.wav',
  wind: 'assets/sfx/weather_wind_loop.ogg',
  // 屋上の床・レンガ・大理石はゲームでは「concrete」の着地音。高く落ちたら重い岩の音
  land_concrete: 'assets/sfx/sfx_landing_concrete.wav',
  land_heavy_rock1: 'assets/sfx/sfx_landing_heavy_rock1.wav',
  land_heavy_rock2: 'assets/sfx/sfx_landing_heavy_rock2.wav',
};
const PLACE_SFX_DB = -6.0;

let ctx = null;
let master = null;
const buffers = {};

function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    for (const [k, url] of Object.entries(FILES)) {
      fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => { buffers[k] = buf; })
        .catch((e) => console.warn('sfx', url, e));
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
}
for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });

export function play(name, db = 0, rate = 1.0) {
  if (!ctx || !buffers[name]) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
  const g = ctx.createGain();
  g.gain.value = Math.pow(10, db / 20);
  src.connect(g).connect(master);
  src.start();
}

// 置いた音（レンガは壁の音、ほかは「セット」の音）
export function playPlace(kind) {
  if (kind === 'wall') play('place_wall', -2.0 + PLACE_SFX_DB);
  else play('set', -2.0 + PLACE_SFX_DB, kind === 'glass' ? 1.12 : (kind === 'curtain' ? 0.9 : 1.0));
}

// 回収の音（「セット」を高めに）
export function playPickup() {
  play('set', -4.0 + PLACE_SFX_DB, 1.45);
}

export function playChest() {
  play('chest', -2.0);
}

// --- 着地音・足音（ゲームの match_audio.gd の play_land / play_step と player_water_steps.gd の _ground_step） ---
const LAND_HEAVY_FALL = 3.5;
const LAND_STEP_BASE_DB = -6.0;
let heavyCursor = 0;
const jitter = () => 0.93 + Math.random() * 0.14;

function playRaw(name, db, rate) {
  if (!ctx || !buffers[name]) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = Math.pow(10, db / 20);
  src.connect(g).connect(master);
  src.start();
}

// 落ちた高さで大きさが変わる（0.2m 未満は鳴らさない、~8m で最大）
export function playLand(fallHeight) {
  if (fallHeight < 0.2) return;
  let t = Math.min(1, Math.max(0, (fallHeight - 0.3) / 7.5));
  t *= t;
  const db = -18.0 + (1.0 + 18.0) * t;
  let key = 'land_concrete';
  if (fallHeight >= LAND_HEAVY_FALL) { heavyCursor = (heavyCursor + 1) % 2; key = `land_heavy_rock${heavyCursor + 1}`; }
  playRaw(key, db, jitter());
}

const GROUND_STEP_MIN = 0.75;
const GROUND_STEP_MAX = 1.5;
const STILL_SEC = 0.4;
const FIRST_STEP_AT = 0.15;
const STREAK_DB = -1.5;
const STREAK_MIN_DB = -12.0;
const RUN_SPEED = 3.0;
const RUN_DB = -4.0;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// 歩いた距離で鳴らす。歩き出しの一歩は着地音の半分、続けて歩くあいだは 1/4。走るほど小さく
export class Steps {
  constructor() { this.reset(); this.last = null; this.still = 0; }
  reset() { this.first = true; this.walked = 0; this.streak = 0; }
  tick(dt, pos, onGround) {
    const moved = this.last ? Math.hypot(pos.x - this.last.x, pos.z - this.last.z) : 0;
    this.last = { x: pos.x, z: pos.z };
    const still = moved < 0.004;
    this.still = still ? this.still + dt : 0;
    if (this.still >= STILL_SEC) { this.first = true; this.walked = 0; }
    if (still || !onGround) return;
    this.walked += moved;
    const speed = moved / Math.max(dt, 0.001);
    const span = this.first ? FIRST_STEP_AT : Math.min(GROUND_STEP_MAX, Math.max(GROUND_STEP_MIN, 0.55 + 0.12 * speed));
    if (this.walked < span) return;
    this.walked = 0;
    let quiet = 0;
    if (this.first) this.streak = 0;
    else {
      this.streak += 1;
      quiet = Math.max(STREAK_DB * (this.streak - 1), STREAK_MIN_DB) + RUN_DB * smooth(RUN_SPEED * 0.8, RUN_SPEED * 1.6, speed);
    }
    playRaw('land_concrete', LAND_STEP_BASE_DB + (this.first ? -6.02 : -12.04) + quiet, jitter());
    this.first = false;
  }
}

// 取り消しの音（ゲームの play_undo: -4 dB と置く音の -6 dB）
export function playUndo() {
  play('undo', -4.0 + PLACE_SFX_DB);
}

// 風の音（ゲームの weather_fx.gd の _update_wind_sound: 大きさは強さで、高さは強さと突風で。基本の音量 -9 dB）
let windSrc = null, windGain = null, windLevel = 0;
export function updateWindSound(dt, eff, gust) {
  if (!ctx || !buffers.wind) return;
  if (!windSrc) {
    windSrc = ctx.createBufferSource();
    windSrc.buffer = buffers.wind;
    windSrc.loop = true;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windGain).connect(master);
    windSrc.start();
  }
  const want = smooth(0.12, 0.95, eff) * Math.pow(10, -9.0 / 20);
  windLevel += (want - windLevel) * Math.min(1, dt / 0.6);
  windGain.gain.value = windLevel;
  windSrc.playbackRate.value = 0.82 + 0.32 * Math.min(Math.max(eff, 0), 1.3) + 0.06 * gust;
}
