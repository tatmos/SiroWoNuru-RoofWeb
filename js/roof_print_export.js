// 屋上に置いた建材を 3D プリンタ用の 3MF にする（ゲームの scripts/game/roof_print_export.gd を JS に移したもの）。
//   1 段目       台と、その上に立つ壁（＋上のふたへのダボ）
//   2 段目〜     ふた（天井の板）と、その上に立つ壁。ふたを下にして刷る（裏にダボ穴）
//   暖簾N        棒と布。布の輪に棒を通し、両どなりの壁の端の溝へ上から落とす
// パーツ: レンガ(1)・ガラス(2)・暖簾(3)・足元の台(4)・床・天井・坂の板(5)・大理石(6)
// 形は Godot の座標（y が上）で作り、最後に印刷の座標（x, -z, y。mm）へ。
// ふたのダボ穴は、穴のある板として作る（ゲームでは穴を通る線で板を割るが、ここでは穴つきの面を三角に割る）。
import * as THREE from 'three';
import { zipSync, strToU8 } from '../vendor/fflate.module.js';

const BASE_MM = 1.2;
const BASE_MARGIN_MM = 2.0;
const BED_MM = 256.0;
const LAYOUT_GAP_MM = 6.0;
const BRICK_COLS = 4;
const BRICK_ROWS = 7;
const GROOVE_W_MM = 0.5;
const GROOVE_D_MM = 0.3;
const NOREN_STRIPS = 3;
const STRIP_MIN_W_MM = 1.6;
const STRIP_T_MM = 1.0;
const STRIP_GAP_MM = 0.3;
const FLOOR_CLEAR_MM = 0.5;
const WALL_T_MM = 2.8;
const LID_T_MM = 2.0;
const PEG_W_MM = 0.9;
const PEG_L_MM = 3.0;
const PEG_H_MM = 1.0;
const PEG_CLEAR_MM = 0.15;
const WALL_SOCKET_CLEAR_MM = 0.22;
const SOCKET_FLARE_MM = 0.15;
const SOCKET_FLARE_D_MM = 0.4;
const SOCKET_D_MM = 1.3;
const NOREN_ROD_MM = 1.7;
const NOREN_HOLE_MM = 2.1;
const NOREN_EYE_WALL_MM = 0.6;
const NOREN_SLOT_CLEAR_MM = 0.15;
const NOREN_SLOT_L_MM = 2.0;
const NOREN_HOLDER_T_MM = 3.4;
const NOREN_ROD_DROP_MM = 2.2;
const NOREN_ROD_END_CLEAR_MM = 0.2;
const LEVEL_TOL = 0.2;
const Y_TOL = 0.08;
const XZ_TOL = 0.06;
const BOX_FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
const TRI_FACES = [[0, 2, 1], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]];
const EXT_BRICK = 1, EXT_GLASS = 2, EXT_NOREN = 3, EXT_BASE = 4, EXT_PLATE = 5, EXT_MARBLE = 6;

const UP = new THREE.Vector3(0, 1, 0);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const V2 = (x, y) => new THREE.Vector2(x, y);
const isEq = (a, b) => Math.abs(a - b) < 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
const posmod = (a, b) => ((a % b) + b) % b;
const fposmod = posmod;
const absSpan = (w) => Math.abs(Number(w.span_x));
const stacksOf = (w) => Math.max(w.stacks | 0, 1);

