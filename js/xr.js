// VR（WebXR）。左スティックで頭の向きを前に歩く・右スティックでなめらかに向きを変える（押しこむとスナップ）・右の引き金で置く（押す: 床、長押し: 壁）
// 右手のメニュー: A で次の建材、B で回収に切りかえ。左の引き金でジャンプ、左のグリップで走る
import * as THREE from 'three';

const SNAP_TURN = Math.PI / 6;
// ゲームの GamepadAim.LOOK_SENS（1.35 rad/秒）を VR の主観では 2 倍にしている
const SMOOTH_TURN_SPEED = 1.35 * 2.0;
const STICK_DEADZONE = 0.22;
// 手首の扇（ゲームの BRACELET_* と同じ数）
const FAN_LIFT = 0.1;
const FAN_RADIUS = 0.24;
const FAN_STEP_DEG = 22.0;
const FAN_GAP_DEG = 9.0;
const FAN_SIDE_COUNT = 3;
const FAN_PIXEL = 0.00085;
const FAN_CUR_SCALE = 0.62;
const FAN_SIDE_SCALE = 0.36;
const FAN_SIDE_DIM = 0.86;
const FAN_GAIN = 1.3;
const FAN_PLATE = [0.12, 0.16, 0.25];
const FAN_COUNT_W = 0.06;
const lighten = (c, k) => c.map((v) => v + (1 - v) * k);
const css = (c, k) => `rgb(${c.map((v) => Math.round(Math.min(1, v * k) * 255)).join(',')})`;
// コントローラか（スティックがある）。SteamVR はコントローラを「手」としても報告する
const isCtrl = (src) => !!(src && src.gamepad && src.gamepad.axes && src.gamepad.axes.length >= 2);

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
      // WebGL は最初から xrCompatible で作ってあるので、ここで makeXRCompatible はしない
      step('1/3 VR の準備をしています…');
      step('2/3 ゴーグルに VR を頼んでいます…（ゴーグルの中を見てください）');
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      step('3/3 VR の画面を作っています…');
      this.renderer.xr.setReferenceSpaceType('local-floor');
      this.renderer.xr.setFoveation(1.0);
      // 新しい XRProjectionLayer を使わせず、従来の XRWebGLLayer にする（SteamVR で最初の画面が届かず「応答なし」になるため）
      // three.js は 'createProjectionLayer' in XRWebGLBinding.prototype で見るので、そのあいだだけ消す
      const proto = window.XRWebGLBinding && window.XRWebGLBinding.prototype;
      const saved = proto && Object.getOwnPropertyDescriptor(proto, 'createProjectionLayer');
      if (saved) delete proto.createProjectionLayer;
      try {
        await this.renderer.xr.setSession(session);
      } finally {
        if (saved) Object.defineProperty(proto, 'createProjectionLayer', saved);
      }
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
    // 位置・向きは targetRay（getController）を使う。手として報告されるとグリップの姿勢が更新されないため
    const ctrl = this.renderer.xr.getController(i);
    this.rig.add(ctrl);
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    line.scale.z = 6;
    line.visible = false;
    ctrl.add(line);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.12), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    body.position.z = 0.06;
    body.visible = false;
    ctrl.add(body);
    const entry = { ctrl, body, line, source: null, hand: '' };
    ctrl.addEventListener('connected', (e) => {
      const h = e.data.handedness;
      // 同じ手にコントローラがもうあるなら、スティックのない入力（手の追跡）ではおきかえない
      const cur = this.hands[h];
      if (cur && cur !== entry && isCtrl(cur.source) && !isCtrl(e.data)) return;
      entry.source = e.data;
      entry.hand = h;
      this.hands[h] = entry;
      line.visible = h === 'right';
      body.visible = true;
    });
    ctrl.addEventListener('disconnected', () => {
      if (this.hands[entry.hand] === entry) delete this.hands[entry.hand];
      body.visible = false;
      line.visible = false;
      entry.source = null;
    });
  }

  // 右手首の扇（ゲームの player_avatar_place_guide.gd の bracelet fan と同じ形・大きさ）。
  // 角丸の紺の板を手首の上に弧に並べ、目に向ける。持っている品は大きく明るく、両わきは小さく暗く。数は右下に「×N」
  _buildMenu() {
    this.fanRoot = new THREE.Group();
    this.fanRoot.visible = false;
    this.scene.add(this.fanRoot);
    this.fanSlots = this.o.items.map((it, i) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
      const spr = new THREE.Sprite(mat);
      spr.renderOrder = 60;
      this.fanRoot.add(spr);
      const slot = { i, it, c, tex, spr, img: null, cur: null, pen: null };
      if (it.art) {
        const img = new Image();
        img.onload = () => { slot.img = img; slot.cur = null; };
        img.src = it.art;
      }
      return slot;
    });
    // 数（×N）
    const cc = document.createElement('canvas');
    cc.width = 256; cc.height = 96;
    this.countTex = new THREE.CanvasTexture(cc);
    this.countTex.colorSpace = THREE.SRGBColorSpace;
    this.countCanvas = cc;
    this.countSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.countTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.countSpr.renderOrder = 100;
    this.countSpr.scale.set(FAN_COUNT_W, FAN_COUNT_W * 96 / 256, 1);
    this.fanRoot.add(this.countSpr);
    this._countText = '';
    this.fanPos = this.o.getSelected();
  }

  // 板を 1 枚描く（いま持っている板は明るく）
  _drawSlot(slot, cur) {
    const penHex = slot.it.kind === 'pen' && this.o.penColor ? this.o.penColor() : null;
    if (slot.cur === cur && slot.pen === penHex) return;
    slot.cur = cur;
    slot.pen = penHex;
    const g = slot.c.getContext('2d');
    const n = 256, r = n * 0.2, rim = n * 0.045;
    g.clearRect(0, 0, n, n);
    const base = cur ? lighten(FAN_PLATE, 0.18) : FAN_PLATE;
    // 縁（明るい）
    roundRect(g, 1, 1, n - 2, n - 2, r);
    g.fillStyle = css(base, 1.0 * FAN_GAIN);
    g.fill();
    // 中（上ほど明るい）
    const grad = g.createLinearGradient(0, 0, 0, n);
    grad.addColorStop(0, css(base, 0.86 * FAN_GAIN));
    grad.addColorStop(1, css(base, 0.72 * FAN_GAIN));
    roundRect(g, 1 + rim, 1 + rim, n - 2 - rim * 2, n - 2 - rim * 2, r - rim);
    g.fillStyle = grad;
    g.fill();
    // 絵（板の 8 割）
    const fill = n * 0.8, o = (n - fill) / 2;
    if (slot.img) {
      g.save();
      roundRect(g, o, o, fill, fill, r * 0.6);
      g.clip();
      const iw = slot.img.width, ih = slot.img.height, k = Math.max(fill / iw, fill / ih);
      g.drawImage(slot.img, n / 2 - iw * k / 2, n / 2 - ih * k / 2, iw * k, ih * k);
      g.restore();
    } else {
      if (penHex) {
        g.fillStyle = penHex;
        g.beginPath(); g.arc(n / 2, n / 2 - 18, n * 0.2, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = '#fff';
      g.font = 'bold 110px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(slot.it.kind === 'pen' ? '✎' : '⤺', n / 2, n / 2 - 18);
    }
    // 名前（暗い縁どり）
    g.font = `bold ${slot.it.label.length > 4 ? 30 : 38}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(5,8,15,0.95)';
    const ly = n * 0.8;
    g.strokeText(slot.it.label, n / 2, ly);
    g.fillStyle = '#fff';
    g.fillText(slot.it.label, n / 2, ly);
    slot.tex.needsUpdate = true;
  }

  refreshMenu() {
    if (!this.fanSlots) return;
    for (const s of this.fanSlots) s.cur = null;
  }

  // 毎フレーム（VR の描画の前）。手首の上に扇を置く
  updateFan(dt) {
    const r = this.hands.right;
    if (!r || !r.source) { this.fanRoot.visible = false; return; }
    this.fanRoot.visible = true;
    const n = this.fanSlots.length;
    const sel = this.o.getSelected();
    // いまの位置（小数の番号）をなめらかに追う（輪なので近いほうへ）
    let diff = sel - this.fanPos;
    diff -= Math.round(diff / n) * n;
    this.fanPos += diff * Math.min(1, 0.28 * dt * 60);
    this.fanPos = ((this.fanPos % n) + n) % n;
    // 手首（コントローラの付け根寄り）
    r.ctrl.updateMatrixWorld(true);
    const m = r.ctrl.matrixWorld;
    const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
    m.extractBasis(ax, ay, az);
    const wrist = new THREE.Vector3().setFromMatrixPosition(m).addScaledVector(az.normalize(), 0.02).addScaledVector(ay.normalize(), 0.02);
    // 目に向いた右・上
    const cam = this.renderer.xr.getCamera();
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), camZ = new THREE.Vector3();
    cam.matrixWorld.extractBasis(camRight, camUp, camZ);
    camRight.normalize(); camUp.normalize();
    const anchor = wrist.clone().addScaledVector(camUp, FAN_LIFT);
    for (const slot of this.fanSlots) {
      let d = slot.i - this.fanPos;
      d -= Math.round(d / n) * n;
      const ad = Math.abs(d);
      if (ad > FAN_SIDE_COUNT + 0.5) { slot.spr.visible = false; continue; }
      const deg = d * FAN_STEP_DEG + Math.sign(d) * Math.min(ad, 1) * FAN_GAP_DEG;
      const a = deg * Math.PI / 180;
      slot.spr.position.copy(anchor).addScaledVector(camRight, Math.sin(a) * FAN_RADIUS).addScaledVector(camUp, (Math.cos(a) - 1) * FAN_RADIUS);
      const near = Math.min(1, Math.max(0, 1 - ad));
      let sc = FAN_SIDE_SCALE * (1 + (0.72 - 1) * Math.min(1, Math.max(0, (ad - 1) / 2)));
      sc += (FAN_CUR_SCALE - sc) * near;
      const size = FAN_PIXEL * sc * 256;
      slot.spr.scale.set(size, size, 1);
      const dim = FAN_SIDE_DIM + (1 - FAN_SIDE_DIM) * near;
      const empty = slot.it.kind !== 'pickup' && slot.it.kind !== 'pen' && (this.o.stock[slot.it.kind] | 0) <= 0;
      slot.spr.material.color.setScalar(dim * (empty ? 0.6 : 1));
      // 真ん中に近いほど後に描く（手前に見える）
      slot.spr.renderOrder = 60 + Math.round((FAN_SIDE_COUNT + 1 - ad) * 3);
      slot.spr.visible = true;
      this._drawSlot(slot, slot.i === sel);
    }
    // 数は持っている板の右下の角（建材だけ）
    const it = this.o.items[sel];
    const showCount = !!it && it.kind !== 'pickup' && it.kind !== 'pen';
    this.countSpr.visible = showCount;
    if (showCount) {
      const cnt = this.o.stock[it.kind] | 0;
      const t = `×${cnt}`;
      if (t !== this._countText) {
        this._countText = t;
        const g = this.countCanvas.getContext('2d');
        g.clearRect(0, 0, 256, 96);
        g.font = 'bold 64px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineJoin = 'round';
        g.lineWidth = 12;
        g.strokeStyle = 'rgba(5,8,15,0.95)';
        g.strokeText(t, 128, 50);
        g.fillStyle = cnt > 0 ? '#ffffff' : '#ff7366';
        g.fillText(t, 128, 50);
        this.countTex.needsUpdate = true;
      }
      const half = FAN_PIXEL * FAN_CUR_SCALE * 256 * 0.5;
      this.countSpr.position.copy(anchor).addScaledVector(camRight, half * 0.95).addScaledVector(camUp, -half * 0.95)
        .addScaledVector(camPos.clone().sub(anchor).normalize(), 0.012);
    }
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
