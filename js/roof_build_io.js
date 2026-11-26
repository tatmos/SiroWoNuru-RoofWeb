// 屋上の建材と JSON の変換（ゲームの scripts/game/roof_build_io.gd と同じ形式）。
// {"format": "siro_roof_build", "version": 1, "title": …, "exported_at": …, "pieces": [
//   {"kind": "wall", "pos": [x, y, z], "yaw": …, "horizontal": …, "pitch": …, "span_x": …, "stacks": …,
//    "paint_color": [r, g, b, a]}, …]}
import * as THREE from 'three';

export const FORMAT = 'siro_roof_build';
export const VERSION = 1;
export const KINDS = ['wall', 'glass', 'curtain', 'marble'];
export const MAX_PIECES = 4000;

const snap = (v, step) => Math.round(v / step) * step;
const num = (v) => Number(snap(v, 0.0001).toFixed(4));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// rows: [{kind, pos: Vector3, yaw, horizontal, pitch, span_x, stacks, paint_color: [r,g,b,a] | null}]
export function toJson(rows, title = '') {
  const pieces = [];
  for (const r of rows) {
    if (!r || !r.pos) continue;
    const p = r.pos;
    const e = {
      kind: String(r.kind || 'wall'),
      pos: [num(p.x), num(p.y), num(p.z)],
      yaw: Number(snap(Number(r.yaw) || 0, 0.00001).toFixed(5)),
      horizontal: !!r.horizontal,
      pitch: Number(snap(Number(r.pitch) || 0, 0.00001).toFixed(5)),
      span_x: num(Number(r.span_x) || 0),
      stacks: Math.max(r.stacks | 0, 1),
    };
    if (Array.isArray(r.paint_color)) e.paint_color = r.paint_color.map(num);
    pieces.push(e);
  }
  return JSON.stringify({
    format: FORMAT, version: VERSION, title,
    exported_at: stamp(),
    pieces,
  }, null, '\t');
}

// 返り値: {ok, rows, title, error}
export function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'format' }; }
  if (!data || typeof data !== 'object' || String(data.format || '') !== FORMAT) return { ok: false, error: 'format' };
  if ((data.version | 0) > VERSION) return { ok: false, error: 'version' };
  if (!Array.isArray(data.pieces)) return { ok: false, error: 'format' };
  const rows = [];
  for (const e of data.pieces) {
    if (rows.length >= MAX_PIECES) break;
    if (!e || typeof e !== 'object') continue;
    const kind = String(e.kind ?? 'wall');
    const pa = e.pos;
    if (!KINDS.includes(kind) || !Array.isArray(pa) || pa.length !== 3) continue;
    const pos = new THREE.Vector3(Number(pa[0]), Number(pa[1]), Number(pa[2]));
    const span = Number(e.span_x ?? 0);
    if (![pos.x, pos.y, pos.z, span].every(Number.isFinite) || Math.abs(span) > 20 || pos.length() > 10000) continue;
    const row = {
      kind, pos,
      yaw: Number(e.yaw ?? 0) || 0,
      horizontal: !!e.horizontal,
      pitch: Math.min(Math.PI / 2, Math.max(-Math.PI / 2, Number(e.pitch ?? 0) || 0)),
      span_x: span,
      stacks: Math.min(64, Math.max(1, Number(e.stacks ?? 1) | 0)),
      paint_color: null,
    };
    const ca = e.paint_color;
    if (Array.isArray(ca) && ca.length >= 3) {
      row.paint_color = [Number(ca[0]), Number(ca[1]), Number(ca[2]), ca.length > 3 ? Number(ca[3]) : 1.0];
    }
    rows.push(row);
  }
  return { ok: true, rows, title: String(data.title ?? '') };
}
