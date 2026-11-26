// 屋上の建材（ゲームの scripts/game/placeable_wall.gd の六角の建材の部分を JS に移したもの）。
// 座標は Godot と同じ（y が上、右手系）。yaw は y 軸まわりの回転で、three.js の rotation.y と同じ向き。
import * as THREE from 'three';

export const WALL_W = 2.2;
export const SEGMENT_H = WALL_W;
export const WALL_D = WALL_W / 8.0;
export const KINDS = ['wall', 'glass', 'curtain', 'marble'];
const SQRT3 = Math.sqrt(3.0);
const UP = new THREE.Vector3(0, 1, 0);

export function isBuildingKind(kind) {
  return KINDS.includes(kind);
}

// --- 小さな道具 ---
export const xz = (v) => new THREE.Vector2(v.x, v.z);
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const isEqualApprox = (a, b) => Math.abs(a - b) < 0.00001 * Math.max(1, Math.abs(a), Math.abs(b)) || a === b;
const wrapf = (v, lo, hi) => { const r = hi - lo; return lo + (((v - lo) % r) + r) % r; };
const angleDifference = (from, to) => { const d = (to - from) % (Math.PI * 2); return ((2 * d) % (Math.PI * 2)) - d; };
const snappedf = (v, step) => (step !== 0 ? Math.floor(v / step + 0.5) * step : v);
export const yawAlong = (yaw) => v3(Math.cos(yaw), 0, -Math.sin(yaw));
export const yawNormal = (yaw) => v3(Math.sin(yaw), 0, Math.cos(yaw));
const fromAngle = (a) => new THREE.Vector2(Math.cos(a), Math.sin(a));
const angleToPoint = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

export function closestPointToSegment(p, a, b) {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  if (l2 <= 0) return a.clone();
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / l2));
  return a.clone().add(ab.multiplyScalar(t));
}

export function yawFromAlong(along) {
  const flat = v3(along.x, 0, along.z !== undefined ? along.z : along.y);
  if (flat.lengthSq() < 0.0001) return 0.0;
  flat.normalize();
  return Math.atan2(-flat.z, flat.x);
}

export function yawAligned(a, b) {
  const d = Math.abs(wrapf(a - b, -Math.PI, Math.PI));
  return d < 0.35 || Math.abs(d - Math.PI) < 0.35;
}

// 六角セルの中心の三角形（center が六角の中心、point が入っている扇形）
export function hexTriangle(center, side, point) {
  const sector = Math.floor((angleToPoint(center, point) + Math.PI * 0.5) / (Math.PI / 3.0));
  const angle = sector * Math.PI / 3.0 - Math.PI * 0.5;
  return [
    center.clone(),
    center.clone().add(fromAngle(angle).multiplyScalar(side)),
    center.clone().add(fromAngle(angle + Math.PI / 3.0).multiplyScalar(side)),
  ];
}

export function nearestTriangleEdge(tri, point) {
  let edge = null;
  let nearest = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    const d = point.distanceToSquared(closestPointToSegment(point, a, b));
    if (d < nearest) { nearest = d; edge = [a, b]; }
  }
  return edge;
}

// placeable_wall.gd の triangle_mesh と同じ点（ローカル）
export function trianglePoints(side, pitch = 0.0) {
  const height = side * SQRT3 * 0.5;
  const depth = side / 16.0;
  const pts = [
    v3(-side * 0.5, depth, height / 3.0),
    v3(side * 0.5, depth, height / 3.0),
    v3(0.0, depth, -height * 2.0 / 3.0),
  ];
  for (let i = 0; i < 3; i++) pts.push(pts[i].clone().sub(v3(0, depth * 2.0, 0)));
  const t = Math.tan(pitch);
  for (const p of pts) p.y += p.z * t;
  return pts;
}
export const TRIANGLE_FACES = [
  [0, 2, 1], [3, 4, 5], [0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4], [2, 0, 3], [2, 3, 5],
];

