// 縦の建材のよじ登り（ゲームの scripts/game/humanoid_wall_climb.gd の壁の部分を移したもの。数値も同じ）
// 壁へ向かって歩き続けると掴まる。W/S で上下、A/D で横。上端でのり越える。
// 離れる: Space = 上へ跳ぶ（leap_up）、S を 2 回 = 手を離す（drop）、下まで降りると離れる。
// 天井のぶら下がり（雲梯）はまだ無い。
import * as THREE from 'three';
import { yawAligned } from './wall.js';

const CLIMB_SPEED_V = 2.7;
const CLIMB_SPEED_H = 2.9;
const ENTER_INTO_DOT = 0.30;
const STICK_GAP = 0.48;
const CHEST_Y = 0.85;
const MANTLE_MARGIN = 0.38;
const CONTACT_GRACE = 0.55;
const HOP_VY_BLOCK = 2.0;
const TERRAIN_CLIMB_MIN_DY = 0.52;
const MANTLE_FAR_CLEAR = 0.20;
const REENTRY_BLOCK_SEC = 0.28;
const REENTRY_BLOCK_FLOOR_SEC = 0.55;
const BODY_R = 0.3;
const DROP_DOUBLE_TAP_MS = 280;
const UP = new THREE.Vector3(0, 1, 0);

export class Climber {
  // o: {pieces: () => Piece[], groundAt(x, z, feetY), insideWalk(x, z, r)}
  constructor(o) {
    this.o = o;
    this.active = false;
    this.piece = null;
    this.normal = new THREE.Vector3();
    this.topY = 0;
    this.anchorFloorY = 0;
    this.lost = 0;
    this.blockUntil = 0;
    this.lastSDown = 0;
    this.sHeld = false;
    this.upAxis = 0;
    this.sideAxis = 0;
  }

  _climbable(p) { return p && !p.isHorizontal && !p.isCurtain && !p.isRamp; }

  // 縦の建材の外向きの面の法線（pos の側）
  _faceNormal(p, pos) {
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(UP, p.yaw);
    if (n.dot(pos.clone().sub(p.position)) < 0) n.negate();
    n.y = 0;
    return n.normalize();
  }

  // 同じ場所に積んだ壁をたどった上端
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

  // 胸の高さからレイを飛ばして当たる縦の建材
  _rayWall(from, dir, reach) {
    let best = null, bestD = reach;
    for (const p of this.o.pieces()) {
      if (!this._climbable(p)) continue;
      if (Math.abs(p.position.x - from.x) > 3 || Math.abs(p.position.z - from.z) > 3) continue;
      const h = p.rayHitPoint(from, dir, bestD, 0.0);
      if (h) { const d = h.distanceTo(from); if (d < bestD) { bestD = d; best = { piece: p, point: h }; } }
    }
    return best;
  }

  // 歩いているときに毎フレーム呼ぶ。掴んだら true
  tryBegin(player, want) {
    if (this.active || performance.now() < this.blockUntil) return false;
    if (want.lengthSq() < 0.0001 || player.vel.y > HOP_VY_BLOCK) return false;
    const heading = want.clone().setY(0).normalize();
    const chest = player.pos.clone().add(new THREE.Vector3(0, CHEST_Y, 0));
    const hit = this._rayWall(chest, heading, BODY_R + 0.22);
    if (!hit) return false;
    const n = this._faceNormal(hit.piece, player.pos);
    if (heading.dot(n.clone().negate()) < ENTER_INTO_DOT) return false;
    const top = this._stackTop(hit.piece);
    if (top - player.pos.y < TERRAIN_CLIMB_MIN_DY * 0.85) return false;
    if (player.pos.y >= top - MANTLE_MARGIN * 0.5) return false;
    // 空中で足元のすぐ下に床があるときは掴まない（降りた直後の再吸着を防ぐ）
    if (!player.onGround && player.vel.y <= 0.35) {
      const g = this.o.groundAt(player.pos.x, player.pos.z, player.pos.y);
      if (player.pos.y - g <= 0.5) return false;
    }
    this.active = true;
    this.piece = hit.piece;
    this.normal.copy(n);
    this.topY = top;
    this.anchorFloorY = player.pos.y;
    this.lost = 0;
    // 面から STICK_GAP の所に張りつく
    const face = hit.point.clone();
    player.pos.x = face.x + n.x * STICK_GAP;
    player.pos.z = face.z + n.z * STICK_GAP;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    return true;
  }

  abort(blockSec = REENTRY_BLOCK_SEC) {
    this.active = false;
    this.piece = null;
    this.blockUntil = performance.now() + blockSec * 1000;
    this.upAxis = this.sideAxis = 0;
  }

  // 壁の上方向へ跳んで離れる（Space）
  leapUp(player) {
    if (!this.active) return;
    const n = this.normal.clone();
    player.pos.add(UP.clone().multiplyScalar(0.08)).add(n.clone().multiplyScalar(0.1));
    player.vel.copy(UP.clone().multiplyScalar(7.2).add(n.multiplyScalar(1.35)));
    this.abort();
  }

  // 手を離す（S を 2 回）
  drop(player) {
    if (!this.active) return;
    const n = this.normal.clone();
    player.pos.add(n.clone().multiplyScalar(0.12));
    player.vel.copy(n.multiplyScalar(2.2).add(new THREE.Vector3(0, -2.0, 0)));
    this.abort();
  }

  // S を 2 回押したか（押した瞬間ごとに呼ぶ）
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

  // 登っているあいだ毎フレーム。up: W(+)/S(-)、side: D(+)/A(-)
  tick(player, dt, up, side) {
    const upI = Math.max(-1, Math.min(1, up));
    const sideI = Math.max(-1, Math.min(1, side));
    this.upAxis = upI;
    this.sideAxis = sideI;
    const pos = player.pos;
    // 接触: 胸（上端より下）から壁へレイ。となりの壁・上の壁へ乗りかえる
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
      // 面との距離を保つ
      const d = new THREE.Vector3(pos.x - hit.point.x, 0, pos.z - hit.point.z).dot(this.normal);
      pos.addScaledVector(this.normal, STICK_GAP - d);
    } else {
      this.lost += dt;
      if (this.lost >= CONTACT_GRACE) { this.abort(); return; }
    }
    // S で足元の床まで降りたら離れる
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
    if (pos.y > this.topY - 0.02) pos.y = this.topY - 0.02;
    player.vel.set(0, 0, 0);
    player.onGround = false;
    // 上端でのり越える
    if (upI > 0.15 && pos.y >= this.topY - MANTLE_MARGIN) this._mantleOver(player);
  }

  _mantleOver(player) {
    const into = this.normal.clone().negate();
    const depth = STICK_GAP + (this.piece ? this.piece.pieceDepth() : 0.14) + BODY_R + MANTLE_FAR_CLEAR;
    const dest = player.pos.clone();
    dest.y = this.topY + 0.22;
    dest.addScaledVector(into, depth);
    if (!this.o.insideWalk(dest.x, dest.z, BODY_R)) return; // 屋上の外へは出ない（端で止まる）
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
    // 向こう側が低い: 奥へ跳んで降りる
    player.vel.copy(into.multiplyScalar(3.6)).add(new THREE.Vector3(0, 2.4, 0));
    player.onGround = false;
  }

  // 壁のほうを向く（体の向き）
  facing() { return Math.atan2(-this.normal.x, -this.normal.z); }
}
