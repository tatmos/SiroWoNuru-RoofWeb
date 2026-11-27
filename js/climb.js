// 建材のよじ登りと雲梯（ゲームの scripts/game/humanoid_wall_climb.gd の壁・天井の部分を移したもの。数値も同じ）
// 壁: 壁へ向かって歩き続けると掴まる。W/S で上下、A/D で横。上端でのり越える。
//      登っている途中で頭上に板の裏があれば雲梯へ。
// 雲梯: 空中で頭上の板の裏に届くとき、または板の端へ歩いたときに掴まる。W/S で前後、A/D で横。
//      進んだ先が縦の壁なら壁登りへ。Space で板を抜けて上へのり上がる（1 秒）。
// 離れる: Space = 壁は上へ跳ぶ（leap_up）／雲梯はのり上がる、S を 2 回 = 手を離す（drop）、壁は下まで降りると離れる。
import * as THREE from 'three';
import { yawAligned, WALL_W } from './wall.js';

const CLIMB_SPEED_V = 2.7;
const CLIMB_SPEED_H = 2.9;
const CEILING_SPEED = 2.85;
const CEILING_PASS_SEC = 1.0;
const ENTER_INTO_DOT = 0.30;
const STICK_GAP = 0.48;
const CEILING_STICK = 1.52; // 裏面から足元までの距離
const CHEST_Y = 0.85;
const RAY_REACH = 1.35;
const MANTLE_MARGIN = 0.38;
const CONTACT_GRACE = 0.55;
const HOP_VY_BLOCK = 2.0;
const TERRAIN_CLIMB_MIN_DY = 0.52;
const MANTLE_BODY_RADIUS = 0.42;
const MANTLE_FAR_CLEAR = 0.20;
const CEILING_REACH = 2.35;
const CEILING_RIM_GRACE = 0.85;
const CEILING_RIM_GRACE_AIR_GRAB = 1.15;
const REENTRY_BLOCK_SEC = 0.28;
const REENTRY_BLOCK_FLOOR_SEC = 0.55;
const REENTRY_BLOCK_STALL_SEC = 1.35;
const PROGRESS_STALL_ESCAPE_SEC = 1.15;
const CEILING_HANG_ESCAPE_SEC = 2.2;
const CEILING_DWELL_MOVE_EPS = 0.38;
const BODY_R = 0.3;
const DROP_DOUBLE_TAP_MS = 280;
const UP = new THREE.Vector3(0, 1, 0);
// 水平板の上へのり上げる奥行き（ゲームの _surface_mantle_depth）
const SLAB_MANTLE_DEPTH = STICK_GAP + WALL_W * 0.55 + MANTLE_BODY_RADIUS + MANTLE_FAR_CLEAR;

export class Climber {
  // o: {pieces: () => Piece[], groundAt(x, z, feetY), insideWalk(x, z, r), onMantleLand(fallH)}
  constructor(o) {
    this.o = o;
    this.active = false;
    this.mode = 'wall'; // 'wall' | 'ceiling' | 'pass'
    this.piece = null;
    this.normal = new THREE.Vector3();
    this.crawl = new THREE.Vector3(0, 0, -1);
    this.topY = 0;
    this.bottomY = 0;
    this.anchorFloorY = 0;
    this.lost = 0;
    this.blockUntil = 0;
    this.lastSDown = 0;
    this.sHeld = false;
    this.upAxis = 0;
    this.sideAxis = 0;
    this.rimGrace = 0;
    this.stall = 0;
    this.hangSec = 0;
    this.dwellRef = null;
    this.pass = null;
  }

  _climbable(p) { return p && !p.isHorizontal && !p.isCurtain && !p.isRamp; }
  _ceilingable(p) { return p && p.isHorizontal && !p.isCurtain; }