// --- 建材 1 つ ---
export class Piece {
  // row: {kind, pos: Vector3, yaw, horizontal, pitch, span_x, stacks, paint_color: [r,g,b,a] | null}
  constructor(row) {
    this.row = row;
    this.kind = row.kind || 'wall';
    this.isGlass = this.kind === 'glass';
    this.isCurtain = this.kind === 'curtain';
    this.isMarble = this.kind === 'marble';
    this.stackCount = Math.max(1, row.stacks | 0 || 1);
    this.isHorizontal = !!row.horizontal;
    const pSpan = Number(row.span_x) || 0;
    const pitch = Number(row.pitch) || 0;
    this.rampPitch = (!this.isHorizontal || (pSpan < 0 && Math.abs(pitch) > 0.05 && Math.abs(pitch) < 1.45)) ? pitch : 0.0;
    this.isRamp = !this.isHorizontal && Math.abs(this.rampPitch) > 0.05;
    this.hexPiece = pSpan < 0 && Number.isFinite(pSpan) && !this.isRamp;
    this.spanX = (this.hexPiece || pSpan > 0.05) ? Math.abs(pSpan) : WALL_W;
    this.isFaceDiag = !this.hexPiece && !this.isHorizontal && !this.isRamp && this.spanX > WALL_W * 1.15;
    this.yaw = Number(row.yaw) || 0;
    this.paintColor = row.paint_color || null;
    const pos = row.pos;
    if (this.isRamp) {
      this.floorY = pos.y - rampLength() * 0.5 * Math.cos(Math.abs(this.rampPitch));
      this.position = pos.clone();
    } else if (this.isHorizontal) {
      this.floorY = pos.y - this.pieceDepth() * 0.5;
      this.position = pos.clone();
    } else {
      this.floorY = pos.y;
      this.position = v3(pos.x, this.floorY + this.segmentHeight() * this.stackCount * 0.5, pos.z);
    }
    if (this.hexPiece && this.isHorizontal) {
      this.localPoints = trianglePoints(this.spanX, this.rampPitch);
      this.shapeSize = null;
    } else if (this.isHorizontal) {
      this.shapeSize = v3(WALL_W, WALL_D, WALL_W);
    } else if (this.isRamp) {
      this.shapeSize = v3(WALL_W, rampLength(), WALL_D);
    } else {
      this.shapeSize = v3(this.spanX, this.segmentHeight() * this.stackCount, this.pieceDepth());
    }
  }

  segmentHeight() { return this.hexPiece ? this.spanX : SEGMENT_H; }
  pieceDepth() { return this.hexPiece ? this.spanX / 8.0 : WALL_D; }
  isHexSlope() { return this.hexPiece && this.isHorizontal && Math.abs(this.rampPitch) > 0.05; }
  serializedSpan() { return this.hexPiece ? -this.spanX : this.spanX; }

  toLocal(p) { return p.clone().sub(this.position).applyAxisAngle(UP, -this.yaw); }
  toGlobal(p) { return p.clone().applyAxisAngle(UP, this.yaw).add(this.position); }
  basisZ() { return v3(0, 0, 1).applyAxisAngle(UP, this.yaw); }

  topY() {
    if (this.isHorizontal) {
      let rise = 0.0;
      if (this.isHexSlope()) {
        const shear = this.spanX * SQRT3 / 6.0 * Math.tan(this.rampPitch);
        rise = Math.max(shear, -2.0 * shear);
      }
      return this.position.y + this.pieceDepth() * 0.5 + rise;
    }
    if (this.isRamp) return this.position.y + rampLength() * 0.5 * Math.abs(Math.cos(this.rampPitch));
    return this.position.y + this.segmentHeight() * this.stackCount * 0.5;
  }

  planeY() { return this.isHorizontal ? this.position.y : this.topY(); }

  // 局所の三角の面（ワールド座標）
  worldTriangles() {
    if (!this.localPoints) return [];
    return TRIANGLE_FACES.map((f) => f.map((i) => this.toGlobal(this.localPoints[i])));
  }

