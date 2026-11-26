// 拠点の建物の屋上（ゲームの scripts/ui/lobby_console_terminal.gd の dome_shell_world_y_at と寸法）。
// ゲームでは建物（LobbyConsole）が y = 1.26 に立つ。JSON の座標はワールドのままなので、ここも同じ高さにする。
import * as THREE from 'three';

export const BASE_Y = 1.26;
const PAD_INNER_FLOOR_TOP = 0.52;
const STORY_H = 6.5;
const ROOF_CLEAR = 5.0;
const FLOOR2_TOP = PAD_INNER_FLOOR_TOP + STORY_H;
const ROOF_TOP = FLOOR2_TOP + ROOF_CLEAR;
export const HALL_HALF_X = 20.0;
export const HALL_HALF_Z = 14.5;
const MEZZ_Z0 = -7.5;
const MEZZ_Z1 = 9.5;
export const PARAPET_H = 1.02;
export const PARAPET_T = 0.28;

// [名前, x0, x1, z0, z1, 屋根の上の y（建物の中の高さ）]。上から順に見る（ゲームと同じ順）
const ROOF_T = 0.28;
const ROOMS = [
  ['closet', 20.0, 24.6 + 0.85, 5.6 - 2.0, 5.6 + 2.0, FLOOR2_TOP + 4.2 + 0.18],
  ['music', 20.0, 34.6, -8.4, 3.6, FLOOR2_TOP + 4.2 + ROOF_T],
  ['tart', 20.0, 30.0, 3.6, 12.4, PAD_INNER_FLOOR_TOP + 3.4 + ROOF_T],
  ['paint', -5.6, 8.4, -30.5, -14.5, PAD_INNER_FLOOR_TOP + 4.8 + ROOF_T],
  ['puzzle', 8.4, 19.6, -26.5, -14.5, PAD_INNER_FLOOR_TOP + 3.6 + ROOF_T],
  ['strategy', -17.6, -5.6, -26.5, -14.5, PAD_INNER_FLOOR_TOP + 3.6 + ROOF_T],
];
export const ROOF_Y = BASE_Y + ROOF_TOP;

// 屋上スラブのワールド Y。建物の外は極大負値
export function domeShellY(x, z) {
  for (const [, x0, x1, z0, z1, top] of ROOMS) {
    const m = 0.05;
    if (x >= x0 - m && x <= x1 + m && z >= z0 - m && z <= z1 + m) return BASE_Y + top;
  }
  if (Math.abs(x) > HALL_HALF_X + 0.05 || Math.abs(z) > HALL_HALF_Z + 0.05) return -1.0e9;
  return ROOF_Y;
}

// 歩ける範囲（高い屋上だけ。低い屋根へは降りない）。[x0, x1, z0, z1]
const P = PARAPET_T;
export const WALK_RECTS = [
  [-HALL_HALF_X + P, HALL_HALF_X - P, -HALL_HALF_Z + P, HALL_HALF_Z - P],
  [HALL_HALF_X - P - 0.01, 34.6 - 0.25, -8.4 + 0.25, 3.6 - 0.02],          // 寝室の上（東）
  [HALL_HALF_X - P - 0.01, 24.6 + 0.85 - 0.25, 3.6 - 0.02, 7.6 - 0.25],     // 衣装部屋の上
  [HALL_HALF_X - P - 0.01, HALL_HALF_X + 0.3, MEZZ_Z0 + 0.02, MEZZ_Z1 - 0.02], // 手すりの切れ目
];

export function insideWalk(x, z, r = 0.0) {
  for (const [x0, x1, z0, z1] of WALK_RECTS) {
    if (x >= x0 + r && x <= x1 - r && z >= z0 + r && z <= z1 - r) return true;
  }
  // 角の継ぎ目は半径なしで判定
  if (r > 0) {
    let n = 0;
    for (const [x0, x1, z0, z1] of WALK_RECTS) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) n++;
    return n >= 2;
  }
  return false;
}

export function spawnPoint() {
  return new THREE.Vector3(0, ROOF_Y, 6.0);
}

