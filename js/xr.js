// VR（WebXR）。左スティックで頭の向きを前に歩く・右スティックでなめらかに向きを変える（押しこむとスナップ）・右の引き金で置く（押す: 床、長押し: 壁）
// 右手のメニュー: A で次の建材、B で回収に切りかえ。左の引き金でジャンプ、左のグリップで走る
import * as THREE from 'three';

const SNAP_TURN = Math.PI / 6;
// ゲームの GamepadAim.LOOK_SENS（1.35 rad/秒）を VR の主観では 2 倍にしている
const SMOOTH_TURN_SPEED = 1.35 * 2.0;
const STICK_DEADZONE = 0.22;

export class XrControls {
  constructor(renderer, scene, rig, camera, o) {
    this.renderer = renderer;
    this.scene = scene;
    this.rig = rig;
    this.camera = camera;
    this.o = o;
    this.turn = 0;
    this.move = new THREE.Vector2();
    this.sprint = false;
    this.pendingUrl = null;
    this.hands = {};
    this._prev = {};
    this._turnLatch = false;
    this._menuDirty = true;
    for (let i = 0; i < 2; i++) this._setupController(i);
    renderer.xr.addEventListener('sessionend', () => { document.body.classList.remove('in-vr'); this.o.onEnd(); });
    this._buildMenu();
    this._noticeMesh = null;
  }