// rows を 3MF のバイト列にする。
// 返り値: {ok, error, bytes (Uint8Array), objects, skipped_noren, over_bed}
export function export3mf(rows, scale = 100.0, withBase = true, bricks = true, title = '') {
  const mm = 1000.0 / scale;
  const walls = rows.filter((r) => r && r.pos && Number(r.span_x || 0) < 0.0); // 六角の建材だけ
  const solid = [], curtains = [];
  for (const w of walls) (String(w.kind || 'wall') === 'curtain' ? curtains : solid).push(w);
  if (solid.length === 0) return { ok: false, error: 'no_pieces' };
  const cols = withPostBottoms(norenColumns(curtains), solid);

  const lo = V3(Infinity, Infinity, Infinity), hi = V3(-Infinity, -Infinity, -Infinity);
  for (const w of solid) for (const sh of pieceShells(w, mm, false)) for (const p of sh.v) { lo.min(p); hi.max(p); }
  const m = BASE_MARGIN_MM / mm;
  const t = BASE_MM / mm;
  const baseShells = [];
  if (withBase) baseShells.push(box(lo.x - m, hi.x + m, lo.y - m, hi.y + m, lo.z - t + 0.02 / mm, lo.z + 0.02 / mm));
  const zGround = lo.z - (withBase ? t : 0.0);

  const plan = planCourses(solid, mm);
  const { levels, lids, segs, pockets, others } = plan;
  const nplan = planNoren(cols, levels, lids, segs, mm);
  const norens = nplan.norens;
  const holderSh = new Map();
  for (const N of norens) {
    for (const pair of N.holders) {
      const key = hkey(N.level, pair[0].kind);
      if (!holderSh.has(key)) holderSh.set(key, []);
      holderSh.get(key).push(...pair[1]);
    }
  }

  const objects = [];
  let n = 0;
  for (let k = 0; k < levels.length; k++) {
    const L = levels[k];
    const cs = segs.filter((S) => Math.abs(S.bottom - L) < 1e-6);
    const cl = k > 0 ? (lids.get(L) || []) : [];
    const co = others.filter((w) => isEq(levelAtOrBelow(levels, pieceBoundsY(w).x), L));
    if (cs.length === 0 && cl.length === 0 && co.length === 0 && !(k === 0 && withBase)) continue;
    const holes = pockets.get(L) || [];
    const parts = [];
    const z0 = k === 0 ? zGround : L;
    for (const mat of ['brick', 'glass', 'marble']) {
      const wallSh = segShells(cs, mat, mm, bricks);
      wallSh.push(...(holderSh.get(hkey(L, mat)) || []));
      const flatSh = [];
      for (const w of co) if (matOf(w) === mat) flatSh.push(...pieceShells(w, mm, bricks));
      const lidSh = [], lidTop = [];
      for (const w of cl) {
        if (matOf(w) !== mat) continue;
        lidSh.push(...lidShells(w, L, mm, holes));
        if (bricks && String(w.kind || '') === 'wall') lidTop.push(...flatBrickShells(w, mm, L + LID_T_MM / mm));
      }
      lidSh.push(...withoutOverlaps(lidTop, holes));
      if (mat === 'brick') {
        addPart(parts, 'レンガ', EXT_BRICK, wallSh, mm, z0);
        addPart(parts, '床・坂の板', EXT_PLATE, flatSh, mm, z0);
        addPart(parts, 'ふた', EXT_PLATE, lidSh, mm, z0);
      } else if (mat === 'glass') {
        wallSh.push(...flatSh);
        addPart(parts, 'ガラス', EXT_GLASS, wallSh, mm, z0);
        addPart(parts, 'ガラスの天井', EXT_GLASS, lidSh, mm, z0);
      } else {
        wallSh.push(...flatSh, ...lidSh);
        addPart(parts, '大理石', EXT_MARBLE, wallSh, mm, z0);
      }
      if (mat === 'brick' && k === 0 && withBase) addPart(parts, '床（足元の台）', EXT_BASE, baseShells, mm, z0);
    }
    if (parts.length === 0) continue;
    n += 1;
    const what = k === 0 ? '台と壁' : (cl.length && cs.length ? '天井と壁' : (cl.length ? '天井' : '壁'));
    objects.push([`${n}段目（${what}）`, parts]);
  }

  // 布の長さはいちばん短い暖簾にそろえる
  if (norens.length) {
    let short = Infinity;
    for (const N of norens) short = Math.min(short, N.drop);
    for (const N of norens) N.drop = short;
  }
  let i = 0;
  for (const N of norens) {
    i += 1;
    const rs = norenPartsMm(N, mm);
    const parts = [];
    addPart(parts, '暖簾の棒', EXT_NOREN, rs[0], mm, 0.0);
    addPart(parts, '暖簾の布', EXT_NOREN, rs[1], mm, 0.0);
    objects.push([`暖簾${i}（棒と布）`, parts]);
  }
  if (objects.length === 0) return { ok: false, error: 'no_pieces' };
  const laid = layout(objects);
  const bytes = write3mf(laid.objects, title);
  return { ok: true, bytes, objects: objects.length, skipped_noren: nplan.skipped, over_bed: laid.over_bed };
}

const hkey = (level, kind) => `${level.toFixed(5)}|${kind}`;

function matOf(w) {
  const kind = String(w.kind || 'wall');
  if (kind === 'glass') return 'glass';
  if (kind === 'marble') return 'marble';
  return 'brick';
}

// --- 形（shell = {v: 頂点, f: 面の頂点番号の配列}。どれも閉じた形） ---
function box(x0, x1, y0, y1, z0, z1) {
  const v = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push(V3(x, y, z));
  return { v, f: BOX_FACES };
}

function prism(poly, z0, z1) {
  const n = poly.length;
  const v = [];
  for (const p of poly) v.push(V3(p.x, p.y, z0));
  for (const p of poly) v.push(V3(p.x, p.y, z1));
  const bottom = [], top = [];
  for (let j = n - 1; j >= 0; j--) bottom.push(j);
  for (let j = 0; j < n; j++) top.push(n + j);
  const f = [bottom, top];
  for (let j = 0; j < n; j++) f.push([j, (j + 1) % n, n + (j + 1) % n, n + j]);
  return { v, f };
}

function triangleVerts(side, pitch) {
  const height = side * Math.sqrt(3.0) * 0.5;
  const depth = side / 16.0;
  const top = [V3(-side * 0.5, depth, height / 3.0), V3(side * 0.5, depth, height / 3.0), V3(0.0, depth, -height * 2.0 / 3.0)];
  const v = top.map((p) => p.clone());
  for (const p of top) v.push(p.clone().sub(V3(0, depth * 2.0, 0)));
  const tp = Math.tan(pitch);
  for (const p of v) p.y += p.z * tp;
  return { v, f: TRI_FACES };
}

const toWorld = (w, local, center) => local.clone().applyAxisAngle(UP, Number(w.yaw) || 0).add(center);
const flat = (w) => V3(w.pos.x, 0.0, w.pos.z);

function placed(shells, w, center) {
  const yaw = Number(w.yaw) || 0;
  return shells.map((sh) => ({
    v: sh.v.map((p) => { const q = p.clone().applyAxisAngle(UP, yaw).add(center); return V3(q.x, -q.z, q.y); }),
    f: sh.f,
  }));
}