  _faceNormal(p, pos) {
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, p.yaw);
    if (n.dot(pos.clone().sub(p.position)) < 0) n.negate();
    n.y = 0;
    return n.normalize();
  }

  _stackTop(p) {
    let top = p.topY();
    let cur = p;
    for (let guard = 0; guard < 64; guard++) {
      const next = this.o.pieces().find((q) => q !== cur && this._climbable(q)
        && Math.hypot(q.position.x - cur.position.x, q.position.z - cur.position.z) < 0.06
        && yawAligned(q.yaw, cur.yaw) && Math.abs((q.position.y - q.shapeSize.y / 2) - top) < 0.1);
      if (!next) break;
      top = next.topY();
      cur = next;
    }
    return top;
  }

  // レイ: filter に合う建材への一番近い当たり
  _ray(from, dir, reach, filter) {
    let best = null, bestD = reach;
    const d = dir.clone().normalize();
    for (const p of this.o.pieces()) {
      if (!filter(p)) continue;
      if (Math.abs(p.position.x - from.x) > reach + 3 || Math.abs(p.position.z - from.z) > reach + 3) continue;
      const h = p.rayHitPoint(from, d, bestD, 0.0);
      if (h) { const dist = h.distanceTo(from); if (dist < bestD) { bestD = dist; best = { piece: p, point: h }; } }
    }
    return best;
  }

  _rayWall(from, dir, reach) { return this._ray(from, dir, reach, (p) => this._climbable(p)); }

  // 頭上の板の裏（ゲームの _find_overhead_underside: 低い起点から順に、真上と前ななめ上）
  _findOverhead(pos, hint) {
    const n = hint && hint.lengthSq() > 1e-4 ? hint.clone().setY(0).normalize() : this.normal.clone();
    const probes = [
      [0.08, UP, 1.85], [0.28, UP, 1.65], [0.55, UP, 1.45],
      [0.2, UP.clone().multiplyScalar(0.75).add(n).normalize(), 1.85],
      [0.45, UP.clone().multiplyScalar(0.55).add(n).normalize(), 1.75],
      [0.85, UP, 1.25],
    ];
    let best = null, bestGap = Infinity;
    for (const [fy, dir, len] of probes) {
      const from = pos.clone().add(new THREE.Vector3(0, fy, 0));
      const hit = this._ray(from, dir, len, (p) => this._ceilingable(p));
      if (!hit) continue;
      // 裏面（下向きの面）に当たったときだけ: 当たった点が板の上面より下
      if (hit.point.y > hit.piece.topY() - 0.01) continue;
      const gap = hit.point.y - pos.y;
      if (gap < -0.2 || gap > CEILING_STICK + 1.1) continue;
      if (gap < bestGap) { bestGap = gap; best = { piece: hit.piece, point: hit.point, gap }; }
    }
    return best;
  }

  // 歩いているとき・跳んでいるときに毎フレーム呼ぶ。掴んだら true
  tryBegin(player, want) {
    if (this.active || performance.now() < this.blockUntil) return false;
    if (want.lengthSq() < 0.0001 || player.vel.y > HOP_VY_BLOCK) return false;
    const heading = want.clone().setY(0).normalize();
    // 空中では頭上の板の裏を先に見る
    if (!player.onGround) {
      const over = this._findOverhead(player.pos, heading);
      if (over && this._beginCeiling(player, over.piece, over.point.y, heading, true)) return true;
    }
    // 胸の前: 水平板の端なら雲梯、縦の壁なら壁登り
    for (const hy of [0.35, CHEST_Y, 1.25]) {
      const from = player.pos.clone().add(new THREE.Vector3(0, hy, 0));
      const slab = this._ray(from, heading, BODY_R + 0.22, (p) => this._ceilingable(p));
      if (slab) {
        const bottom = slab.piece.position.y - slab.piece.pieceDepth() * 0.5;
        if (this._beginCeiling(player, slab.piece, bottom, heading, !player.onGround)) return true;
      }
    }
    const chest = player.pos.clone().add(new THREE.Vector3(0, CHEST_Y, 0));
    const hit = this._rayWall(chest, heading, BODY_R + 0.22);
    if (!hit) return false;
    const n = this._faceNormal(hit.piece, player.pos);
    if (heading.dot(n.clone().negate()) < ENTER_INTO_DOT) return false;
    const top = this._stackTop(hit.piece);
    if (top - player.pos.y < TERRAIN_CLIMB_MIN_DY * 0.85) return false;
    if (player.pos.y >= top - MANTLE_MARGIN * 0.5) return false;
    if (!player.onGround && player.vel.y <= 0.35) {
      const g = this.o.groundAt(player.pos.x, player.pos.z, player.pos.y);
      if (player.pos.y - g <= 0.5) return false;
    }
    this.active = true;
    this.mode = 'wall';
    this.piece = hit.piece;
    this.normal.copy(n);
    this.topY = top;
    this.anchorFloorY = player.pos.y;
    this.lost = 0;
    this.stall = 0;
    const face = hit.point.clone();
    player.pos.x = face.x + n.x * STICK_GAP;
    player.pos.z = face.z + n.z * STICK_GAP;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    return true;
  }

  // 雲梯を始める（板の裏の高さ bottom、這う向き crawl）
  _beginCeiling(player, piece, bottom, crawl, airGrab) {
    const gap = bottom - player.pos.y;
    // 板の角から足元だけが落ちたときは掴まない（ゲームと同じ最小の高さ）
    if (gap < CHEST_Y || gap > CEILING_REACH) return false;
    this.active = true;
    this.mode = 'ceiling';
    this.piece = piece;
    this.crawl.copy(crawl).setY(0).normalize();
    this.normal.copy(this.crawl);
    this.bottomY = bottom;
    this.topY = piece.topY();
    this.anchorFloorY = player.pos.y;
    this.lost = 0;
    this.stall = 0;
    this.hangSec = 0;
    this.dwellRef = null;
    this.rimGrace = airGrab ? CEILING_RIM_GRACE_AIR_GRAB : CEILING_RIM_GRACE;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    return true;
  }

  abort(blockSec = REENTRY_BLOCK_SEC) {
    this.active = false;
    this.mode = 'wall';
    this.piece = null;
    this.pass = null;
    this.blockUntil = performance.now() + blockSec * 1000;
    this.upAxis = this.sideAxis = 0;
  }

  // Space: 壁は上へ跳ぶ、雲梯は板を抜けてのり上がる
  leapUp(player) {
    if (!this.active) return;
    if (this.mode === 'pass') return;
    if (this.mode === 'ceiling') { this._beginPass(player); return; }
    const n = this.normal.clone();
    player.pos.add(UP.clone().multiplyScalar(0.08)).add(n.clone().multiplyScalar(0.1));
    player.vel.copy(UP.clone().multiplyScalar(7.2).add(n.multiplyScalar(1.35)));
    this.abort();
  }

  // 壁・雲梯から離れて外へ跳ぶ（行き詰まったとき）
  leapAway(player) {
    const n = this.normal.clone().setY(0).normalize();
    if (this.mode === 'ceiling') {
      player.pos.addScaledVector(n, 0.14);
      player.vel.copy(n.multiplyScalar(4.2)).add(new THREE.Vector3(0, -2.4, 0));
    } else {
      player.pos.addScaledVector(n, 0.16);
      player.vel.copy(n.multiplyScalar(6.2)).add(new THREE.Vector3(0, 4.4, 0));
    }
    this.abort();
  }

  // S を 2 回: 手を離す
  drop(player) {
    if (!this.active || this.mode === 'pass') return;
    if (this.mode === 'ceiling') {
      // 雲梯から手を離す: 真下へ落ちる
      player.vel.set(0, -3.6, 0);
      player.pos.y -= 0.08;
      this.abort();
      return;
    }
    const n = this.normal.clone();
    player.pos.add(n.clone().multiplyScalar(0.12));
    player.vel.copy(n.multiplyScalar(2.2).add(new THREE.Vector3(0, -2.0, 0)));
    this.abort();
  }

  noteDown(isDown) {
    let dbl = false;
    if (isDown && !this.sHeld) {
      const now = performance.now();
      if (now - this.lastSDown < DROP_DOUBLE_TAP_MS) dbl = true;
      this.lastSDown = now;
    }
    this.sHeld = isDown;
    return dbl;
  }

  tick(player, dt, up, side) {
    if (this.mode === 'pass') { this._tickPass(player, dt); return; }
    if (this.mode === 'ceiling') { this._tickCeiling(player, dt, up, side); return; }
    this._tickWall(player, dt, up, side);
  }

  _tickWall(player, dt, up, side) {
    const upI = Math.max(-1, Math.min(1, up));
    const sideI = Math.max(-1, Math.min(1, side));
    this.upAxis = upI;
    this.sideAxis = sideI;
    const pos = player.pos;
    const into = this.normal.clone().negate();
    const probeY = Math.min(pos.y + CHEST_Y, this.topY - 0.05);
    const hit = this._rayWall(new THREE.Vector3(pos.x, probeY, pos.z), into, STICK_GAP + 0.35)
      || this._rayWall(new THREE.Vector3(pos.x, pos.y + 0.2, pos.z), into, STICK_GAP + 0.35);
    if (hit) {
      this.lost = 0;
      if (hit.piece !== this.piece) {
        this.piece = hit.piece;
        this.normal.copy(this._faceNormal(hit.piece, pos));
      }
      this.topY = this._stackTop(hit.piece);
      const d = new THREE.Vector3(pos.x - hit.point.x, 0, pos.z - hit.point.z).dot(this.normal);
      pos.addScaledVector(this.normal, STICK_GAP - d);
    } else {
      this.lost += dt;
      if (this.lost >= CONTACT_GRACE) {
        // 頭上に板の裏があれば雲梯へ
        if (this._promoteToCeiling(player)) return;
        this.abort();
        return;
      }
    }
    // W 中に頭上の板の裏に届いたら雲梯へ（壁の手前へ這う）
    if (upI > 0.15 && this._promoteToCeiling(player)) return;
    if (upI < -0.05) {
      const g = this.o.groundAt(pos.x, pos.z, pos.y + 0.05);
      if (pos.y - g <= 0.06) {
        const leave = this.normal.clone();
        this.abort(REENTRY_BLOCK_FLOOR_SEC);
        pos.addScaledVector(leave, 0.34);
        player.vel.copy(leave.multiplyScalar(3.2)).add(new THREE.Vector3(0, -2.4, 0));
        return;
      }
    }
    const right = new THREE.Vector3(this.normal.z, 0, -this.normal.x);
    const move = right.multiplyScalar(sideI * CLIMB_SPEED_H * dt).add(new THREE.Vector3(0, upI * CLIMB_SPEED_V * dt, 0));
    const nx = pos.x + move.x, nz = pos.z + move.z;
    if (this.o.insideWalk(nx, nz, BODY_R)) { pos.x = nx; pos.z = nz; }
    pos.y += move.y;
    if (pos.y < this.anchorFloorY - 0.02) pos.y = this.anchorFloorY - 0.02;
    // 上端を超えない。頭上に板の裏があればその下で止める
    let yCap = this.topY - 0.02;
    const over = this._findOverhead(pos, this.normal);
    if (over) yCap = Math.min(yCap, over.point.y - CEILING_STICK);
    if (pos.y > yCap) pos.y = yCap;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    if (upI > 0.15 && pos.y >= this.topY - MANTLE_MARGIN) {
      if (this._promoteToCeiling(player)) return;
      this._mantleOver(player);
    }
  }

  // 壁から雲梯へ（這う向きは壁の手前）
  _promoteToCeiling(player) {
    const over = this._findOverhead(player.pos, this.normal);
    if (!over) return false;
    // 壁の上端より上の板（壁の上に乗っている天井の上面側）は、壁の上端でのり越える
    if (over.point.y > this.topY + 0.05 && this.mode === 'wall') return false;
    const crawl = this.normal.clone().setY(0).normalize();
    this.mode = 'ceiling';
    this.piece = over.piece;
    this.crawl.copy(crawl);
    this.bottomY = over.point.y;
    this.topY = over.piece.topY();
    this.lost = 0;
    this.stall = 0;
    this.hangSec = 0;
    this.dwellRef = null;
    this.rimGrace = CEILING_RIM_GRACE;
    return true;
  }

  // 雲梯から縦の壁へ（進んだ先に壁があるとき）
  _promoteToWall(player, wallHit) {
    const n = this._faceNormal(wallHit.piece, player.pos);
    this.mode = 'wall';
    this.piece = wallHit.piece;
    this.normal.copy(n);
    this.topY = this._stackTop(wallHit.piece);
    this.anchorFloorY = Math.min(this.anchorFloorY, player.pos.y);
    this.lost = 0;
    this.stall = 0;
    const d = new THREE.Vector3(player.pos.x - wallHit.point.x, 0, player.pos.z - wallHit.point.z).dot(n);
    player.pos.addScaledVector(n, STICK_GAP - d);
  }

  // 頭上の板の裏に触れているか（真上・裏の向き・前ななめ上）
  _refreshCeilingContact(pos) {
    const dirs = [UP, UP.clone().multiplyScalar(0.6).add(this.crawl).normalize()];
    for (const d of dirs) {
      const from = pos.clone().add(new THREE.Vector3(0, 0.2, 0));
      const hit = this._ray(from, d, CEILING_REACH + 0.35, (p) => this._ceilingable(p));
      if (!hit || hit.point.y > hit.piece.topY() - 0.01) continue;
      this.piece = hit.piece;
      this.bottomY = hit.point.y;
      this.topY = hit.piece.topY();
      return true;
    }
    return false;
  }

  _tickCeiling(player, dt, up, side) {
    const outI = Math.max(-1, Math.min(1, up));
    const sideI = Math.max(-1, Math.min(1, side));
    this.upAxis = outI;
    this.sideAxis = sideI;
    if (this.rimGrace > 0) this.rimGrace = Math.max(this.rimGrace - dt, 0);
    const pos = player.pos;
    if (this._refreshCeilingContact(pos)) this.lost = 0;
    else {
      this.lost += dt;
      if (this.lost >= CONTACT_GRACE) { this.abort(); return; }
    }
    // ぶら下がる高さ: 足元は裏面から CEILING_STICK 下（床より下へは行かない）
    // 床は、ぶら下がった足元より下だけを見る（groundAt は足元 + 0.45 まで拾う）
    const g = this.o.groundAt(pos.x, pos.z, this.bottomY - CEILING_STICK - 0.45);
    pos.y = Math.max(this.bottomY - CEILING_STICK, Number.isFinite(g) ? g : -Infinity);
    const crawl = this.crawl.clone();
    const right = UP.clone().cross(crawl).normalize();
    const idle = Math.abs(outI) < 0.12 && Math.abs(sideI) < 0.12;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    if (idle) { this.stall = 0; this.hangSec = 0; this.dwellRef = null; return; }
    const move = crawl.multiplyScalar(outI * CEILING_SPEED * dt).add(right.multiplyScalar(sideI * CEILING_SPEED * dt));
    // 縦の壁に当たったら止めて、壁登りへ
    const dir = move.clone().setY(0);
    if (dir.lengthSq() > 1e-8) {
      const wallHit = this._rayWall(pos.clone().add(new THREE.Vector3(0, CHEST_Y, 0)), dir, BODY_R + move.length() + 0.05);
      if (wallHit) { this._promoteToWall(player, wallHit); return; }
    }
    const nx = pos.x + move.x, nz = pos.z + move.z;
    if (this.o.insideWalk(nx, nz, BODY_R)) { pos.x = nx; pos.z = nz; }
    // 同じ所に居座っているか（入力しているのに進めない）
    if (!this.dwellRef) this.dwellRef = pos.clone();
    const net = pos.distanceTo(this.dwellRef);
    if (net < CEILING_DWELL_MOVE_EPS && this.rimGrace <= 0) { this.stall += dt; this.hangSec += dt; }
    else { this.dwellRef = pos.clone(); this.stall = Math.max(this.stall - dt * 0.85, 0); this.hangSec = Math.max(this.hangSec - dt * 1.25, 0); }
    if (this.rimGrace <= 0 && (this.stall >= PROGRESS_STALL_ESCAPE_SEC || this.hangSec >= CEILING_HANG_ESCAPE_SEC)) {
      this.leapAway(player);
      this.blockUntil = performance.now() + REENTRY_BLOCK_STALL_SEC * 1000;
    }
  }

  // 雲梯から板を抜けて上面へ（ゲームの ceiling pass: 1 秒かけて動き、最後に前上へ跳ぶ）
  _beginPass(player) {
    const out = this.crawl.clone().setY(0).normalize();
    const dist = Math.max(SLAB_MANTLE_DEPTH * 0.88, 0.55);
    const dest = player.pos.clone();
    dest.y = this.topY + 0.16;
    dest.addScaledVector(out, dist);
    if (!this.o.insideWalk(dest.x, dest.z, BODY_R)) {
      // 屋上の外へは出ない: 真上へ抜ける
      dest.x = player.pos.x;
      dest.z = player.pos.z;
    }
    this.mode = 'pass';
    this.pass = { from: player.pos.clone(), to: dest, out, t: 0 };
  }

  _tickPass(player, dt) {
    const p = this.pass;
    p.t = Math.min(p.t + dt / CEILING_PASS_SEC, 1);
    const u = p.t * p.t * (3 - 2 * p.t);
    player.pos.lerpVectors(p.from, p.to, u);
    player.vel.set(0, 0, 0);
    if (p.t < 1) return;
    player.pos.copy(p.to);
    const fall = Math.max(this.topY - this.anchorFloorY, 0.9);
    this.abort();
    player.vel.copy(p.out.clone().multiplyScalar(2.8)).add(new THREE.Vector3(0, 1.6, 0));
    if (this.o.onMantleLand) this.o.onMantleLand(fall);
  }

  _mantleOver(player) {
    const into = this.normal.clone().negate();
    const depth = STICK_GAP + (this.piece ? this.piece.pieceDepth() : 0.14) + BODY_R + MANTLE_FAR_CLEAR;
    const dest = player.pos.clone();
    dest.y = this.topY + 0.22;
    dest.addScaledVector(into, depth);
    if (!this.o.insideWalk(dest.x, dest.z, BODY_R)) return;
    const top = this.topY;
    player.pos.copy(dest);
    // 着地先: のり越え位置の 0.6m 上から下へ（groundAt は足元 + 0.45 まで拾うので、その分を引く）
    const land = this.o.groundAt(dest.x, dest.z, dest.y + 0.6 - 0.45);
    this.abort();
    if (land >= top - 0.55) {
      player.pos.y = land;
      player.vel.set(0, 0, 0);
      player.onGround = true;
      return;
    }
    player.vel.copy(into.multiplyScalar(3.6)).add(new THREE.Vector3(0, 2.4, 0));
    player.onGround = false;
  }

  // 体の向き: 壁は壁のほう、雲梯は這う向き
  facing() {
    const f = this.mode === 'wall' ? this.normal.clone().negate() : this.crawl;
    return Math.atan2(f.x, f.z);
  }
}