  // レイと建材の交点（無ければ null）。ゲームの ray_hit_point と同じく、近すぎる交点（0.05 未満）は見ない
  rayHitPoint(from, dir, maxDist = 220.0, minDist = 0.05) {
    if (dir.lengthSq() < 0.0001) return null;
    const d = dir.clone().normalize();
    const lf = this.toLocal(from);
    const ld = d.clone().applyAxisAngle(UP, -this.yaw);
    if (this.hexPiece && this.isHorizontal) {
      let nearest = maxDist;
      const ray = new THREE.Ray(lf, ld);
      const hit = new THREE.Vector3();
      for (const f of TRIANGLE_FACES) {
        const a = this.localPoints[f[0]], b = this.localPoints[f[1]], c = this.localPoints[f[2]];
        if (ray.intersectTriangle(a, b, c, false, hit)) {
          const dist = lf.distanceTo(hit);
          if (dist >= minDist && dist < nearest) nearest = dist;
        }
      }
      return nearest < maxDist ? from.clone().add(d.multiplyScalar(nearest)) : null;
    }
    const half = this.shapeSize.clone().multiplyScalar(0.5);
    let tmin = 0.0, tmax = maxDist;
    for (const axis of ['x', 'y', 'z']) {
      const o = lf[axis], dd = ld[axis], mn = -half[axis], mx = half[axis];
      if (Math.abs(dd) < 0.000001) {
        if (o < mn || o > mx) return null;
        continue;
      }
      let t1 = (mn - o) / dd, t2 = (mx - o) / dd;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    if (tmin < minDist) return null;
    return from.clone().add(d.multiplyScalar(tmin));
  }

  // 上から見て (x, z) が板の三角の中か
  horizontalCoversXZ(x, z) {
    if (!this.isHorizontal) return false;
    const l = this.toLocal(v3(x, this.position.y, z));
    if (!this.hexPiece) {
      const half = WALL_W * 0.5 + 0.02;
      return Math.abs(l.x) <= half && Math.abs(l.z) <= half;
    }
    const height = this.spanX * SQRT3 * 0.5;
    const fromApex = l.z + height * 2.0 / 3.0;
    return fromApex <= height && Math.abs(l.x) <= fromApex / SQRT3;
  }

  // 板の上の面の y（(x, z) が三角の中のとき）
  surfaceYAt(x, z) {
    const l = this.toLocal(v3(x, this.position.y, z));
    return this.position.y + this.pieceDepth() * 0.5 + l.z * Math.tan(this.rampPitch);
  }
}

export function rampLength() { return Math.sqrt(WALL_W * WALL_W + SEGMENT_H * SEGMENT_H); }

// --- 置き場所 ---
// world: {pieces: Piece[], gridAt(Vector2) -> Vector3(cx, side, cz), floorAt(x, z) -> y}

export function piecesNear(world, pos, radius) {
  const r2 = radius * radius;
  return world.pieces.filter((p) => p.position.distanceToSquared(pos) <= r2);
}

export function isWallSlotTaken(world, pos, yaw, horizontal, serializedWidth = 0.0, moving = null) {
  if (serializedWidth < 0.0) {
    const side = -serializedWidth;
    const height = side * (moving ? moving.stackCount : 1);
    for (const wall of piecesNear(world, pos, Math.max(side, WALL_W) * 1.6)) {
      if (wall === moving || wall.isHorizontal !== horizontal || wall.isRamp || wall.isHexSlope()) continue;
      if (xz(wall.position).distanceTo(xz(pos)) > side * 0.04) continue;
      if (horizontal) {
        if (Math.abs(wall.planeY() - pos.y) < (side / 8.0 + wall.pieceDepth()) * 0.5) return true;
      } else if (yawAligned(wall.yaw, yaw) && pos.y < wall.topY() - 0.005
          && pos.y + height > wall.topY() - wall.segmentHeight() * wall.stackCount + 0.005) {
        return true;
      }
    }
    return false;
  }
  // 古い四角の建材（このページでは置かない）
  return false;
}

export function isHexSlopeSlotTaken(world, pos, side, moving = null) {
  for (const wall of piecesNear(world, pos, side)) {
    if (wall !== moving && wall.isHexSlope() && wall.position.distanceTo(pos) < side * 0.06) return true;
  }
  return false;
}

function hexSlopeFromWall(world, wall, hit, aim) {
  if (wall.isHorizontal || wall.isCurtain) return null;
  const side = wall.spanX;
  const top = wall.topY();
  if (hit.y < top - side * 0.25) return null;
  const run = side * SQRT3 * 0.5;
  let normal = yawNormal(wall.yaw);
  if (normal.dot(aim) > 0.0) normal = normal.negate();
  const center = wall.position.clone().add(normal.clone().multiplyScalar(run / 3.0));
  for (const floor of piecesNear(world, center, side)) {
    if (!floor.hexPiece || !floor.isHorizontal || floor.isHexSlope() || !isEqualApprox(floor.spanX, side)) continue;
    if (xz(floor.position).distanceTo(xz(center)) > side * 0.04) continue;
    const low = floor.topY();
    const rise = top - low;
    if (rise < side * 0.75 || rise > side * 1.25) continue;
    center.y = low + rise * (2.0 / 3.0);
    return {
      ok: !isHexSlopeSlotTaken(world, center, side), pos: center,
      yaw: Math.atan2(-normal.x, -normal.z), pitch: Math.atan2(rise, run), span_x: -side,
      horizontal: true, elevated: true, snap: 'hex_slope',
    };
  }
  return null;
}

function hexSlopeFromFloor(world, floor, hit) {
  const side = floor.spanX;
  const run = side * SQRT3 * 0.5;
  const corners = [
    floor.toGlobal(v3(-side * 0.5, 0.0, run / 3.0)),
    floor.toGlobal(v3(side * 0.5, 0.0, run / 3.0)),
    floor.toGlobal(v3(0.0, 0.0, -run * 2.0 / 3.0)),
  ];
  let edgeIndex = -1;
  let nearest = side * 0.2;
  for (let i = 0; i < 3; i++) {
    const p = closestPointToSegment(xz(hit), xz(corners[i]), xz(corners[(i + 1) % 3]));
    const dist = p.distanceTo(xz(hit));
    if (dist < nearest) { nearest = dist; edgeIndex = i; }
  }
  if (edgeIndex < 0) return null;
  const tip = corners[(edgeIndex + 2) % 3];
  const base = corners[edgeIndex].clone().add(corners[(edgeIndex + 1) % 3]).multiplyScalar(0.5);
  const low = floor.topY();
  let bestRise = 0.0;
  for (const support of piecesNear(world, tip, side)) {
    if (!support.hexPiece || support.isCurtain || !isEqualApprox(support.spanX, side)) continue;
    if (support.isHorizontal && !support.isHexSlope()) continue;
    const top = support.topY() - (support.isHexSlope() ? support.pieceDepth() * 0.5 : 0.0);
    const rise = top - low;
    if (rise < side * 0.75 || rise > side * 1.25) continue;
    let upperEdge = support.position.clone();
    if (support.isHexSlope() && support.rampPitch < 0.0) {
      const upperTip = support.toGlobal(v3(0.0, 0.0, -run * 2.0 / 3.0));
      if (xz(upperTip).distanceTo(xz(tip)) > side * 0.06) continue;
    } else {
      if (support.isHexSlope()) upperEdge = support.toGlobal(v3(0.0, 0.0, run / 3.0));
      const halfEdge = yawAlong(support.yaw).multiplyScalar(side * 0.5);
      if (Math.min(xz(upperEdge.clone().add(halfEdge)).distanceTo(xz(tip)),
        xz(upperEdge.clone().sub(halfEdge)).distanceTo(xz(tip))) > side * 0.06) continue;
    }
    if (bestRise === 0.0 || rise < bestRise) bestRise = rise;
  }
  if (bestRise === 0.0) return null;
  const center = v3(floor.position.x, low + bestRise / 3.0, floor.position.z);
  const normal = base.clone().sub(center);
  return {
    ok: !isHexSlopeSlotTaken(world, center, side), pos: center,
    yaw: Math.atan2(normal.x, normal.z), pitch: -Math.atan2(bestRise, run), span_x: -side,
    horizontal: true, elevated: true, snap: 'hex_slope',
  };
}

export function resolveHexPlacement(world, pos, aim, vertical) {
  let point = xz(pos);
  let grid = world.gridAt(point);
  if (grid.y <= 0.0) return null;
  const side = grid.y;
  let height = pos.y;
  let elevated = false;
  let surface = null;
  if (aim.lengthSq() > 0.01) {
    const dir = aim.clone().normalize();
    for (const wall of piecesNear(world, pos, side * 1.5)) {
      if (!wall.hexPiece || wall.isHexSlope()) continue;
      const hit = wall.rayHitPoint(pos.clone().sub(dir.clone().multiplyScalar(0.12)), dir, 0.24);
      if (hit && hit.distanceTo(pos) <= 0.04) { surface = wall; break; }
    }
  }
  if (surface) {
    if (!vertical) {
      const slope = surface.isHorizontal ? hexSlopeFromFloor(world, surface, pos)
        : hexSlopeFromWall(world, surface, pos, aim);
      if (slope) return slope;
    }
    elevated = true;
    height = surface.planeY();
    if (surface.isHorizontal) {
      if (vertical) {
        height -= surface.pieceDepth() * 0.5;
      } else {
        const center = xz(surface.position);
        const anchor = world.gridAt(center);
        const tri = hexTriangle(new THREE.Vector2(anchor.x, anchor.z), side, center);
        const edge = nearestTriangleEdge(tri, point);
        point = edge[0].clone().add(edge[1]).sub(center);
      }
    } else {
      point = xz(surface.position);
      if (!vertical) {
        height += side / 16.0;
        const normal = xz(surface.basisZ());
        const sign = normal.dot(xz(aim)) > 0.0 ? -1.0 : 1.0;
        point.add(normal.multiplyScalar(sign * side * 0.2));
      }
    }
  }
  grid = world.gridAt(point);
  if (!isEqualApprox(grid.y, side)) {
    return { ok: false, pos, yaw: 0.0, span_x: -side, horizontal: !vertical };
  }
  const tri = hexTriangle(new THREE.Vector2(grid.x, grid.z), side, point);
  let snapped = tri[0].clone().add(tri[1]).add(tri[2]).divideScalar(3.0);
  const alongBase = tri[1].clone().sub(tri[2]);
  let yaw = yawFromAlong(v3(alongBase.x, 0, alongBase.y));
  if (vertical) {
    const edge = nearestTriangleEdge(tri, point);
    snapped = edge[0].clone().add(edge[1]).multiplyScalar(0.5);
    const along = edge[1].clone().sub(edge[0]);
    yaw = yawFromAlong(v3(along.x, 0, along.y));
  }
  if (!elevated) {
    const floorY = world.floorAt(pos.x, pos.z);
    if (Number.isFinite(floorY) && floorY > -900.0 && height < floorY + Math.min(0.35, side * 0.25)) height = floorY;
    if (!vertical) height += side / 16.0;
  }
  const target = v3(snapped.x, height, snapped.y);
  return {
    pos: target, yaw, pitch: 0.0, span_x: -side,
    horizontal: !vertical, elevated: true, snap: elevated ? 'hex_extend' : '',
    ok: Number.isFinite(target.x + target.y + target.z) && !isWallSlotTaken(world, target, yaw, !vertical, -side),
  };
}

export function resolveBuildingPlacement(world, kind, pos, aim, vertical) {
  if (kind !== 'curtain') return resolveHexPlacement(world, pos, aim, vertical);
  const target = { ok: false, pos, yaw: 0.0, span_x: 0.0, snap: 'curtain', elevated: true };
  if (aim.lengthSq() < 0.01) return target;
  const dir = aim.clone().normalize();
  for (const support of piecesNear(world, pos, WALL_W * 2.0)) {
    if (!support.hexPiece || support.isHexSlope() || !(support.isHorizontal || support.isCurtain)) continue;
    const hit = support.rayHitPoint(pos.clone().sub(dir.clone().multiplyScalar(0.12)), dir, 0.24);
    if (!hit || hit.distanceTo(pos) > 0.04) continue;
    const side = support.spanX;
    let center = xz(support.position);
    let yaw = support.yaw;
    let top = support.topY() - support.segmentHeight();
    if (support.isHorizontal) {
      const cell = world.gridAt(center);
      if (!isEqualApprox(cell.y, side)) continue;
      const edge = nearestTriangleEdge(hexTriangle(new THREE.Vector2(cell.x, cell.z), side, center), xz(pos));
      center = edge[0].clone().add(edge[1]).multiplyScalar(0.5);
      const along = edge[1].clone().sub(edge[0]);
      yaw = yawFromAlong(v3(along.x, 0, along.y));
      top = support.planeY() - support.pieceDepth() * 0.5;
    }
    const bottom = v3(center.x, top - side, center.y);
    return {
      ok: !isWallSlotTaken(world, bottom, yaw, false, -side),
      pos: bottom, yaw, span_x: -side, snap: 'curtain', elevated: true, support,
    };
  }
  return target;
}

// --- 六角の格子（ゲームの overworld_gen.gd の hex_index_at / hex_center。CELL = 64 / 32） ---
export const CELL = 2.0;
export const HEX_R = CELL / SQRT3;
export const HEX_VERT = CELL * SQRT3 * 0.5;
const roundHalfAway = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));

function axialRound(q, r) {
  const s = -q - r;
  let rq = roundHalfAway(q), rr = roundHalfAway(r);
  const rs = roundHalfAway(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

export function hexIndexAt(x, z) {
  const q = (SQRT3 / 3.0 * x - (1.0 / 3.0) * z) / HEX_R;
  const r = ((2.0 / 3.0) * z) / HEX_R;
  const [rx, ry] = axialRound(q, r);
  const row = Math.trunc(ry);
  const col = Math.trunc(rx + (ry - (row & 1)) * 0.5);
  return [col, row];
}

export function hexCenter(ix, iz) {
  return new THREE.Vector2(CELL * (ix + 0.5 * (iz & 1)), HEX_VERT * iz);
}

export function gridAt(point) {
  const [ix, iz] = hexIndexAt(point.x, point.y);
  const c = hexCenter(ix, iz);
  return v3(c.x, HEX_R, c.y);
}

export { snappedf, angleDifference };