function clipToTri(poly, tri) {
  let area = 0.0;
  for (let j = 0; j < 3; j++) area += tri[j].x * tri[(j + 1) % 3].y - tri[(j + 1) % 3].x * tri[j].y;
  const tr = tri.slice();
  if (area < 0.0) tr.reverse();
  let out = poly.slice();
  for (let j = 0; j < 3; j++) {
    const a = tr[j], b = tr[(j + 1) % 3];
    const src = out;
    out = [];
    for (let q = 0; q < src.length; q++) {
      const p = src[q], r = src[(q + 1) % src.length];
      const dp = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const dq = (b.x - a.x) * (r.y - a.y) - (b.y - a.y) * (r.x - a.x);
      if (dp >= 0.0) out.push(p);
      if ((dp >= 0.0) !== (dq >= 0.0)) {
        const tt = dp / (dp - dq);
        out.push(p.clone().add(r.clone().sub(p).multiplyScalar(tt)));
      }
    }
    if (out.length === 0) return [];
  }
  return out;
}

// 水平の板の上の面に浮かせたレンガ（並びはワールドの xz で共通）
function flatBrickShells(w, mm, topY = NaN) {
  const s = absSpan(w);
  const pos = w.pos;
  const pitch = Number(w.pitch) || 0;
  const depth = s / 16.0;
  const gw = GROOVE_W_MM / mm, gd = GROOVE_D_MM / mm, eps = 0.05 / mm;
  const tri = triXZ(w);
  const bw = s / BRICK_COLS, rh = s / BRICK_ROWS;
  const yaw = Number(w.yaw) || 0;
  const zmin = Math.min(tri[0].y, tri[1].y, tri[2].y), zmax = Math.max(tri[0].y, tri[1].y, tri[2].y);
  const xmin = Math.min(tri[0].x, tri[1].x, tri[2].x), xmax = Math.max(tri[0].x, tri[1].x, tri[2].x);
  const ty = Number.isNaN(topY) ? depth : topY - pos.y;
  const tp = Math.tan(pitch);
  const shells = [];
  for (let r = Math.floor(zmin / rh) - 1; r < Math.ceil(zmax / rh) + 1; r++) {
    const z0 = r * rh + gw / 2, z1 = (r + 1) * rh - gw / 2;
    const off = posmod(r, 2) === 1 ? bw / 2 : 0.0;
    for (let c = Math.floor((xmin - off) / bw) - 1; c < Math.ceil((xmax - off) / bw) + 1; c++) {
      const x0 = c * bw + off + gw / 2, x1 = (c + 1) * bw + off - gw / 2;
      const poly = clipToTri([V2(x0, z0), V2(x1, z0), V2(x1, z1), V2(x0, z1)], tri);
      if (poly.length < 3) continue;
      let a = 0.0;
      for (let j = 0; j < poly.length; j++) a += poly[j].x * poly[(j + 1) % poly.length].y - poly[(j + 1) % poly.length].x * poly[j].y;
      if (Math.abs(a) * 0.5 < gw * gw) continue;
      const nn = poly.length;
      const verts = [];
      for (const y of [ty - eps, ty + gd]) {
        for (const q of poly) {
          const l = V3(q.x, pos.y, q.y).sub(pos).applyAxisAngle(UP, -yaw);
          verts.push(V3(l.x, y + l.z * tp, l.z));
        }
      }
      const bottom = [], top = [];
      for (let j = 0; j < nn; j++) { bottom.push(j); top.push(nn + j); }
      const faces = [bottom, top];
      for (let j = 0; j < nn; j++) faces.push([j, (j + 1) % nn, nn + (j + 1) % nn, nn + j]);
      shells.push({ v: verts, f: faces });
    }
  }
  return placed(shells, w, pos);
}

function pieceShells(w, mm, bricks) {
  const s = absSpan(w);
  const pos = w.pos;
  if (w.horizontal) {
    const out = placed([triangleVerts(s, Number(w.pitch) || 0)], w, pos);
    if (bricks && String(w.kind || '') === 'wall') out.push(...flatBrickShells(w, mm));
    return out;
  }
  const h = s * stacksOf(w);
  const d = s / 8.0;
  return placed([box(-s / 2, s / 2, -h / 2, h / 2, -d / 2, d / 2)], w, pos.clone().add(V3(0, h * 0.5, 0)));
}

function triXZ(w) {
  const s = absSpan(w);
  const pts = triangleVerts(s, 0.0).v;
  const out = [];
  for (let j = 0; j < 3; j++) { const q = toWorld(w, pts[j], w.pos); out.push(V2(q.x, q.z)); }
  return out;
}

function inTri(pt, tri, tol) {
  let sign = 0.0;
  for (let j = 0; j < 3; j++) {
    const a = tri[j], b = tri[(j + 1) % 3];
    const e = b.clone().sub(a);
    let ln = e.length();
    if (ln <= 0.0) ln = 1.0;
    const cross = (e.x * (pt.y - a.y) - e.y * (pt.x - a.x)) / ln;
    if (sign === 0.0) {
      const c = tri[(j + 2) % 3];
      sign = (e.x * (c.y - a.y) - e.y * (c.x - a.x)) > 0.0 ? 1.0 : -1.0;
    }
    if (cross * sign < -tol) return false;
  }
  return true;
}

function pieceBoundsY(w) {
  const s = absSpan(w);
  const y = w.pos.y;
  if (w.horizontal) {
    let lo = Infinity, hi = -Infinity;
    for (const p of triangleVerts(s, Number(w.pitch) || 0).v) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    return V2(y + lo, y + hi);
  }
  return V2(y, y + s * stacksOf(w));
}