  async checkSupport() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
    try { return await navigator.xr.isSessionSupported('immersive-vr'); } catch { return false; }
  }

  // VR を始める。どこで止まったか分かるよう、段ごとに画面へ出す
  async start() {
    if (this.renderer.xr.isPresenting) { this.renderer.xr.getSession().end(); return; }
    if (this._starting) return;
    this._starting = true;
    const t0 = performance.now();
    const step = (msg) => this.status(`${msg}（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    try {
      // ゴーグルの GPU に合わせる（PC では GPU の切りかえで時間がかかることがある）
      step('1/3 GPU を VR 用に準備しています…');
      const gl = this.renderer.getContext();
      if (gl.makeXRCompatible) await gl.makeXRCompatible();
      step('2/3 ゴーグルに VR を頼んでいます…（ゴーグルの中を見てください）');
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      step('3/3 VR の画面を作っています…');
      this.renderer.xr.setReferenceSpaceType('local-floor');
      this.renderer.xr.setFoveation(1.0);
      await this.renderer.xr.setSession(session);
      this.firstFramePending = true;
      document.body.classList.add('in-vr');
      step('VR を開始しました');
      setTimeout(() => { if (this.renderer.xr.isPresenting) this.status(''); }, 4000);
    } catch (e) {
      console.warn(e);
      this.status(`VR を始められませんでした: ${e && e.message ? e.message : e}`, true);
    } finally {
      this._starting = false;
    }
  }

  status(msg, error = false) {
    let el = document.getElementById('xr-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'xr-status';
      document.body.appendChild(el);
      el.onclick = () => el.classList.remove('on');
    }
    el.textContent = msg;
    el.classList.toggle('on', !!msg);
    el.classList.toggle('err', error);
  }

  _setupController(i) {
    const ctrl = this.renderer.xr.getController(i);
    const grip = this.renderer.xr.getControllerGrip(i);
    this.rig.add(ctrl, grip);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    line.scale.z = 6;
    line.visible = false;
    ctrl.add(line);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.12), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    body.position.z = 0.02;
    grip.add(body);
    const entry = { ctrl, grip, line, source: null, hand: '' };
    ctrl.addEventListener('connected', (e) => {
      entry.source = e.data;
      entry.hand = e.data.handedness;
      this.hands[entry.hand] = entry;
      line.visible = entry.hand === 'right';
      if (entry.hand === 'right') grip.add(this.menu);
    });
    ctrl.addEventListener('disconnected', () => {
      if (this.hands[entry.hand] === entry) delete this.hands[entry.hand];
      entry.source = null;
    });
  }

  // 右手のメニュー（建材と数）
  _buildMenu() {
    this.menuCanvas = document.createElement('canvas');
    this.menuCanvas.width = 512;
    this.menuCanvas.height = 160;
    this.menuTex = new THREE.CanvasTexture(this.menuCanvas);
    this.menuTex.colorSpace = THREE.SRGBColorSpace;
    this.menu = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.075),
      new THREE.MeshBasicMaterial({ map: this.menuTex, transparent: true, depthTest: false }));
    this.menu.renderOrder = 10;
    this.menu.position.set(0, 0.06, 0.02);
    this.menu.rotation.x = -0.9;
    this.refreshMenu();
  }

  refreshMenu() {
    if (!this.menuCanvas) return;
    const g = this.menuCanvas.getContext('2d');
    const W = 512, H = 160;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(30,24,18,0.82)';
    roundRect(g, 0, 0, W, H, 24);
    g.fill();
    const items = this.o.items;
    const sel = this.o.getSelected();
    const w = W / items.length;
    items.forEach((it, i) => {
      const x = i * w;
      if (i === sel) {
        g.fillStyle = '#f2c14e';
        roundRect(g, x + 6, 8, w - 12, H - 16, 16);
        g.fill();
      }
      g.fillStyle = i === sel ? '#2a1e10' : '#f4ead8';
      g.font = 'bold 30px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(it.label, x + w / 2, 64);
      g.font = 'bold 40px system-ui, sans-serif';
      g.fillText(it.kind === 'pickup' ? '⤺' : String(this.o.stock[it.kind] | 0), x + w / 2, 124);
    });
    this.menuTex.needsUpdate = true;
  }

  notice(text) {
    if (this._noticeMesh) this.camera.remove(this._noticeMesh);
    const c = document.createElement('canvas');
    c.width = 768; c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(20,16,12,0.8)';
    roundRect(g, 0, 0, 768, 96, 20);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 384, 50);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthTest: false }));
    m.renderOrder = 11;
    m.position.set(0, -0.25, -1.0);
    this.camera.add(m);
    this._noticeMesh = m;
    clearTimeout(this._nt);
    this._nt = setTimeout(() => { this.camera.remove(m); }, 3000);
  }

  // 頭の向き（ワールド）。XR のカメラの姿勢はリグの中のローカルなので、右スティックで回した分（turn）を足す
  headYaw() {
    const q = this.renderer.xr.getCamera().quaternion;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    return this.turn + Math.atan2(-f.x, -f.z);
  }

  // ゲームと同じく、頭の真下がいつもキャラの位置になるようにリグを置く（部屋の中で歩いた分を打ち消す）
  placeRig(playerPos) {
    const local = this.renderer.xr.getCamera().position;
    const off = new THREE.Vector3(local.x, 0, local.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.turn);
    this.rig.position.copy(playerPos).sub(off);
    this.rig.rotation.set(0, this.turn, 0);
  }

  aimRay(origin, dir) {
    const r = this.hands.right || this.hands.left;
    if (!r) { origin.set(0, -100, 0); dir.set(0, -1, 0); return; }
    r.ctrl.getWorldPosition(origin);
    dir.set(0, 0, -1).applyQuaternion(r.ctrl.getWorldQuaternion(new THREE.Quaternion())).normalize();
  }

  _pressed(hand, idx) {
    const e = this.hands[hand];
    const gp = e && e.source && e.source.gamepad;
    return !!(gp && gp.buttons[idx] && gp.buttons[idx].pressed);
  }

  _edge(hand, idx) {
    const key = hand + idx;
    const now = this._pressed(hand, idx);
    const prev = !!this._prev[key];
    this._prev[key] = now;
    return now && !prev ? 1 : (!now && prev ? -1 : 0);
  }

  _axes(hand) {
    const e = this.hands[hand];
    const gp = e && e.source && e.source.gamepad;
    if (!gp || !gp.axes) return [0, 0];
    const a = gp.axes;
    return a.length >= 4 ? [a[2], a[3]] : [a[0] || 0, a[1] || 0];
  }

  update(dt) {
    // 左スティック: 頭の向きを前として歩く（ゲームと同じ。あそびも同じ 0.22）
    const [lx, ly] = this._axes('left');
    const mv = new THREE.Vector2(lx, -ly);
    if (mv.length() < STICK_DEADZONE) mv.set(0, 0);
    if (mv.length() > 1) mv.normalize();
    this.move.copy(mv);
    this.sprint = this._pressed('left', 1);
    // 右スティック: ゲームの既定と同じなめらかな回転（LOOK_SENS × 2）。右スティックを押しこむとスナップ（30°）に切りかえ
    const [rx] = this._axes('right');
    if (this._edge('right', 3) === 1) {
      this.snapTurn = !this.snapTurn;
      this.notice(this.snapTurn ? '回転: スナップ（30°）' : '回転: なめらか');
    }
    if (this.snapTurn) {
      if (Math.abs(rx) >= 0.7) {
        if (!this._turnLatch) { this.turn -= Math.sign(rx) * SNAP_TURN; this._turnLatch = true; }
      } else if (Math.abs(rx) < 0.35) this._turnLatch = false;
    } else if (Math.abs(rx) >= STICK_DEADZONE) {
      this.turn -= rx * SMOOTH_TURN_SPEED * dt;
    }
    if (this._edge('left', 0) === 1) this.o.input.jump = true;
    this.jumpHeld = this._pressed('left', 0);
    const trig = this._edge('right', 0);
    if (trig === 1) {
      const o = new THREE.Vector3(), d = new THREE.Vector3();
      this.aimRay(o, d);
      if (!this.o.handleRay(o, d)) { this._placing = true; this.o.beginPress(); }
    } else if (trig === -1 && this._placing) {
      this._placing = false;
      this.o.endPress();
    }
    if (this._edge('right', 4) === 1) this.o.select(this.o.getSelected() + 1);
    if (this._edge('right', 5) === 1) this.o.select(this.o.getSelected() === 4 ? 0 : 4);
    // 左の X / Y でも切りかえ
    if (this._edge('left', 4) === 1) this.o.select(this.o.getSelected() - 1);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
