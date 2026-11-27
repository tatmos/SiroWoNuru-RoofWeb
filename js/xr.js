// VR（WebXR）。左スティックで頭の向きを前に歩く・右スティックでなめらかに向きを変える（押しこむとスナップ）・右の引き金で置く（押す: 床、長押し: 壁）
// 右手のメニュー: A で次の建材、B で回収に切りかえ。左の引き金でジャンプ、左のグリップで走る
import * as THREE from 'three';

const SNAP_TURN = Math.PI / 6;
// ゲームの GamepadAim.LOOK_SENS（1.35 rad/秒）を VR の主観では 2 倍にしている
const SMOOTH_TURN_SPEED = 1.35 * 2.0;
const STICK_DEADZONE = 0.22;
// ゲームの GamepadAim.SHOULDER_TAP_MS（グリップの短押し）
const SHOULDER_TAP_MS = 220;
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
    this.fanOpen = false;
    this.fanCursor = 0;
    this._aConsumed = false;
    this._cycleLatch = 0;
    this.grip_left = -1;
    this.grip_right = -1;
    this._menuDirty = true;
    for (let i = 0; i < 2; i++) this._setupController(i);
    renderer.xr.addEventListener('sessionend', () => { document.body.classList.remove('in-vr'); this.fanOpen = false; this.o.onEnd(); });
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
      this.notice('右の引き金で置く（長押しで壁） ／ B でメニュー');
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
  // 角丸の紺の板を手首の上に弧に並べ、目に向ける。カーソルの板は大きく、両わきは小さく暗く。数は右下に「×N」。
  // 中身はデスクトップの扇と同じページ（いちばん上 → マジックペンの靴 → 7 色。ゲームの入れ物の 2 階層目と同じ）
  _buildMenu() {
    this.fanRoot = new THREE.Group();
    this.fanRoot.visible = false;
    this.scene.add(this.fanRoot);
    this.fanSlots = [];
    this.fanPageName = '';
    this.fanImgs = {};
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
    this._setFanPage('main');
    this.fanPos = this.fanCursor;
  }

  // ページの板を作りなおす
  _setFanPage(name, keepCursor = -1) {
    for (const s of this.fanSlots) { this.fanRoot.remove(s.spr); s.tex.dispose(); s.spr.material.dispose(); }
    const pg = this.o.fanPage(name);
    this.fanPageName = name;
    this.fanEntries = pg.entries;
    const n = this.fanEntries.length;
    this.fanCursor = keepCursor >= 0 ? Math.min(keepCursor, n - 1) : Math.max(0, Math.min(n - 1, pg.cursor | 0));
    this.fanPos = this.fanCursor;
    this.fanSlots = this.fanEntries.map((e, i) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      spr.renderOrder = 60;
      spr.visible = false;
      this.fanRoot.add(spr);
      return { i, e, c, tex, spr, key: null };
    });
  }

  _img(url) {
    let im = this.fanImgs[url];
    if (!im) {
      im = new Image();
      im.onload = () => this.refreshMenu();
      im.src = url;
      this.fanImgs[url] = im;
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  // 板を 1 枚描く（持っている品・いまの色は明るく）
  _drawSlot(slot, cur) {
    const e = slot.e;
    const img = e.art ? this._img(e.art) : null;
    const key = `${cur}|${e.swatch || ''}|${img ? 1 : 0}|${e.label}`;
    if (slot.key === key) return;
    slot.key = key;
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
    const sw = e.swatch ? swatchFill(g, e.swatch, n) : null;
    if (img) {
      g.save();
      roundRect(g, o, o, fill, fill, r * 0.6);
      g.clip();
      const iw = img.width, ih = img.height, k = Math.max(fill / iw, fill / ih);
      g.drawImage(img, n / 2 - iw * k / 2, n / 2 - ih * k / 2, iw * k, ih * k);
      g.restore();
    } else if (sw && !e.sym) {
      // 色の見本（靴のテーマ・ペンの色）
      roundRect(g, o + 10, o + 4, fill - 20, fill - 46, r * 0.5);
      g.fillStyle = sw;
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.stroke();
    } else {
      if (sw) {
        g.fillStyle = sw;
        g.beginPath(); g.arc(n / 2, n / 2 - 18, n * 0.2, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = '#fff';
      g.font = 'bold 110px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(e.sym || '', n / 2, n / 2 - 18);
    }
    // 名前（暗い縁どり）
    const lab = String(e.label);
    g.font = `bold ${lab.length > 5 ? 26 : (lab.length > 4 ? 30 : 38)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(5,8,15,0.95)';
    g.strokeText(lab, n / 2, n * 0.8, n * 0.86);
    g.fillStyle = '#fff';
    g.fillText(lab, n / 2, n * 0.8, n * 0.86);
    slot.tex.needsUpdate = true;
  }

  refreshMenu() {
    if (!this.fanSlots) return;
    for (const s of this.fanSlots) s.key = null;
  }

  // 毎フレーム（VR の描画の前）。手首の上に扇を置く
  updateFan(dt) {
    const r = this.hands.right;
    if (!r || !r.source) { this.fanRoot.visible = false; return; }
    this.fanRoot.visible = true;
    // 閉じているあいだは、いちばん上のページの持っている品の板だけを手首に出す（ゲームの held_only）
    if (!this.fanOpen && this.fanPageName !== 'main') this._setFanPage('main');
    const n = this.fanSlots.length;
    const held = this.o.getSelected();
    const sel = this.fanOpen ? this.fanCursor : held;
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
      if (ad > FAN_SIDE_COUNT + 0.5 || (!this.fanOpen && slot.i !== held)) { slot.spr.visible = false; continue; }
      const deg = d * FAN_STEP_DEG + Math.sign(d) * Math.min(ad, 1) * FAN_GAP_DEG;
      const a = deg * Math.PI / 180;
      slot.spr.position.copy(anchor).addScaledVector(camRight, Math.sin(a) * FAN_RADIUS).addScaledVector(camUp, (Math.cos(a) - 1) * FAN_RADIUS);
      const near = Math.min(1, Math.max(0, 1 - ad));
      let sc = FAN_SIDE_SCALE * (1 + (0.72 - 1) * Math.min(1, Math.max(0, (ad - 1) / 2)));
      sc += (FAN_CUR_SCALE - sc) * near;
      const size = FAN_PIXEL * sc * 256;
      slot.spr.scale.set(size, size, 1);
      const dim = FAN_SIDE_DIM + (1 - FAN_SIDE_DIM) * near;
      const empty = slot.e.empty && slot.e.empty();
      slot.spr.material.color.setScalar(dim * (empty ? 0.6 : 1));
      // 真ん中に近いほど後に描く（手前に見える）
      slot.spr.renderOrder = 60 + Math.round((FAN_SIDE_COUNT + 1 - ad) * 3);
      slot.spr.visible = true;
      this._drawSlot(slot, !!(slot.e.held && slot.e.held()));
    }
    // 数はカーソルの板の右下の角（建材だけ）
    const ent = this.fanEntries[sel];
    const showCount = !!(ent && ent.empty && ent.count);
    this.countSpr.visible = showCount;
    if (showCount) {
      const cnt = Number(ent.count()) | 0;
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

  // ゲームの VR と同じボタン（xr_rig.gd → パッドの割り当て → player_avatar_gamepad.gd）
  //   左スティック 歩く ／ 左スティック押しこみ（押しているあいだ） 走る
  //   右スティック 向きを変える
  //   A ジャンプ ／ B 扇（メニュー）を出す・閉じる。扇を出しているあいだは A・右の引き金で決定、右スティックで選ぶ
  //   右の引き金 置く（押す: 床、長押し: 壁） ／ 左の引き金 回収 ／ 左の引き金を押したまま右の引き金 取り消し
  //   グリップを短く押す 建材の切りかえ（左 前・右 次）
  update(dt) {
    const [lx, ly] = this._axes('left');
    const mv = new THREE.Vector2(lx, -ly);
    if (mv.length() < STICK_DEADZONE) mv.set(0, 0);
    if (mv.length() > 1) mv.normalize();
    this.move.copy(mv);
    // 扇を開いて歩きだしたら閉じる（ゲームの _tick_pad_fan と同じ）
    if (this.fanOpen && mv.length() > 0.5) this.closeFan();
    this.sprint = this._pressed('left', 3);
    // 右スティックを押しこむと、回転をなめらか／スナップ（30°）に切りかえ（Web 版だけ）
    const [rx] = this._axes('right');
    if (this._edge('right', 3) === 1) {
      this.snapTurn = !this.snapTurn;
      this.notice(this.snapTurn ? '回転: スナップ（30°）' : '回転: なめらか');
    }
    if (this.fanOpen) {
      // 扇を開いているあいだの右スティック左右はカーソル（向きは変えない）（ゲームの _poll_place_stick_cycle: 0.62 で入り 0.32 で戻る）
      if (rx > 0.62) {
        if (this._cycleLatch !== 1) { this._cycleLatch = 1; this._cycle(1); }
      } else if (rx < -0.62) {
        if (this._cycleLatch !== -1) { this._cycleLatch = -1; this._cycle(-1); }
      } else if (Math.abs(rx) < 0.32) this._cycleLatch = 0;
    } else {
      this._cycleLatch = 0;
      if (this.snapTurn) {
        if (Math.abs(rx) >= 0.7) {
          if (!this._turnLatch) { this.turn -= Math.sign(rx) * SNAP_TURN; this._turnLatch = true; }
        } else if (Math.abs(rx) < 0.35) this._turnLatch = false;
      } else if (Math.abs(rx) >= STICK_DEADZONE) {
        this.turn -= rx * SMOOTH_TURN_SPEED * dt;
      }
    }
    // A: 扇を開いているあいだは決定だけ（ジャンプしない）。閉じていればジャンプ
    const a = this._edge('right', 4);
    if (a === 1 && this.fanOpen) { this.confirmFan(); this._aConsumed = true; }
    else if (a === 1) { this.o.input.jump = true; this._aConsumed = false; }
    this.jumpHeld = this._pressed('right', 4) && !this._aConsumed;
    // B: 扇を出す／閉じる（デスクトップの右クリックと同じ。閉じるときは持ちかえない）
    if (this._edge('right', 5) === 1) {
      if (this.fanOpen) this.closeFan();
      else this.openFan();
    }
    // グリップの短押し（220ms 以内）で切りかえ
    for (const [hand, dir] of [['left', -1], ['right', 1]]) {
      const g = this._edge(hand, 1);
      const key = `grip_${hand}`;
      if (g === 1) this[key] = performance.now();
      else if (g === -1 && this[key] >= 0) {
        if (performance.now() - this[key] <= SHOULDER_TAP_MS) { this._cycle(dir); }
        this[key] = -1;
      }
    }
    // 左の引き金: 回収（押して離すと、ねらった建材を回収）
    const lt = this._edge('left', 0);
    const ltHeld = this._pressed('left', 0);
    const trig = this._edge('right', 0);
    if (trig === 1 && ltHeld) {
      // 左を押したまま右: 取り消し（回収はしない）
      if (this._picking) { this._picking = false; this.o.endPickup(true); }
      if (this._placing) { this._placing = false; this.o.endPress(true); }
      this.o.undo();
      this._undoUntilRelease = true;
    } else if (trig === 1 && this.fanOpen) {
      // 扇を開いているあいだの右の引き金は決定（置かない）
      this.confirmFan();
    } else if (trig === 1) {
      const o = new THREE.Vector3(), d = new THREE.Vector3();
      this.aimRay(o, d);
      if (!this.o.handleRay(o, d)) { this._placing = true; this.o.beginPress(); }
    } else if (trig === -1 && this._placing) {
      this._placing = false;
      this.o.endPress(false);
    }
    if (lt === 1 && !this._placing) { this._picking = true; this._undoUntilRelease = false; this.o.beginPickup(); }
    else if (lt === -1 && this._picking) { this._picking = false; this.o.endPickup(this._undoUntilRelease); }
    if (lt === -1) this._undoUntilRelease = false;
  }

  // スティック・グリップ: 扇を開いてカーソルを動かす（持ちかえは A か右の引き金で決めたとき。ゲームの fan_step）
  _cycle(dir) {
    if (!this.fanOpen) this.openFan();
    const n = this.fanEntries.length;
    this.fanCursor = (this.fanCursor + dir + n) % n;
    this._pulse('right', 0.3, 30);
  }

  // ゲームの fan_confirm: カーソルの項目を決める。次のページ（ペンの色など）が返れば、扇は開いたままそのページへ
  confirmFan() {
    if (!this.fanOpen) return;
    const e = this.fanEntries[this.fanCursor];
    const next = e && e.run ? e.run() : null;
    this._pulse('right', 0.45, 50);
    if (!next) { this.fanOpen = false; this._setFanPage('main'); return; }
    // 同じページのまま（取り消しなど）は、カーソルをその項目に残す
    this._setFanPage(next, next === this.fanPageName ? this.fanCursor : -1);
  }

  closeFan() {
    this.fanOpen = false;
    this._setFanPage('main');
  }

  openFan(page = 'main') {
    if (this.fanOpen && this.fanPageName === page) return;
    this.fanOpen = true;
    this._setFanPage(page);
    if (this._placing) { this._placing = false; this.o.endPress(true); }
    this._pulse('right', 0.4, 50);
  }

  _pulse(hand, amp, ms) {
    const e = this.hands[hand];
    const gp = e && e.source && e.source.gamepad;
    const h = gp && gp.hapticActuators && gp.hapticActuators[0];
    try { if (h && h.pulse) h.pulse(amp, ms); } catch { /* 振動できない機種 */ }
  }
}

// 見本の色。'#rrggbb' か、デスクトップの扇の linear-gradient(...) から色を拾って斜めのグラデーションにする
function swatchFill(g, sw, n) {
  const cols = String(sw).match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/g);
  if (!cols || !cols.length) return null;
  if (cols.length === 1) return cols[0];
  const gr = g.createLinearGradient(0, 0, n, n);
  cols.forEach((c, i) => gr.addColorStop(i / (cols.length - 1), c));
  return gr;
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