// 見た目（建物・屋上・手すり・地面）
export function buildRoofScene(scene, texLoader) {
  const group = new THREE.Group();
  group.name = 'Roof';
  const plaster = new THREE.MeshStandardMaterial({ color: 0xf1ece1, roughness: 0.9 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.95 });
  const parapetMat = new THREE.MeshStandardMaterial({ color: 0xe8e1d2, roughness: 0.9 });
  const box = (w, h, d, x, y, z, mat, name) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    if (name) m.name = name;
    group.add(m);
    return m;
  };
  // 本館
  const hallH = ROOF_TOP;
  box(HALL_HALF_X * 2, hallH, HALL_HALF_Z * 2, 0, BASE_Y + hallH / 2 - 0.15, 0, plaster);
  // 屋上の床（タイル模様）
  const tileTex = makeRoofTileTexture();
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.repeat.set(HALL_HALF_X, HALL_HALF_Z);
  const roofTop = new THREE.Mesh(new THREE.PlaneGeometry(HALL_HALF_X * 2, HALL_HALF_Z * 2),
    new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.95 }));
  roofTop.rotation.x = -Math.PI / 2;
  roofTop.position.set(0, ROOF_Y + 0.002, 0);
  roofTop.receiveShadow = true;
  roofTop.name = 'RoofSlab';
  group.add(roofTop);
  // 手すり
  const py = ROOF_Y + PARAPET_H / 2;
  box(HALL_HALF_X * 2, PARAPET_H, P, 0, py, HALL_HALF_Z - P / 2, parapetMat);
  box(HALL_HALF_X * 2, PARAPET_H, P, 0, py, -HALL_HALF_Z + P / 2, parapetMat);
  box(P, PARAPET_H, HALL_HALF_Z * 2, -HALL_HALF_X + P / 2, py, 0, parapetMat);
  box(P, PARAPET_H, MEZZ_Z0 + HALL_HALF_Z, HALL_HALF_X - P / 2, py, (-HALL_HALF_Z + MEZZ_Z0) / 2, parapetMat);
  box(P, PARAPET_H, HALL_HALF_Z - MEZZ_Z1, HALL_HALF_X - P / 2, py, (MEZZ_Z1 + HALL_HALF_Z) / 2, parapetMat);
  // 手すりの上の笠木
  for (const [w, d, x, z] of [
    [HALL_HALF_X * 2 + 0.1, P + 0.1, 0, HALL_HALF_Z - P / 2], [HALL_HALF_X * 2 + 0.1, P + 0.1, 0, -HALL_HALF_Z + P / 2],
    [P + 0.1, HALL_HALF_Z * 2, -HALL_HALF_X + P / 2, 0],
  ]) box(w, 0.06, d, x, ROOF_Y + PARAPET_H + 0.03, z, trim);
  // 東の部屋と南の部屋
  for (const [name, x0, x1, z0, z1, top] of ROOMS) {
    const h = top;
    box(x1 - x0, h, z1 - z0, (x0 + x1) / 2, BASE_Y + h / 2 - 0.1, (z0 + z1) / 2, name === 'tart' ? trim : plaster, name);
    box(x1 - x0 + 0.2, 0.12, z1 - z0 + 0.2, (x0 + x1) / 2, BASE_Y + top - 0.06, (z0 + z1) / 2, roofMat);
  }
  // 寝室の上のふち（落ちないように低い縁）
  const rimH = 0.45;
  const ry = ROOF_Y - 0.52 + rimH / 2;
  box(34.6 - 20, rimH, 0.2, 27.3, ry, -8.4 + 0.1, parapetMat);
  box(0.2, rimH, 12, 34.6 - 0.1, ry, -2.4, parapetMat);
  box(34.6 - 25.45, rimH, 0.2, (25.45 + 34.6) / 2, ry, 3.6 - 0.1, parapetMat);
  box(25.45 - 20, rimH, 0.2, (20 + 25.45) / 2, ROOF_Y - 0.62 + rimH / 2, 7.6 - 0.1, parapetMat);
  box(0.2, rimH, 4.0, 25.45 - 0.1, ROOF_Y - 0.62 + rimH / 2, 5.6, parapetMat);
  // 地面
  const ground = new THREE.Mesh(new THREE.CircleGeometry(260, 48),
    new THREE.MeshStandardMaterial({ color: 0x7fa65a, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = BASE_Y - 0.3;
  ground.receiveShadow = true;
  group.add(ground);
  // 石畳の広場
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(46, 48),
    new THREE.MeshStandardMaterial({ color: 0xc9bfa8, roughness: 1 }));
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = BASE_Y - 0.28;
  plaza.receiveShadow = true;
  group.add(plaza);
  // 遠くの木
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x4f7d3a, roughness: 1 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 });
  const cone = new THREE.ConeGeometry(2.2, 6, 7);
  const trunk = new THREE.CylinderGeometry(0.3, 0.4, 2, 6);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, d = 60 + rnd() * 120;
    const x = Math.cos(a) * d, z = Math.sin(a) * d, s = 0.7 + rnd() * 1.2;
    const t = new THREE.Mesh(trunk, trunkMat);
    t.position.set(x, BASE_Y + s, z);
    t.scale.setScalar(s);
    const c = new THREE.Mesh(cone, treeMat);
    c.position.set(x, BASE_Y + s * 5, z);
    c.scale.setScalar(s);
    c.castShadow = true;
    group.add(t, c);
  }
  scene.add(group);
  return group;
}

function makeRoofTileTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#bdb6a8';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c7c0b2';
  g.fillRect(2, 2, 60, 60);
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < 40; i++) g.fillRect((i * 37) % 60, (i * 23) % 60, 3, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// プレイヤーの足元の高さ（屋上の床）
export function roofFloorAt(x, z) {
  const y = domeShellY(x, z);
  return y;
}
