// 効果音（ゲームの match_audio.gd と同じ音。置いた音は -6 dB）
// ブラウザは最初の操作まで音を出せないので、最初のクリック・タップ・キーで AudioContext を作る
const FILES = {
  place_wall: 'assets/sfx/sfx_place_wall.wav',
  set: 'assets/sfx/set.wav',
  chest: 'assets/sfx/sfx_chest.wav',
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
