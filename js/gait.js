// 地上の歩き・走りを手続きで作る（ゲームの scripts/game/procedural_gait.gd を three.js に移したもの。数値も同じ）。
// 土台は待機クリップ。その上に、速さに合わせた歩幅と歩調で両足を置き（接地中は床に止まる＝滑らない）、
// 足は床・段差の高さに合わせて 2 ボーン IK で届かせる。腰の上下・前傾・腕振りもここで足す。
// weight を滑らかに上げ下げするので、ジャンプや登攀などクリップとの切り替えもつながる。
import * as THREE from 'three';

const HIP_NAMES = ['Hip', 'Hips', 'hips', 'mixamorig_Hips', 'mixamorigHips'];
const WAIST_NAMES = ['Waist', 'Spine', 'spine', 'mixamorig_Spine', 'mixamorigSpine'];
const HEAD_NAMES = ['Head', 'head', 'mixamorig_Head', 'mixamorigHead'];
const LEG_NAMES = {
  l: [['L_Thigh', 'LeftUpLeg', 'mixamorigLeftUpLeg'], ['L_Calf', 'LeftLeg', 'mixamorigLeftLeg'], ['L_Foot', 'LeftFoot', 'mixamorigLeftFoot']],
  r: [['R_Thigh', 'RightUpLeg', 'mixamorigRightUpLeg'], ['R_Calf', 'RightLeg', 'mixamorigRightLeg'], ['R_Foot', 'RightFoot', 'mixamorigRightFoot']],
};
const ARM_NAMES = {
  l: [['L_Upperarm', 'LeftArm', 'mixamorigLeftArm'], ['L_Forearm', 'LeftForeArm', 'mixamorigLeftForeArm']],
  r: [['R_Upperarm', 'RightArm', 'mixamorigRightArm'], ['R_Forearm', 'RightForeArm', 'mixamorigRightForeArm']],
};

const REF_LEG = 0.45;
const RUN_FROM = 1.8;
const RUN_FULL = 4.5;
const MAX_CADENCE = 9.5;
const MAX_STANCE_TRAVEL = 1.05;
const RAY_UP = 0.55;
const RAY_DOWN = 1.2;
const MAX_HIP_DROP = 0.3;
const HIP_DROP_SHARE = 0.7;
const BLEND_IN = 7.0;
const BLEND_OUT = 9.0;
const ANKLE_H = 0.03;

const UP = new THREE.Vector3(0, 1, 0);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const moveToward = (v, to, d) => (Math.abs(to - v) <= d ? to : v + Math.sign(to - v) * d);
const fposmod = (a, b) => ((a % b) + b) % b;
const deg = (d) => d * Math.PI / 180;

function findBone(root, names) {
  for (const n of names) {
    let hit = null;
    root.traverse((o) => { if (!hit && o.isBone && o.name === n) hit = o; });
    if (hit) return hit;
  }
  return null;
}

