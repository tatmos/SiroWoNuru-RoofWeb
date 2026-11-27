// 太陽のレンズフレアと、風（向き・強さ・突風、舞う葉）。
// ゲームの scripts/game/sun_flare.gd・wind_state.gd・weather_fx.gd（落ち葉と風の音）を移したもの。
import * as THREE from 'three';

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// なめらかな 1 次元ノイズ（-1..1）。FastNoiseLite のかわりに、ずらした正弦の和
const noise1 = (t, seed) => (Math.sin(t * 1.0 + seed) * 0.5 + Math.sin(t * 2.31 + seed * 1.7) * 0.3 + Math.sin(t * 4.77 + seed * 2.9) * 0.2);

// --- 風（wind_state.gd） ---
export class Wind {
  constructor() {
    this.t = 0;
    this.angle = 0.6;
    this.strength = 0.3; // ゲームの既定は 0.2。屋上なので少し強め
    this.gusty = 0.35;
    this.gust = 0;
    this.dir = new THREE.Vector2(1, 0);
  }

  // 強さと突風を合わせた今の強さ（ゲームの effective）
  effective() { return this.strength * (1.0 + 0.8 * this.gust) + 0.08 * this.gust; }
  vector3() { const e = this.effective(); return new THREE.Vector3(this.dir.x * e, 0, this.dir.y * e); }

  update(dt) {
    this.t += dt;
    // 向きもゆらぐ
    const a = this.angle + noise1(this.t * 0.04, 31) * (0.15 + 0.3 * this.gusty);
    this.dir.set(Math.cos(a), Math.sin(a));
    // 突風: ゆっくりしたうねりが山を越えたときだけ強く吹く＋細かいばたつき
    const swell = noise1(this.t * 0.22, 7) * 0.5 + 0.5;
    const burst = smoothstep(0.55 - 0.25 * this.gusty, 0.95, swell);
    const flutter = noise1(this.t * 1.6, 19) * 0.5 + 0.5;
    const g = this.gusty * (0.85 * burst + 0.25 * flutter * burst + 0.1 * flutter);
    this.gust = Math.min(1, Math.max(0, g * smoothstep(0, 0.18, this.strength)));
  }
}