// --- 暖簾の場所 ---
function norenColumns(curtains) {
  const groups = new Map();
  for (const w of curtains) {
    const p = w.pos;
    const key = `${p.x.toFixed(2)}|${p.z.toFixed(2)}|${(Number(w.yaw) || 0).toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const cols = [];
  for (const ws of groups.values()) {
    ws.sort((a, b) => a.pos.y - b.pos.y);
    let cur = null;
    for (const w of ws) {
      const s = absSpan(w);
      const hy = s * stacksOf(w);
      const y = w.pos.y;
      if (cur && Math.abs(cur[1] + cur[2] - y) < 0.05) cur[2] = y + hy - cur[1];
      else { cur = [w, y, hy]; cols.push(cur); }
    }
  }
  return cols;
}

function supportBelow(solid, p2, y) {
  let best = Infinity;
  for (const w of solid) best = Math.min(best, pieceBoundsY(w).x);
  for (const w of solid) {
    const bt = pieceBoundsY(w);
    const p = w.pos;
    if (w.horizontal) {
      if (bt.x <= y + Y_TOL && Math.abs(Number(w.pitch) || 0) < 0.05 && inTri(p2, triXZ(w), XZ_TOL)) best = Math.max(best, Math.min(bt.y, y));
    } else if (bt.y <= y + Y_TOL && V2(p.x - p2.x, p.z - p2.y).length() < XZ_TOL) {
      best = Math.max(best, Math.min(bt.y, y));
    }
  }
  return best;
}

function withPostBottoms(cols, solid) {
  return cols.map((c) => {
    const p = c[0].pos;
    const sup = supportBelow(solid, V2(p.x, p.z), c[1]);
    return [c[0], c[1], c[2], Math.min(c[1], sup)];
  });
}

// --- 段（courses） ---
function snapLevels(values) {
  const vals = values.slice().sort((a, b) => a - b);
  const levels = [];
  for (const v of vals) {
    if (levels.length && v - levels[levels.length - 1] < LEVEL_TOL) continue;
    levels.push(v);
  }
  return levels;
}

function snapTo(levels, y) {
  let best = levels[0];
  for (const L of levels) if (Math.abs(L - y) < Math.abs(best - y)) best = L;
  return best;
}

function levelAtOrBelow(levels, y) {
  let out = levels[0];
  for (const L of levels) if (L <= y + LEVEL_TOL) out = L;
  return out;
}

function vprism8(cx, cz, r, y0, y1) {
  const v = [];
  for (const y of [y0, y1]) for (let j = 0; j < 8; j++) {
    const a = Math.PI / 8 + j * Math.PI / 4;
    v.push(V3(cx + r * Math.cos(a), y, cz + r * Math.sin(a)));
  }
  const n = 8;
  const bottom = [], top = [];
  for (let j = 0; j < n; j++) { bottom.push(j); top.push(2 * n - 1 - j); }
  const f = [bottom, top];
  for (let j = 0; j < n; j++) f.push([j, n + j, n + (j + 1) % n, (j + 1) % n]);
  return { v, f };
}

function ringLayer(x0, x1, ya, yb, z0, z1, ha, hb, hc, hd) {
  const out = [];
  for (const [bx0, bx1] of [[x0, Math.min(ha, x1)], [Math.max(hb, x0), x1]]) {
    if (bx1 - bx0 > 1e-9) out.push(box(bx0, bx1, ya, yb, z0, z1));
  }
  const a = Math.max(ha, x0), b = Math.min(hb, x1);
  if (b - a > 1e-9) {
    for (const [bz0, bz1] of [[z0, Math.min(hc, z1)], [Math.max(hd, z0), z1]]) {
      if (bz1 - bz0 > 1e-9) out.push(box(a, b, ya, yb, bz0, bz1));
    }
  }
  return out;
}

function socketedBox(x0, x1, y0, y1, z0, z1, sl, sw, sd, flare, flareD) {
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const a = cx - sl / 2, b = cx + sl / 2, c = cz - sw / 2, d = cz + sw / 2;
  const fd = flare > 0.0 ? Math.min(flareD, sd) : 0.0;
  const out = [];
  if (fd > 0.0) out.push(...ringLayer(x0, x1, y0, y0 + fd, z0, z1, a - flare, b + flare, c - flare, d + flare));
  out.push(...ringLayer(x0, x1, y0 + fd, y0 + sd, z0, z1, a, b, c, d));
  out.push(box(x0, x1, y0 + sd, y1, z0, z1));
  return out;
}

function makeSegments(solid, levels, mm) {
  const segs = [];
  for (const w of solid) {
    if (w.horizontal) continue;
    const s = absSpan(w);
    const bt = pieceBoundsY(w);
    const b = snapTo(levels, bt.x), tp = snapTo(levels, bt.y);
    const ys = levels.filter((L) => b - 1e-6 <= L && L <= tp + 1e-6);
    for (let j = 0; j < ys.length - 1; j++) {
      segs.push({
        id: segs.length, kind: matOf(w), pattern: String(w.kind || '') === 'wall',
        w, s, x0: -s / 2, x1: s / 2, bottom: ys[j], top: ys[j + 1],
        t: WALL_T_MM / mm, pl: PEG_L_MM, pw: PEG_W_MM, peg: false, socket: false,
      });
    }
  }
  return segs;
}

function segXZ(S) {
  const p = toWorld(S.w, V3((S.x0 + S.x1) * 0.5, 0, 0), flat(S.w));
  return V2(p.x, p.z);
}

function segmentShells(S, mm, bricks) {
  const gw = GROOVE_W_MM / mm, gd = GROOVE_D_MM / mm, eps = 0.05 / mm;
  const { x0, x1, t } = S;
  const y0 = S.bottom, y1 = S.top;
  const brick = S.pattern && bricks;
  const tc = brick ? t - 2 * gd : t;
  const out = [];
  if (S.socket) {
    const sl = (S.pl + 2 * WALL_SOCKET_CLEAR_MM) / mm, sw = (S.pw + 2 * WALL_SOCKET_CLEAR_MM) / mm;
    out.push(...socketedBox(x0, x1, y0, y1, -tc / 2, tc / 2, sl, sw, SOCKET_D_MM / mm, SOCKET_FLARE_MM / mm, SOCKET_FLARE_D_MM / mm));
  } else {
    out.push(box(x0, x1, y0, y1, -tc / 2, tc / 2));
  }
  if (brick) {
    const s = S.s;
    const rows = Math.max(1, Math.round(BRICK_ROWS * (y1 - y0) / s));
    const rh = (y1 - y0) / rows;
    const bw = s / BRICK_COLS;
    for (let r = 0; r < rows; r++) {
      const by0 = y0 + r * rh + gw / 2, by1 = y0 + (r + 1) * rh - gw / 2;
      const off = r % 2 === 1 ? bw / 2 : 0.0;
      for (let c = -1; c < BRICK_COLS + 1; c++) {
        const bx0 = Math.max(x0 + gw / 2, x0 + c * bw + off + gw / 2);
        const bx1 = Math.min(x1 - gw / 2, x0 + (c + 1) * bw + off - gw / 2);
        if (bx1 - bx0 < gw) continue;
        out.push(box(bx0, bx1, by0, by1, tc / 2 - eps, t / 2));
        out.push(box(bx0, bx1, by0, by1, -t / 2, -tc / 2 + eps));
      }
    }
  }
  for (const x of [x0, x1]) out.push(vprism8(x, 0.0, t / 2, y0, y1));
  if (S.peg) {
    const cx = (x0 + x1) * 0.5, pl = S.pl / mm / 2, pw = S.pw / mm / 2;
    out.push(box(cx - pl, cx + pl, y1 - 0.1 / mm, y1 + PEG_H_MM / mm, -pw, pw));
  }
  return placed(out, S.w, flat(S.w));
}

function segShells(cs, kind, mm, bricks) {
  const out = [];
  for (const S of cs) if (S.kind === kind) out.push(...segmentShells(S, mm, bricks));
  return out;
}

function socketCutter(S, mm) {
  const cx = (S.x0 + S.x1) * 0.5, y1 = S.top;
  const sl = (S.pl / 2 + PEG_CLEAR_MM) / mm, sw = (S.pw / 2 + PEG_CLEAR_MM) / mm;
  return placed([box(cx - sl, cx + sl, y1 - 0.3 / mm, y1 + SOCKET_D_MM / mm, -sw, sw)], S.w, flat(S.w))[0];
}

function planCourses(solid, mm) {
  let ground = Infinity;
  for (const w of solid) ground = Math.min(ground, pieceBoundsY(w).x);
  const flats = [], lidWs = [];
  for (const w of solid) {
    if (w.horizontal) {
      flats.push(w);
      if (Math.abs(Number(w.pitch) || 0) < 0.05 && pieceBoundsY(w).x > ground + LEVEL_TOL) lidWs.push(w);
    }
  }
  const vals = [ground];
  for (const w of solid) if (!w.horizontal) { const bt = pieceBoundsY(w); vals.push(bt.x, bt.y); }
  for (const w of lidWs) vals.push(pieceBoundsY(w).x);
  const levels = snapLevels(vals);
  const lids = new Map();
  for (const w of lidWs) {
    const L = snapTo(levels, pieceBoundsY(w).x);
    if (!lids.has(L)) lids.set(L, []);
    lids.get(L).push(w);
  }
  const segs = makeSegments(solid, levels, mm);
  const pockets = new Map();
  for (const S of segs) {
    const p = segXZ(S);
    const above = segs.filter((A) => A.id !== S.id && Math.abs(A.bottom - S.top) < 1e-6 && segXZ(A).distanceTo(p) < XZ_TOL);
    if (above.length) {
      S.peg = true;
      for (const A of above) A.socket = true;
      continue;
    }
    for (const lw of lids.get(S.top) || []) {
      if (inTri(p, triXZ(lw), XZ_TOL)) {
        S.peg = true;
        if (!pockets.has(S.top)) pockets.set(S.top, []);
        pockets.get(S.top).push(socketCutter(S, mm));
        break;
      }
    }
  }
  const others = flats.filter((w) => !lidWs.includes(w));
  return { levels, lids, segs, pockets, others };
}

// --- ふた（穴のある三角の板） ---
function lidShells(w, level, mm, holes) {
  const s = absSpan(w);
  const pts = triangleVerts(s, 0.0).v;
  const tri = [];
  for (let j = 0; j < 3; j++) { const q = toWorld(w, pts[j], flat(w)); tri.push([q.x, -q.z]); }
  const t = LID_T_MM / mm;
  const mid = level + Math.min(SOCKET_D_MM / mm, t);
  const out = [];
  let shapes = [[tri]];
  if (holes.length) {
    // 箱の下の面（印刷の z の下）の 4 点: 0, 1, 5, 4
    const holePolys = holes.map((hb) => [[[hb.v[0].x, hb.v[0].y], [hb.v[1].x, hb.v[1].y], [hb.v[5].x, hb.v[5].y], [hb.v[4].x, hb.v[4].y]]]);
    shapes = window.polygonClipping.difference([tri], ...holePolys);
  }
  for (const shape of shapes) {
    const sh = extrudeRings(shape, level, mid);
    if (sh) out.push(sh);
  }
  out.push(extrudeRings([tri], mid, level + t));
  return out;
}

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
};

// 印刷の xy の多角形（rings[0] が外、残りが穴。閉じた点の重複はあってもよい）を z0..z1 に押し出す
function extrudeRings(ringsIn, z0, z1) {
  const rings = ringsIn.map((r) => {
    const pts = r.slice();
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts;
  });
  if (rings[0].length < 3) return null;
  if (ringArea(rings[0]) < 0) rings[0].reverse();
  for (let i = 1; i < rings.length; i++) if (ringArea(rings[i]) > 0) rings[i].reverse();
  const flatPts = [];
  for (const r of rings) for (const p of r) flatPts.push(p);
  const n = flatPts.length;
  const contour = rings[0].map((p) => V2(p[0], p[1]));
  const holeVs = rings.slice(1).map((r) => r.map((p) => V2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holeVs);
  if (!tris.length) return null;
  const v = [];
  for (const p of flatPts) v.push(V3(p[0], p[1], z0));
  for (const p of flatPts) v.push(V3(p[0], p[1], z1));
  const f = [];
  for (const tri of tris) {
    let [a, b, c] = tri;
    const pa = flatPts[a], pb = flatPts[b], pc = flatPts[c];
    if ((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]) < 0) [b, c] = [c, b];
    f.push([a, c, b]);
    f.push([n + a, n + b, n + c]);
  }
  let base = 0;
  for (const r of rings) {
    const m = r.length;
    for (let j = 0; j < m; j++) {
      const a = base + j, b = base + (j + 1) % m;
      f.push([a, b, n + b, n + a]);
    }
    base += m;
  }
  return { v, f };
}

function bbox(sh) {
  const b = new THREE.Box3();
  for (const p of sh.v) b.expandByPoint(p);
  return b;
}

function withoutOverlaps(shells, cutters) {
  if (!cutters.length) return shells;
  const boxes = cutters.map(bbox);
  return shells.filter((sh) => {
    const a = bbox(sh);
    // Godot の AABB.intersects は面が触れるだけでは重ならない
    return !boxes.some((b) => a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y
      && a.min.z < b.max.z && a.max.z > b.min.z);
  });
}

// --- 暖簾 ---
function closestOnSeg(p, a, b) {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  if (l2 <= 0) return a.clone();
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / l2));
  return a.clone().add(ab.multiplyScalar(t));
}
const ptSeg = (p, a, b) => p.distanceTo(closestOnSeg(p, a, b));
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function segSeg(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0.0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

function segPoly(a, b, poly) {
  const n = poly.length;
  let allPos = true, allNeg = true;
  for (let j = 0; j < n; j++) {
    const cr = cross(poly[j], poly[(j + 1) % n], a);
    if (cr < 0) allPos = false;
    if (cr > 0) allNeg = false;
  }
  if (allPos || allNeg) return 0.0;
  let best = Infinity;
  for (let j = 0; j < n; j++) best = Math.min(best, segSeg(a, b, poly[j], poly[(j + 1) % n]));
  return best;
}

function wallCapsules(segs, y0, y1, clr) {
  const out = [];
  for (const S of segs) {
    if (S.bottom >= y1 - 1e-6 || S.top <= y0 + 1e-6) continue;
    const a = toWorld(S.w, V3(S.x0, 0, 0), flat(S.w)), b = toWorld(S.w, V3(S.x1, 0, 0), flat(S.w));
    out.push([V2(a.x, a.z), V2(b.x, b.z), S.t / 2 + clr]);
  }
  return out;
}

function freeInset(w, side, length, depth, walls, mm) {
  const s = absSpan(w);
  const center = flat(w);
  let d = 0.0;
  while (d < s / 2 - length) {
    const xa = Math.min(side * (s / 2 - d), side * (s / 2 - d - length));
    const xb = Math.max(side * (s / 2 - d), side * (s / 2 - d - length));
    const poly = [[xa, -depth / 2], [xb, -depth / 2], [xb, depth / 2], [xa, depth / 2]].map(([x, z]) => {
      const q = toWorld(w, V3(x, 0, z), center);
      return V2(q.x, q.z);
    });
    if (!walls.some((cap) => segPoly(cap[0], cap[1], poly) < cap[2])) return d;
    d += 0.05 / mm;
  }
  return -1.0;
}

function cornerWall(w, side, segs, y0, y1) {
  const s = absSpan(w);
  const c = toWorld(w, V3(side * s / 2, 0, 0), flat(w));
  for (const S of segs) {
    if (S.bottom > y0 + 1e-6 || S.top < y1 - 1e-6) continue;
    for (const x of [S.x0, S.x1]) {
      const p = toWorld(S.w, V3(x, 0, 0), flat(S.w));
      if (V2(p.x - c.x, p.z - c.z).length() < XZ_TOL) return S;
    }
  }
  return null;
}

function mergeNorenRuns(cols) {
  const runs = cols.map((c) => {
    const w = c[0], s = absSpan(w);
    return [c, [toWorld(w, V3(-s / 2, 0, 0), flat(w)), toWorld(w, V3(s / 2, 0, 0), flat(w))], 1];
  });
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i][0], b = runs[j][0], ea = runs[i][1], eb = runs[j][1];
        const dyaw = fposmod((Number(a[0].yaw) || 0) - (Number(b[0].yaw) || 0), Math.PI);
        if (Math.min(dyaw, Math.PI - dyaw) > 0.05 || Math.abs(a[1] - b[1]) > Y_TOL || Math.abs(a[2] - b[2]) > Y_TOL) continue;
        let shared = null;
        for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) {
          if (!shared && ea[p].distanceTo(eb[q]) < XZ_TOL) shared = [p, q];
        }
        if (!shared) continue;
        runs[i] = [[a[0], a[1], a[2], Math.min(a[3], b[3])], [ea[1 - shared[0]], eb[1 - shared[1]]], runs[i][2] + runs[j][2]];
        runs.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return runs.map((run) => {
    const c = run[0];
    const w = { ...c[0] };
    if (run[2] > 1) {
      const e0 = run[1][0], e1 = run[1][1];
      const mid = e0.clone().add(e1).multiplyScalar(0.5);
      w.pos = V3(mid.x, w.pos.y, mid.z);
      w.span_x = -e0.distanceTo(e1);
    }
    w.units = run[2];
    return [w, c[1], c[2], c[3]];
  });
}

function planNoren(colsIn, levels, lids, segs, mm) {
  const out = [];
  let skipped = 0;
  const cols = mergeNorenRuns(colsIn);
  const slotW = (NOREN_ROD_MM + 2 * NOREN_SLOT_CLEAR_MM) / mm;
  const slotL = NOREN_SLOT_L_MM / mm;
  const ht = NOREN_HOLDER_T_MM / mm;
  for (const col of cols) {
    const [w, y, h, pb] = col;
    const s = absSpan(w);
    const center = flat(w);
    const T = snapTo(levels, y + h);
    let B = NaN;
    for (const L of levels) if (L < T - 1e-6) B = L;
    if (Number.isNaN(B)) continue;
    const walls = wallCapsules(segs, B, T, NOREN_SLOT_CLEAR_MM / mm);
    const sides = new Map();
    for (const side of [-1.0, 1.0]) {
      const S = cornerWall(w, side, segs, B, T);
      const d = freeInset(w, side, slotL, slotW + 2 * NOREN_SLOT_CLEAR_MM / mm, walls, mm);
      if (!S || d < 0.0) break;
      sides.set(side, [S, d]);
    }
    if (sides.size < 2) { skipped += 1; continue; }
    const rodC = T - NOREN_ROD_DROP_MM / mm;
    const slotB = rodC - NOREN_ROD_MM / 2 / mm - 0.05 / mm;
    const holders = new Map();
    const xs = new Map();
    for (const [side, [S, d]] of sides) {
      const c1 = s / 2 - d, c2 = s / 2 - d - slotL;
      const sh = [box(Math.min(side * s / 2, side * c1), Math.max(side * s / 2, side * c1), B, T, -ht / 2, ht / 2)];
      const lo = Math.min(side * c1, side * c2), hi = Math.max(side * c1, side * c2);
      sh.push(box(lo, hi, B, slotB, -ht / 2, ht / 2));
      sh.push(box(lo, hi, slotB, T, -ht / 2, -slotW / 2));
      sh.push(box(lo, hi, slotB, T, slotW / 2, ht / 2));
      if (!holders.has(S.id)) holders.set(S.id, [S, []]);
      holders.get(S.id)[1].push(...placed(sh, w, center));
      xs.set(side, V2(side * c1, side * c2));
    }
    const Lb = snapTo(levels, pb);
    let onLid = false;
    if (Math.abs(Lb - pb) < LEVEL_TOL && lids.has(Lb)) {
      for (const lw of lids.get(Lb)) if (inTri(V2(center.x, center.z), triXZ(lw), XZ_TOL)) onLid = true;
    }
    const floorY = onLid ? Lb + LID_T_MM / mm : pb;
    const rodLen = Math.abs(xs.get(1.0).x - xs.get(-1.0).x) * mm - 2 * NOREN_ROD_END_CLEAR_MM;
    const inner = Math.abs(xs.get(1.0).y - xs.get(-1.0).y) * mm;
    out.push({ w, holders: [...holders.values()], level: B, rod_len: rodLen, inner, drop: (rodC - floorY) * mm, units: w.units || 1 });
  }
  return { norens: out, skipped };
}

function norenPartsMm(N, mm) {
  const hh = NOREN_HOLE_MM / 2;
  const eye = NOREN_HOLE_MM + 2 * NOREN_EYE_WALL_MM;
  const inner = N.inner;
  let n = NOREN_STRIPS * N.units;
  n = Math.max(1, Math.min(n, Math.trunc((inner - STRIP_GAP_MM) / (STRIP_MIN_W_MM + STRIP_GAP_MM))));
  const sw = (inner - (n + 1) * STRIP_GAP_MM) / n;
  const lp = N.drop - (NOREN_HOLE_MM - NOREN_ROD_MM) / 2 - FLOOR_CLEAR_MM;
  const r = NOREN_ROD_MM / 2 / Math.cos(Math.PI / 8);
  const pts = [];
  for (let j = 0; j < 8; j++) {
    const a = Math.PI / 8 + j * Math.PI / 4;
    pts.push(V2(r * Math.cos(a), r * Math.sin(a) + NOREN_ROD_MM / 2));
  }
  const pr = prism(pts, 0.0, N.rod_len);
  const rod = [{ v: pr.v.map((p) => V3(p.z, p.x - 3.0 - NOREN_ROD_MM, p.y)), f: pr.f }];
  const strips = [];
  for (let j = 0; j < n; j++) {
    const x0 = j * (sw + 3.0), x1 = x0 + sw;
    strips.push(box(x0, x1, 0.0, lp - eye / 2 + 0.2, 0.0, STRIP_T_MM));
    strips.push(box(x0, x1, lp - eye / 2, lp + eye / 2, 0.0, eye / 2 - hh));
    strips.push(box(x0, x1, lp - eye / 2, lp + eye / 2, eye / 2 + hh, eye));
    strips.push(box(x0, x1, lp - eye / 2, lp - hh, eye / 2 - hh, eye / 2 + hh));
    strips.push(box(x0, x1, lp + hh, lp + eye / 2, eye / 2 - hh, eye / 2 + hh));
  }
  return [toUnits(rod, mm), toUnits(strips, mm)];
}

const toUnits = (shells, mm) => shells.map((sh) => ({ v: sh.v.map((p) => p.clone().divideScalar(mm)), f: sh.f }));

// --- 3MF ---
function addPart(parts, pname, ext, shells, mm, z0) {
  if (!shells.length) return;
  const verts = [];
  const tris = [];
  for (const sh of shells) {
    const v = sh.v;
    const base = verts.length / 3;
    const local = [];
    for (const f of sh.f) for (let j = 1; j < f.length - 1; j++) local.push(f[0], f[j], f[j + 1]);
    let vol = 0.0;
    const tmp = new THREE.Vector3();
    for (let j = 0; j < local.length; j += 3) vol += v[local[j]].dot(tmp.crossVectors(v[local[j + 1]], v[local[j + 2]]));
    const flip = vol < 0.0;
    for (const p of v) verts.push(p.x * mm, p.y * mm, (p.z - z0) * mm);
    for (let j = 0; j < local.length; j += 3) {
      if (flip) tris.push(base + local[j], base + local[j + 2], base + local[j + 1]);
      else tris.push(base + local[j], base + local[j + 1], base + local[j + 2]);
    }
  }
  parts.push([pname, ext, verts, tris]);
}

function layout(objects) {
  const out = [];
  let x = LAYOUT_GAP_MM, y = LAYOUT_GAP_MM, rowH = 0.0;
  for (const o of objects) {
    let lx = Infinity, ly = Infinity, hx = -Infinity, hy = -Infinity;
    for (const part of o[1]) {
      const pv = part[2];
      for (let j = 0; j < pv.length; j += 3) {
        lx = Math.min(lx, pv[j]); ly = Math.min(ly, pv[j + 1]);
        hx = Math.max(hx, pv[j]); hy = Math.max(hy, pv[j + 1]);
      }
    }
    const sx = hx - lx, sy = hy - ly;
    if (x + sx > BED_MM - LAYOUT_GAP_MM && x > LAYOUT_GAP_MM) {
      x = LAYOUT_GAP_MM;
      y += rowH + LAYOUT_GAP_MM;
      rowH = 0.0;
    }
    const dx = x - lx, dy = y - ly;
    const parts = o[1].map((part) => {
      const pv = part[2].slice();
      for (let j = 0; j < pv.length; j += 3) { pv[j] += dx; pv[j + 1] += dy; }
      return [part[0], part[1], pv, part[3]];
    });
    out.push([o[0], parts]);
    x += sx + LAYOUT_GAP_MM;
    rowH = Math.max(rowH, sy);
  }
  return { objects: out, over_bed: y + rowH > BED_MM };
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const q = (s) => `"${xmlEsc(s)}"`;

// Bambu Studio はパーツごとのフィラメントを Metadata/model_settings.config から読む
function write3mf(objects, title) {
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<metadata name="Application">SiroWoNuru</metadata>',
    `<metadata name="Title">${xmlEsc(title)}</metadata>`,
    '<resources>',
  ];
  const ident = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';
  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>'];
  const items = [];
  let nextId = 1;
  for (const o of objects) {
    const ids = [];
    for (const part of o[1]) {
      model.push(`<object id="${nextId}" name=${q(part[0])} type="model"><mesh><vertices>`);
      const pv = part[2];
      for (let j = 0; j < pv.length; j += 3) model.push(`<vertex x="${pv[j].toFixed(4)}" y="${pv[j + 1].toFixed(4)}" z="${pv[j + 2].toFixed(4)}"/>`);
      model.push('</vertices><triangles>');
      const t = part[3];
      for (let j = 0; j < t.length; j += 3) model.push(`<triangle v1="${t[j]}" v2="${t[j + 1]}" v3="${t[j + 2]}"/>`);
      model.push('</triangles></mesh></object>');
      ids.push(nextId);
      nextId += 1;
    }
    const parent = nextId;
    nextId += 1;
    model.push(`<object id="${parent}" name=${q(o[0])} type="model"><components>`);
    for (const id of ids) model.push(`<component objectid="${id}"/>`);
    model.push('</components></object>');
    items.push(`<item objectid="${parent}"/>`);
    cfg.push(`  <object id="${parent}">`);
    cfg.push(`    <metadata key="name" value=${q(o[0])}/>`);
    cfg.push(`    <metadata key="extruder" value="${o[1][0][1] | 0}"/>`);
    for (let j = 0; j < ids.length; j++) {
      const part = o[1][j];
      cfg.push(`    <part id="${ids[j]}" subtype="normal_part">`);
      cfg.push(`      <metadata key="name" value=${q(part[0])}/>`);
      cfg.push(`      <metadata key="matrix" value="${ident}"/>`);
      cfg.push(`      <metadata key="extruder" value="${part[1] | 0}"/>`);
      cfg.push('    </part>');
    }
    cfg.push('  </object>');
  }
  model.push('</resources>', '<build>', ...items, '</build>', '</model>', '');
  cfg.push('</config>', '');
  const ctypes = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    + '<Default Extension="config" ContentType="text/xml"/>'
    + '</Types>\n';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    + '</Relationships>\n';
  return zipSync({
    '[Content_Types].xml': strToU8(ctypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model.join('\n')),
    'Metadata/model_settings.config': strToU8(cfg.join('\n')),
  }, { level: 6 });
}