function isDescendant(o, ancestor) {
  for (let p = o.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

const _m = new THREE.Matrix4();
const _pq = new THREE.Quaternion();
const _ps = new THREE.Vector3();
const _pp = new THREE.Vector3();
function worldPos(b) { return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); }
function worldQuat(b) { const q = new THREE.Quaternion(); b.matrixWorld.decompose(_pp, q, _ps); return q; }

// 骨をワールドの位置・向きに置く（親から局所へ戻す。子も更新する）
function setWorld(b, pos, quat) {
  b.parent.updateWorldMatrix(true, false);
  _m.copy(b.parent.matrixWorld).invert();
  const lp = pos.clone().applyMatrix4(_m);
  b.parent.matrixWorld.decompose(_pp, _pq, _ps);
  const lq = _pq.clone().invert().multiply(quat);
  b.position.copy(lp);
  b.quaternion.copy(lq);
  b.updateMatrixWorld(true);
}

function arc(from, to) {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return new THREE.Quaternion();
  const a = from.clone().normalize(), b = to.clone().normalize();
  const c = a.dot(b);
  if (c > 0.99999) return new THREE.Quaternion();
  if (c < -0.99999) {
    let ortho = a.clone().cross(new THREE.Vector3(1, 0, 0));
    if (ortho.lengthSq() < 1e-6) ortho = a.clone().cross(UP);
    return new THREE.Quaternion().setFromAxisAngle(ortho.normalize(), Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(a, b);
}

export class ProceduralGait {
  // root: モデル（骨を含む）。floorAt(x, z, refY): 足元の床の高さ（無ければ refY）
  constructor(root, floorAt) {
    this.root = root;
    this.floorAt = floorAt;
    this.ok = this._resolve();
    this.gaitOn = false;
    this.w = 0;
    this.gait = 0;
    this.run = 0;
    this.phase = 0;
    this.vel = new THREE.Vector3();
    this.lastPos = null;
    this.drop = 0;
    this.lean = 0;
    this.target = { l: null, r: null };
    this.ground = { l: NaN, r: NaN };
    this.liftGround = { l: NaN, r: NaN };
    this.wasSwing = { l: false, r: false };
    this.floorRef = NaN;
  }

  _resolve() {
    this.hip = findBone(this.root, HIP_NAMES);
    this.waist = findBone(this.root, WAIST_NAMES);
    this.head = findBone(this.root, HEAD_NAMES);
    this.leg = {};
    this.arm = {};
    for (const s of ['l', 'r']) {
      const ids = LEG_NAMES[s].map((n) => findBone(this.root, n));
      if (ids.includes(null)) return false;
      this.leg[s] = ids;
      const a = ARM_NAMES[s].map((n) => findBone(this.root, n));
      if (!a.includes(null)) this.arm[s] = a;
    }
    if (!this.hip) return false;
    // 毎フレーム、クリップをかける前にこの骨を元の姿勢へ戻す（クリップが触らない成分が積み重ならないように）
    this.bones = [this.hip, this.waist, this.head, ...this.leg.l, ...this.leg.r, ...(this.arm.l || []), ...(this.arm.r || [])].filter(Boolean);
    this.rest = this.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));
    return true;
  }

  // mixer.update の前に呼ぶ
  restore() {
    if (!this.ok) return;
    this.bones.forEach((b, i) => { b.position.copy(this.rest[i].p); b.quaternion.copy(this.rest[i].q); });
  }

  // 体の位置から速さと足元の床を測る（ゲームの _physics_process）
  measure(dt, bodyPos) {
    if (dt <= 0) return;
    let v = new THREE.Vector3();
    if (this.lastPos) {
      v = bodyPos.clone().sub(this.lastPos).divideScalar(dt);
      if (v.length() > 40) v.set(0, 0, 0);
    }
    this.lastPos = bodyPos.clone();
    v.y = 0;
    this.vel.lerp(v, 1 - Math.exp(-14 * dt));
    if (this.w <= 0.001 && !this.gaitOn) {
      this.ground.l = this.ground.r = NaN;
      this.floorRef = NaN;
      return;
    }
    this.floorRef = this._rayFloor(bodyPos.x, bodyPos.z, bodyPos.y);
    for (const s of ['l', 'r']) {
      const t = this.target[s] || bodyPos;
      this.ground[s] = this._rayFloor(t.x, t.z, bodyPos.y);
    }
  }

  _rayFloor(x, z, refY) {
    const y = this.floorAt(x, z, refY + RAY_UP);
    if (!Number.isFinite(y) || y < refY - RAY_DOWN) return refY;
    return y;
  }

  // mixer.update の後に呼ぶ（ゲームの _process_modification_with_delta）
  apply(dt, bodyPos, bodyYaw) {
    if (!this.ok) return;
    const want = this.gaitOn ? 1 : 0;
    this.w = moveToward(this.w, want, (this.gaitOn ? BLEND_IN : BLEND_OUT) * Math.max(dt, 0));
    if (this.w <= 0.001) { this.phase = 0; return; }
    this.root.updateMatrixWorld(true);
    // 混ぜる前（クリップの姿勢）を残す
    const before = this.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }));

    const [thighL, calfL, footL] = this.leg.l;
    const legLen = worldPos(thighL).distanceTo(worldPos(calfL)) + worldPos(calfL).distanceTo(worldPos(footL));
    if (legLen < 0.05) return;
    const k = legLen / REF_LEG;

    const fwd = new THREE.Vector3(Math.sin(bodyYaw), 0, Math.cos(bodyYaw));
    const right = fwd.clone().cross(UP).normalize();
    const speed = this.vel.length();
    const move = speed > 0.05 ? this.vel.clone().divideScalar(speed) : fwd.clone();

    this.gait = moveToward(this.gait, smoothstep(0.12, 0.8, speed), 5.0 * dt);
    this.run = moveToward(this.run, smoothstep(RUN_FROM, RUN_FULL, speed), 3.0 * dt);
    const duty = lerp(0.62, 0.34, this.run);
    let stepLen = Math.min(k * (0.17 + 0.105 * speed), MAX_STANCE_TRAVEL * legLen / (2.0 * duty));
    stepLen = Math.max(stepLen, 0.05 * k);
    const cadence = Math.min(speed / stepLen, MAX_CADENCE);
    if (speed > 0.05) {
      stepLen = speed / Math.max(cadence, 0.01);
      this.phase = fposmod(this.phase + dt * cadence * 0.5, 1.0);
    }
    const half = duty * stepLen;
    const liftH = k * lerp(0.07, 0.15, this.run);
    const floorRef = Number.isNaN(this.floorRef) ? bodyPos.y : this.floorRef;

    const hipW = worldPos(this.hip);
    const base = new THREE.Vector3(hipW.x, floorRef, hipW.z);
    const targets = {}, stance = {};
    for (const s of ['l', 'r']) {
      const [thigh, , foot] = this.leg[s];
      const footAnim = worldPos(foot);
      const thighW = worldPos(thigh);
      const lat = thighW.clone().sub(hipW).dot(right) * lerp(1.0, 0.7, this.run);
      const u = fposmod(this.phase + (s === 'l' ? 0 : 0.5), 1.0);
      let along = 0, lift = 0;
      const inStance = u < duty;
      if (inStance) along = lerp(half, -half, u / duty);
      else {
        const t = (u - duty) / (1 - duty);
        along = lerp(-half, half, smoothstep(0, 1, t));
        lift = Math.sin(Math.PI * t) * liftH;
      }
      const gxz = base.clone().addScaledVector(move, along).addScaledVector(right, lat);
      let ground = Number.isNaN(this.ground[s]) ? floorRef : this.ground[s];
      // 遊脚は持ち上げた床から下ろす床へ（段差をなめらかに）
      if (!inStance) {
        if (!this.wasSwing[s] || Number.isNaN(this.liftGround[s])) this.liftGround[s] = ground;
        const s2 = (u - duty) / (1 - duty);
        ground = lerp(this.liftGround[s], ground, smoothstep(0, 1, s2));
        if (ground < this.liftGround[s] && s2 < 0.5) ground = this.liftGround[s];
      }
      this.wasSwing[s] = !inStance;
      const gaitT = new THREE.Vector3(gxz.x, ground + ANKLE_H * k + lift, gxz.z);
      const idleGround = Number.isNaN(this.ground[s]) ? floorRef : this.ground[s];
      const idleT = footAnim.clone().add(new THREE.Vector3(0, idleGround - floorRef, 0));
      targets[s] = idleT.lerp(gaitT, this.gait);
      this.target[s] = new THREE.Vector3(lerp(footAnim.x, gxz.x, this.gait), 0, lerp(footAnim.z, gxz.z, this.gait));
      stance[s] = (inStance || this.gait < 0.5) ? 1.0 : 0.35;
    }

    // 腰を下げる量: 足が届く高さまで
    let drop = 0;
    const reach = legLen * 0.985;
    for (const s of ['l', 'r']) {
      const thighW = worldPos(this.leg[s][0]);
      const t = targets[s];
      const dh = Math.hypot(t.x - thighW.x, t.z - thighW.z);
      const vert = Math.sqrt(Math.max(reach * reach - dh * dh, 0));
      drop = Math.max(drop, (thighW.y - (t.y + vert)) * stance[s]);
    }
    drop = clamp(drop * HIP_DROP_SHARE, 0, MAX_HIP_DROP * k);
    const amp = k * lerp(0.012, 0.03, this.run) * this.gait;
    const bob = amp * Math.cos(Math.PI * 2 * 2.0 * (this.phase - duty * 0.5)) * lerp(1.0, -1.0, this.run);
    const kd = 1 - Math.exp(-18 * dt);
    this.drop = this.drop < drop ? lerp(this.drop, drop, kd) : lerp(this.drop, drop, kd * 0.5);
    const shift = new THREE.Vector3(0, bob - this.drop, 0);

    // 腰を動かす（脚の付け根が腰の子でなければ、それも同じだけ動かす）
    if (shift.lengthSq() > 0) {
      setWorld(this.hip, hipW.clone().add(shift), worldQuat(this.hip));
      for (const s of ['l', 'r']) {
        const th = this.leg[s][0];
        if (!isDescendant(th, this.hip)) setWorld(th, worldPos(th).add(shift), worldQuat(th));
      }
    }

    // 前傾と腕振り
    const leanWant = deg(lerp(3.0, 11.0, this.run)) * this.gait;
    this.lean = lerp(this.lean, leanWant, 1 - Math.exp(-6 * dt));
    const leanAxis = move.clone().cross(UP).normalize();
    if (this.waist && Math.abs(this.lean) > 0.0005) {
      const q = new THREE.Quaternion().setFromAxisAngle(leanAxis, -this.lean);
      setWorld(this.waist, worldPos(this.waist), q.multiply(worldQuat(this.waist)));
      if (this.head) {
        const qh = new THREE.Quaternion().setFromAxisAngle(leanAxis, this.lean * 0.6);
        setWorld(this.head, worldPos(this.head), qh.multiply(worldQuat(this.head)));
      }
    }
    this._swingArms(fwd, duty);

    // 脚 IK（膝は前へ）
    for (const s of ['l', 'r']) this._solveLeg(this.leg[s], targets[s], fwd);

    // 混ぜる（ジャンプ・登攀との切り替え）
    if (this.w < 0.999) {
      this.bones.forEach((b, i) => {
        b.position.lerpVectors(before[i].p, b.position.clone(), this.w);
        b.quaternion.copy(before[i].q.clone().slerp(b.quaternion.clone(), this.w));
      });
      this.root.updateMatrixWorld(true);
    }
  }

  _swingArms(fwd, duty) {
    const down = new THREE.Vector3(0, -1, 0);
    const axis = down.clone().cross(fwd).normalize();
    for (const s of ['l', 'r']) {
      if (!this.arm[s]) continue;
      // 反対側の足が前のとき前へ
      const u = fposmod(this.phase + (s === 'l' ? 0.5 : 0.0), 1.0);
      const swing = u < duty ? lerp(1, -1, u / duty) : lerp(-1, 1, smoothstep(0, 1, (u - duty) / (1 - duty)));
      const amp = deg(lerp(16.0, 38.0, this.run)) * this.gait;
      const [upper, fore] = this.arm[s];
      const q = new THREE.Quaternion().setFromAxisAngle(axis, swing * amp + deg(4.0) * this.gait);
      setWorld(upper, worldPos(upper), q.multiply(worldQuat(upper)));
      // 走りは肘を曲げる
      const bend = deg(lerp(8.0, 55.0, this.run)) * this.gait;
      const qb = new THREE.Quaternion().setFromAxisAngle(axis, bend);
      setWorld(fore, worldPos(fore), qb.multiply(worldQuat(fore)));
    }
  }

  // 2 ボーン IK。足首を t へ、膝は pole 側へ。足の向きはクリップのまま
  _solveLeg([thigh, calf, foot], t, pole) {
    const h = worldPos(thigh), kn = worldPos(calf), f = worldPos(foot);
    const footQ = worldQuat(foot);
    const a = h.distanceTo(kn), b = kn.distanceTo(f);
    if (a < 0.0001 || b < 0.0001) return;
    const toT = t.clone().sub(h);
    const d = clamp(toT.length(), Math.abs(a - b) + 0.001, (a + b) * 0.999);
    const dir = toT.lengthSq() > 1e-8 ? toT.clone().normalize() : f.clone().sub(h).normalize();
    let p = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
    if (p.lengthSq() < 1e-6) { const kh = kn.clone().sub(h); p = kh.sub(dir.clone().multiplyScalar(kh.dot(dir))); }
    p.normalize();
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const knee = h.clone().addScaledVector(dir, a * cosA).addScaledVector(p, a * Math.sqrt(Math.max(1 - cosA * cosA, 0)));
    const tip = h.clone().addScaledVector(dir, d);
    const q1 = arc(kn.clone().sub(h), knee.clone().sub(h));
    setWorld(thigh, h, q1.multiply(worldQuat(thigh)));
    const kn2 = worldPos(calf);
    const q2 = arc(worldPos(foot).sub(kn2), tip.clone().sub(kn2));
    setWorld(calf, kn2, q2.multiply(worldQuat(calf)));
    setWorld(foot, tip, footQ);
  }
}