// --- 舞う葉（weather_fx.gd の落ち葉: 風に流され、ひらひら回りながらゆっくり落ちる） ---
const LEAF_COUNT = 90;
const LEAF_BOX = 26; // プレイヤーのまわりの箱（半分の大きさ）
const LEAF_TOP = 9;
export class Leaves {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(0.09, 0.06);
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, LEAF_COUNT);
    this.mesh.frustumCulled = false;
    const cols = [0xd9822b, 0xb85c2a, 0xe0a63a, 0x9c6b3a, 0x8fae4a];
    this.p = [];
    for (let i = 0; i < LEAF_COUNT; i++) {
      this.mesh.setColorAt(i, new THREE.Color(cols[i % cols.length]));
      this.p.push({
        pos: new THREE.Vector3((Math.random() * 2 - 1) * LEAF_BOX, Math.random() * LEAF_TOP, (Math.random() * 2 - 1) * LEAF_BOX),
        ph: Math.random() * 10, spin: 2 + Math.random() * 4, fall: 0.25 + Math.random() * 0.35,
      });
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.one = new THREE.Vector3(1, 1, 1);
    scene.add(this.mesh);
  }

  update(dt, center, wind) {
    const w = wind.vector3();
    const speed = 0.3 + 24.7 * Math.pow(Math.max(wind.effective(), 0), 1.3); // 風速（ゲームの speed_ms）
    const drift = w.clone().setLength(Math.min(speed * 0.35, 6));
    const tmp = new THREE.Vector3();
    for (let i = 0; i < this.p.length; i++) {
      const l = this.p[i];
      l.ph += dt * l.spin;
      l.pos.x += (drift.x + Math.sin(l.ph) * 0.4) * dt;
      l.pos.z += (drift.z + Math.cos(l.ph * 0.7) * 0.4) * dt;
      l.pos.y += (-l.fall + 0.35 * wind.gust * Math.sin(l.ph * 0.5)) * dt;
      // 箱からはみ出たら反対側へ（プレイヤーについてくる）
      for (const k of ['x', 'z']) {
        if (l.pos[k] > LEAF_BOX) l.pos[k] -= LEAF_BOX * 2;
        if (l.pos[k] < -LEAF_BOX) l.pos[k] += LEAF_BOX * 2;
      }
      if (l.pos.y < -1) l.pos.y += LEAF_TOP + 1;
      this.e.set(l.ph, l.ph * 0.6, l.ph * 0.3);
      this.q.setFromEuler(this.e);
      tmp.set(center.x + l.pos.x, center.y + l.pos.y, center.z + l.pos.z);
      this.m.compose(tmp, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// --- 太陽のレンズフレア（sun_flare.gd: デスクトップだけ） ---
const FACE_MIN = 0.55;
const FACE_FULL = 0.92;
const FOLLOW = 6.0;
const GHOSTS = [
  [0.32, 0.018, [1.0, 0.85, 0.55]], [0.55, 0.035, [0.6, 1.0, 0.75]], [0.78, 0.012, [0.75, 0.8, 1.0]],
  [1.18, 0.05, [0.85, 0.7, 1.0]], [1.45, 0.022, [1.0, 0.75, 0.6]], [1.8, 0.075, [0.6, 0.85, 1.0]],
];
const RING_COLORS = [[1.0, 0.35, 0.3], [1.0, 0.7, 0.3], [0.95, 1.0, 0.4], [0.4, 1.0, 0.5], [0.4, 0.7, 1.0], [0.7, 0.45, 1.0]];
const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export class SunFlare {
  // occluded(origin, dir) -> 太陽までのあいだに物があれば true
  constructor(occluded) {
    this.occluded = occluded;
    this.amount = 0;
    this.sun = { x: 0, y: 0 };
    this.cv = document.createElement('canvas');
    this.cv.id = 'flare';
    document.body.appendChild(this.cv);
    this.g = this.cv.getContext('2d');
  }

  update(dt, camera, sunDir, enabled) {
    let want = 0;
    if (enabled && sunDir.y > -0.02) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
      const face = fwd.dot(sunDir);
      if (face > FACE_MIN) {
        const camPos = camera.getWorldPosition(new THREE.Vector3());
        const p = camPos.clone().addScaledVector(sunDir, 100).project(camera);
        if (p.z < 1) {
          this.sun.x = (p.x * 0.5 + 0.5) * window.innerWidth;
          this.sun.y = (-p.y * 0.5 + 0.5) * window.innerHeight;
          const low = 1.0 - 0.4 * smoothstep(0.3, 0.9, sunDir.y);
          want = smoothstep(FACE_MIN, FACE_FULL, face) * low * 0.75 * smoothstep(-0.02, 0.06, sunDir.y);
          if (want > 0.01 && this.occluded(camPos, sunDir)) want = 0;
        }
      }
    }
    this.amount += (want - this.amount) * Math.min(1, dt * FOLLOW);
    this._draw();
  }

  _draw() {
    const cv = this.cv, g = this.g;
    const w = window.innerWidth, h = window.innerHeight;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    g.clearRect(0, 0, w, h);
    const a = Math.min(1, Math.max(0, this.amount));
    if (a <= 0.005) { cv.style.display = 'none'; return; }
    cv.style.display = 'block';
    const short = Math.min(w, h);
    const s = this.sun;
    g.globalCompositeOperation = 'lighter';
    // 太陽のにじみ（大きく薄い円を重ねる）
    for (let k = 0; k < 4; k++) {
      g.fillStyle = rgba([1.0, 0.92, 0.78], 0.07 * a / (1 + k));
      g.beginPath(); g.arc(s.x, s.y, short * (0.05 + 0.07 * k), 0, Math.PI * 2); g.fill();
    }
    // 太陽を囲む淡い虹色の輪
    const ringR = short * 0.2;
    g.lineWidth = short * 0.007;
    RING_COLORS.forEach((c, i) => {
      g.strokeStyle = rgba(c, 0.05 * a);
      g.beginPath(); g.arc(s.x, s.y, ringR + i * short * 0.006, 0, Math.PI * 2); g.stroke();
    });
    // 太陽から画面の中心を通る線上の光の玉
    const vx = w / 2 - s.x, vy = h / 2 - s.y;
    for (const [t, r, c] of GHOSTS) {
      const px = s.x + vx * t, py = s.y + vy * t, rr = short * r;
      g.fillStyle = rgba(c, 0.09 * a);
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
      g.strokeStyle = rgba(c, 0.05 * a);
      g.lineWidth = Math.max(1.5, rr * 0.12);
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.stroke();
    }
  }
}
