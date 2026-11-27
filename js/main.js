// しろを塗る・屋上建築 Web 版
import * as THREE from 'three';
import {
  Piece, resolveBuildingPlacement, gridAt, isBuildingKind, xz,
} from './wall.js';
import { buildRoofScene, domeShellY, insideWalk, spawnPoint, ROOF_Y } from './roof.js';
import { buildPieceMesh, setMarbleTexture, disposeObject } from './pieces_view.js';
import { toJson, fromJson } from './roof_build_io.js';
import { export3mf } from './roof_print_export.js';
import {
  PlayerView, SPEED, SPRINT_SPEED_MUL, MOVE_ACCEL, MOVE_REVERSE_ACCEL, MOVE_DECEL, GRAVITY, JUMP_VELOCITY, RADIUS, STEP, BODY_H,
} from './player.js';
import { Hud } from './hud.js';
import { FanMenu } from './fan.js';
import { XrControls } from './xr.js';
import { Chests } from './chests.js';
import { LinkBoards } from './links.js';
import { playPlace, playPickup, playChest, playLand, Steps, playUndo } from './sound.js';
import { Climber } from './climb.js';

const PLACE_MAX_RANGE = 10.0;
const HEX_WALL_HOLD_MSEC = 220;
// 右ボタンをこれより長く押したらカメラを回す操作（ゲームの RMB_MOUSE_ORBIT_HOLD_MS）
const RMB_MOUSE_ORBIT_HOLD_MS = 460;
const LOOK_HEIGHT = 1.35;
const STORE_KEY = 'siro_roof_web_v1';
export const ITEMS = [
  { kind: 'wall', label: 'レンガ', card: 'stock_wall', art: 'assets/cards/stock_wall.png' },
  { kind: 'glass', label: 'ガラス', card: 'stock_glass', art: 'assets/cards/stock_glass.png' },
  { kind: 'curtain', label: '暖簾', card: 'stock_curtain', art: 'assets/cards/stock_curtain.png' },
  { kind: 'marble', label: '大理石', card: 'stock_marble', art: 'assets/textures/marble_white_diff_1k.jpg' },
  { kind: 'pickup', label: '回収', card: '', art: '' },
  { kind: 'pen', label: 'マジックペン', card: '', art: '' },
];

// --- three.js ---
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd0f0);
scene.fog = new THREE.Fog(0xb8dcf2, 80, 260);
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 400);
rig.add(camera);

scene.add(new THREE.HemisphereLight(0xdff1ff, 0x6b7a4a, 1.1));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.4);
sun.position.set(30, 60, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 160 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const texLoader = new THREE.TextureLoader();
buildRoofScene(scene, texLoader);
texLoader.load('assets/textures/marble_white_diff_1k.jpg', (t) => setMarbleTexture(t));

// --- 建材 ---
const piecesRoot = new THREE.Group();
piecesRoot.name = 'Pieces';
scene.add(piecesRoot);
const world = {
  pieces: [],
  gridAt,
  floorAt: (x, z) => domeShellY(x, z),
};

function addRow(row) {
  const p = new Piece(row);
  p.mesh = buildPieceMesh(p);
  piecesRoot.add(p.mesh);
  world.pieces.push(p);
  return p;
}

function removePiece(p) {
  const i = world.pieces.indexOf(p);
  if (i >= 0) world.pieces.splice(i, 1);
  piecesRoot.remove(p.mesh);
  disposeObject(p.mesh);
}

// --- 取り消し（ゲームの match_placement_undo.gd: 置く・回収・ペンで塗るを、新しい順に戻す。32 件まで） ---
const PLACE_UNDO_MAX = 32;
const undoStack = [];
function pushUndo(entry) {
  undoStack.push(entry);
  while (undoStack.length > PLACE_UNDO_MAX) undoStack.shift();
}
const pieceOfRow = (row) => world.pieces.find((p) => p.row === row);

function undoLast() {
  while (undoStack.length) {
    const e = undoStack.pop();
    if (e.op === 'place') {
      // 置いたものを回収する（持ち物に戻す）
      const p = pieceOfRow(e.row);
      if (!p) continue;
      removePiece(p);
      if (p.kind in stock) stock[p.kind] += 1;
    } else if (e.op === 'pickup') {
      // 回収したものを元の場所へ戻す（持ち物から 1 つ使う）
      if (e.row.kind in stock && (stock[e.row.kind] | 0) <= 0) continue;
      addRow(e.row);
      if (e.row.kind in stock) stock[e.row.kind] -= 1;
    } else if (e.op === 'paint') {
      // 塗る前の色へ戻す（そのあと別の色で塗りなおしていたら戻さない）
      const p = pieceOfRow(e.row);
      if (!p) continue;
      const row = { ...e.row, paint_color: e.prev };
      removePiece(p);
      addRow(row);
      // さらに前の操作の取り消しが、戻した建材を指せるように
      for (const u of undoStack) if (u.row === e.row) u.row = row;
    } else continue;
    playUndo();
    save();
    hud.refresh();
    return true;
  }
  hud.toast('取り消せる操作がありません');
  return false;
}

function clearPieces() {
  for (const p of world.pieces.slice()) removePiece(p);
}

function rows() {
  return world.pieces.map((p) => p.row);
}

function replaceRows(list) {
  clearPieces();
  undoStack.length = 0;
  for (const r of list) if (isBuildingKind(r.kind)) addRow(r);
  save();
}

// --- 持ち物（建材の数） ---
const stock = { wall: 10, glass: 10, curtain: 10, marble: 10 };
let selected = 0;

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ build: toJson(rows(), 'autosave'), stock }));
  } catch { /* 容量オーバーなどは無視 */ }
}

async function loadInitial() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  if (saved && saved.build) {
    const res = fromJson(saved.build);
    if (res.ok) {
      for (const r of res.rows) addRow(r);
      if (saved.stock) for (const k of Object.keys(stock)) stock[k] = Math.max(0, saved.stock[k] | 0);
      return;
    }
  }
  await loadSample();
}

async function loadSample() {
  try {
    const text = await (await fetch('sample/roof_sample.json')).text();
    const res = fromJson(text);
    if (res.ok) replaceRows(res.rows);
  } catch (e) { console.warn(e); }
}

// --- プレイヤー ---
const player = {
  pos: spawnPoint(),
  vel: new THREE.Vector3(),
  facing: Math.PI,
  onGround: true,
};
const playerView = new PlayerView(scene);
// 足を置く床の高さ: top より下でいちばん高い面（groundAt は足元 + STEP まで拾うので、その分を引く）
playerView.floorAt = (x, z, top) => groundAt(x, z, top - STEP);
playerView.load('assets/models/player.glb').catch((e) => console.warn('player model', e));

// 足元の高さ（屋上・板・坂・壁の上）
function groundAt(x, z, feetY) {
  let best = -Infinity;
  const dome = domeShellY(x, z);
  if (dome > -1000 && dome <= feetY + STEP) best = dome;
  const here = new THREE.Vector3(x, feetY, z);
  for (const p of world.pieces) {
    if (p.isCurtain || p.position.distanceToSquared(here) > 16) continue;
    let y = -Infinity;
    if (p.isHorizontal) {
      if (p.horizontalCoversXZ(x, z)) y = p.hexPiece ? p.surfaceYAt(x, z) : p.topY();
    } else {
      const l = p.toLocal(new THREE.Vector3(x, p.position.y, z));
      if (Math.abs(l.x) <= p.shapeSize.x / 2 + RADIUS * 0.6 && Math.abs(l.z) <= p.shapeSize.z / 2 + RADIUS * 0.6) y = p.topY();
    }
    if (y <= feetY + STEP && y > best) best = y;
  }
  return best;
}

// 縦の壁を押し返す（xz の円と箱）
function pushOutOfWalls(pos) {
  for (const p of world.pieces) {
    if (p.isHorizontal || p.isCurtain) continue;
    const bottom = p.position.y - p.shapeSize.y / 2;
    const top = p.position.y + p.shapeSize.y / 2;
    if (top <= pos.y + STEP || bottom >= pos.y + BODY_H) continue;
    if (Math.abs(p.position.x - pos.x) > 3 || Math.abs(p.position.z - pos.z) > 3) continue;
    const l = p.toLocal(pos);
    const hx = p.shapeSize.x / 2, hz = p.shapeSize.z / 2;
    const cx = Math.max(-hx, Math.min(hx, l.x)), cz = Math.max(-hz, Math.min(hz, l.z));
    let dx = l.x - cx, dz = l.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= RADIUS * RADIUS) continue;
    if (d2 < 1e-8) {
      // 中に入っている: 近い面へ
      const px = hx - Math.abs(l.x), pz = hz - Math.abs(l.z);
      if (px < pz) { l.x = Math.sign(l.x || 1) * (hx + RADIUS); } else { l.z = Math.sign(l.z || 1) * (hz + RADIUS); }
    } else {
      const d = Math.sqrt(d2);
      l.x = cx + (dx / d) * RADIUS;
      l.z = cz + (dz / d) * RADIUS;
    }
    const g = p.toGlobal(new THREE.Vector3(l.x, l.y, l.z));
    pos.x = g.x;
    pos.z = g.z;
  }
}

const input = {
  move: new THREE.Vector2(), // x: 右, y: 前
  sprint: false,
  jump: false,
  jumpHeld: false, // 滑空（二段ジャンプのあと押したまま）
};
// --- ジャンプ（ゲームの player_avatar_air_maneuver.gd と同じ） ---
const AIR_JUMP_VELOCITY = 6.2;
const GLIDE_GRAVITY_MUL = 0.2;
const GLIDE_MAX_FALL_SPEED = 2.35;
const HOP_CHAIN_LAND_WINDOW_MS = 240;
const HOP_CHAIN_THIRD_MUL = 2.0;
const NEAR_SUPPORT_GAP = 0.48;
const steps = new Steps();
const air = { jumpUsed: false, hopChain: 0, hopFromAir: false, hopLandUntil: 0, peakY: 0, wasOnGround: true };

// 地上で続けて跳ぶと 3 回目は 2 倍（着地から 0.24 秒以内）
function advanceHopChainMul(nearGround) {
  const now = performance.now();
  let timed = false;
  if (air.hopChain >= 1 && air.hopChain < 3) {
    if (now <= air.hopLandUntil) timed = true;
    else if (air.hopFromAir && player.vel.y <= 0.4 && nearGround) timed = true;
  }
  air.hopChain = timed ? air.hopChain + 1 : 1;
  air.hopFromAir = true;
  air.hopLandUntil = 0;
  if (air.hopChain >= 3) { air.hopChain = 3; return HOP_CHAIN_THIRD_MUL; }
  return 1.0;
}

function tryJump() {
  const g = groundAt(player.pos.x, player.pos.z, player.pos.y);
  const nearSupport = player.onGround || (player.pos.y - g <= NEAR_SUPPORT_GAP && player.vel.y <= 0.4);
  if (nearSupport) {
    if (!player.onGround) player.pos.y = g; // 足場に足をつけてから跳ぶ
    player.vel.y = JUMP_VELOCITY * advanceHopChainMul(true);
    player.onGround = false;
    return;
  }
  // 空中: 二段ジャンプ（1 回だけ）
  if (air.jumpUsed) return;
  air.jumpUsed = true;
  air.hopChain = 0; air.hopFromAir = false; air.hopLandUntil = 0;
  player.vel.y = Math.max(player.vel.y, 0) + AIR_JUMP_VELOCITY;
}

function onLanded(fallH) {
  air.jumpUsed = false;
  air.hopFromAir = false;
  if (air.hopChain >= 1 && air.hopChain < 3) air.hopLandUntil = performance.now() + HOP_CHAIN_LAND_WINDOW_MS;
  else { air.hopChain = 0; air.hopLandUntil = 0; }
  playLand(fallH);
  steps.reset();
}

const climber = new Climber({
  pieces: () => world.pieces,
  groundAt: (x, z, feetY) => groundAt(x, z, feetY),
  insideWalk: (x, z, r) => insideWalk(x, z, r),
  onMantleLand: (fallH) => playLand(fallH),
});

function stepPlayer(dt, viewYaw, inXrMove = false) {
  // 入力の向き（カメラ基準）
  const f = new THREE.Vector3(-Math.sin(viewYaw), 0, -Math.cos(viewYaw));
  const r = new THREE.Vector3(Math.cos(viewYaw), 0, -Math.sin(viewYaw));
  const want = f.multiplyScalar(input.move.y).add(r.multiplyScalar(input.move.x));
  if (want.lengthSq() > 1) want.normalize();
  // よじ登り（ゲームと同じ: 壁へ向かって歩き続けると掴む）
  const sDouble = climber.noteDown(input.move.y < -0.5);
  if (climber.active) {
    if (input.jump) { climber.leapUp(player); input.jump = false; }
    else if (sDouble) climber.drop(player);
    else {
      climber.tick(player, dt, input.move.y, input.move.x);
      if (climber.active) {
        player.facing = climber.facing();
        // のり越えて着地したときの音はゲームと同じく 1.2m 落ちた扱い
        air.peakY = player.pos.y + 1.2; air.wasOnGround = false; air.jumpUsed = false;
        return;
      }
    }
  } else if (climber.tryBegin(player, want)) {
    player.facing = climber.facing();
    air.peakY = player.pos.y + 1.2; air.wasOnGround = false;
    return;
  }
  want.multiplyScalar(SPEED * (input.sprint ? SPRINT_SPEED_MUL : 1));
  // ゲームの _steer_xz_velocity と同じ: 一定の加速で近づける（逆向きは速く、手を離すと MOVE_DECEL で止まる）
  const hv = new THREE.Vector3(player.vel.x, 0, player.vel.z);
  let rate = MOVE_ACCEL;
  if (want.lengthSq() > 0.0001 && hv.lengthSq() > 0.08 && hv.clone().normalize().dot(want.clone().normalize()) < -0.2) rate = MOVE_REVERSE_ACCEL;
  if (want.lengthSq() < 0.0001) rate = MOVE_DECEL;
  const diff = want.clone().sub(hv);
  const step = rate * dt;
  if (diff.length() <= step) hv.copy(want); else hv.add(diff.setLength(step));
  player.vel.x = hv.x;
  player.vel.z = hv.z;
  if (inXrMove) {
    // VR: 体は進む向きへ（見た目だけ。VR では体を出さない）
    if (want.lengthSq() > 0.01) player.facing = Math.atan2(want.x, want.z);
  } else {
    // PC・スマホの三人称: 体はいつもカメラの向き。A/D は横歩き（ゲームと同じ）
    player.facing = viewYaw + Math.PI;
  }
  if (input.jump) tryJump();
  input.jump = false;
  // 滑空: 二段ジャンプのあと押したままなら、ゆっくり落ちる
  const gliding = air.jumpUsed && input.jumpHeld && !player.onGround && player.vel.y < 0;
  player.vel.y -= GRAVITY * (gliding ? GLIDE_GRAVITY_MUL : 1) * dt;
  if (gliding && player.vel.y < -GLIDE_MAX_FALL_SPEED) player.vel.y = -GLIDE_MAX_FALL_SPEED;

  const pos = player.pos;
  const nx = pos.x + player.vel.x * dt;
  if (insideWalk(nx, pos.z, RADIUS)) pos.x = nx; else player.vel.x = 0;
  const nz = pos.z + player.vel.z * dt;
  if (insideWalk(pos.x, nz, RADIUS)) pos.z = nz; else player.vel.z = 0;
  const before = pos.clone();
  pushOutOfWalls(pos);
  if (!insideWalk(pos.x, pos.z, RADIUS)) { pos.x = before.x; pos.z = before.z; }

  const ground = groundAt(pos.x, pos.z, pos.y);
  const ny = pos.y + player.vel.y * dt;
  if (ny <= ground) {
    pos.y = ground;
    player.vel.y = 0;
    player.onGround = true;
  } else if (player.onGround && player.vel.y <= 0 && pos.y - ground < STEP) {
    pos.y = ground; // 段差を下りるときは床に吸いつく
    player.vel.y = 0;
  } else {
    pos.y = ny;
    player.onGround = false;
  }
  if (pos.y < ROOF_Y - 4) { pos.copy(spawnPoint()); player.vel.set(0, 0, 0); }
  // 着地音（落ちた高さ）と足音
  if (!player.onGround) {
    air.peakY = air.wasOnGround ? pos.y : Math.max(air.peakY, pos.y);
  } else if (!air.wasOnGround) {
    onLanded(Math.max(air.peakY - pos.y, 0));
  }
  air.wasOnGround = player.onGround;
  steps.tick(dt, pos, player.onGround);
}

// --- カメラ（デスクトップ・スマホ） ---
const cam = { yaw: Math.PI, pitch: -0.28, dist: 6.5 };

function updateCamera() {
  const target = player.pos.clone().add(new THREE.Vector3(0, LOOK_HEIGHT, 0));
  const cp = Math.cos(cam.pitch);
  const off = new THREE.Vector3(Math.sin(cam.yaw) * cp, -Math.sin(cam.pitch), Math.cos(cam.yaw) * cp).multiplyScalar(cam.dist);
  camera.position.copy(target).add(off);
  camera.lookAt(target);
}

// --- ねらい・置く ---
const ray = new THREE.Raycaster();
const ROOF_SURFACES = [];
{
  // 屋上の面（レイを当てる面）。[x0, x1, z0, z1, y]
  const sample = [[-20, 20, -14.5, 14.5], [20, 25.45, 3.6, 7.6], [20, 34.6, -8.4, 3.6], [20, 30, 3.6, 12.4],
    [-5.6, 8.4, -30.5, -14.5], [8.4, 19.6, -26.5, -14.5], [-17.6, -5.6, -26.5, -14.5]];
  for (const [x0, x1, z0, z1] of sample) ROOF_SURFACES.push([x0, x1, z0, z1, domeShellY((x0 + x1) / 2, (z0 + z1) / 2)]);
}

// レイの先: {point, piece}（屋上の面と、暖簾以外の建材）
function castAim(origin, dir) {
  let best = null, bestD = 60;
  for (const [x0, x1, z0, z1, y] of ROOF_SURFACES) {
    if (Math.abs(dir.y) < 1e-6) continue;
    const t = (y - origin.y) / dir.y;
    if (t <= 0 || t >= bestD) continue;
    const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
    if (px < x0 || px > x1 || pz < z0 || pz > z1) continue;
    if (Math.abs(domeShellY(px, pz) - y) > 0.01) continue;
    bestD = t;
    best = { point: new THREE.Vector3(px, y, pz), piece: null };
  }
  for (const p of world.pieces) {
    // 暖簾は当たり判定が無い。回収のときと、暖簾を選んでいるとき（暖簾の下に吊るす）だけねらえる（ゲームと同じ）
    if (p.isCurtain && !aimState.pickMode && kindSelected() !== 'curtain') continue;
    const h = p.rayHitPoint(origin, dir, bestD, 0.0);
    if (h) {
      const d = h.distanceTo(origin);
      if (d < bestD) { bestD = d; best = { point: h, piece: p }; }
    }
  }
  return best;
}

const aimState = {
  pickMode: false,
  pressAt: -1,
  pressing: false,
  pressSource: '',
  target: null,
  hit: null,
  pickPiece: null,
  reason: '',
};
let ghost = null;
// 回収する建材の輪郭（形どおりの線。暖簾は揺れに合わせて毎フレーム追う）
const OUTLINE_MAT = new THREE.LineBasicMaterial({ color: 0x40ff90, transparent: true, opacity: 0.95, depthTest: false });
let pickOutline = null; // {piece, group, pairs: [[mesh, line]]}
function showPickOutline(piece) {
  if (pickOutline && pickOutline.piece !== piece) {
    scene.remove(pickOutline.group);
    pickOutline.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    pickOutline = null;
  }
  if (!piece) return;
  if (!pickOutline) {
    const group = new THREE.Group();
    group.renderOrder = 5;
    const pairs = [];
    piece.mesh.traverse((m) => {
      if (!m.isMesh) return;
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), OUTLINE_MAT);
      line.matrixAutoUpdate = false;
      line.renderOrder = 5;
      group.add(line);
      pairs.push([m, line]);
    });
    scene.add(group);
    pickOutline = { piece, group, pairs };
  }
  piece.mesh.updateMatrixWorld(true);
  for (const [m, line] of pickOutline.pairs) line.matrix.copy(m.matrixWorld);
}

function kindSelected() { return ITEMS[selected].kind; }

// --- マジックペン（ゲームの magic_pen.gd・shoe_defs.gd）: 靴のテーマの 7 色から選び、建材を模様のまま塗りかえる ---
const SHOE_THEMES = [
  ['rainbow', '7色の靴', ['#ff2d3d', '#ff8a1f', '#ffe11f', '#2dd84a', '#2d9cff', '#3b4bff', '#b03dff']],
  ['fancy', 'ファンシー靴', ['#ff7ac8', '#b79cff', '#7fffd4', '#fff27a', '#7ad7ff', '#ffb48a', '#e65cff']],
  ['pastel', 'パステル靴', ['#ffc2d4', '#ffd8b8', '#fff3b0', '#c5f0c8', '#bdebf5', '#c9d2ff', '#e3c9ff']],
  ['natural', 'ナチュラル靴', ['#e8d9b5', '#c9b28a', '#8a9a5b', '#5e7f4a', '#3f6b47', '#b07a52', '#6f4e37']],
  ['vivid', 'ビビッド靴', ['#e8002d', '#ff6d00', '#ffd600', '#00c853', '#00e5ff', '#0057ff', '#ff00a8']],
  ['vintage', 'ヴィンテージ靴', ['#d2a24c', '#b5533c', '#3e7c7b', '#e9ddb8', '#c48b8b', '#8b8f5a', '#7a5c46']],
  ['retro', 'レトロ靴', ['#e8761e', '#e0b000', '#7c8f2a', '#7a4a21', '#f2e2b8', '#1f7a7a', '#b5302a']],
  ['chic', 'シック靴', ['#1b1b1f', '#1f2a44', '#6e1f2e', '#3c3f46', '#b8964a', '#1f4b3a', '#e8e3d6']],
  ['modern', 'モダン靴', ['#f4f4f4', '#d4d4d4', '#a8a8a8', '#7d8791', '#5a5a5a', '#2e2e2e', '#0e0e0e']],
  ['cool', 'クール靴', ['#0097a7', '#26c6da', '#80deea', '#4fc3f7', '#1976d2', '#b0bec5', '#e0e8ec']],
  ['fresh', 'フレッシュ靴', ['#ffd54f', '#ff9f1c', '#c6e03a', '#7ed957', '#fff8b0', '#7de3c9', '#ff6f61']],
];
const pen = { shoe: -1, index: -1 }; // 選んだ色（まだなら -1）
const hexToRgb = (h) => [1, 3, 5].map((i) => Number((parseInt(h.substr(i, 2), 16) / 255).toFixed(4)));
function penColorHex() { return pen.shoe >= 0 ? SHOE_THEMES[pen.shoe][2][pen.index] : null; }
function setPenColor(shoe, index) {
  pen.shoe = shoe; pen.index = index;
  try { localStorage.setItem('siro_roof_web_pen', JSON.stringify(pen)); } catch { /* */ }
  hud.refresh();
}
try { Object.assign(pen, JSON.parse(localStorage.getItem('siro_roof_web_pen') || '{}')); } catch { /* */ }

function openPenPalette() {
  if (renderer.xr.isPresenting) {
    // VR では色えらびを出せないので、7色の靴の赤で塗る
    setPenColor(0, 0);
    xr.notice('ペンの色: 赤（色は PC かスマホで選べます）');
    return;
  }
  if (useCenterAim) hud.showPalette(SHOE_THEMES, (si, ci) => setPenColor(si, ci));
  else fan.show('pen-shoes');
}

// 建材を塗る（ゲームの _paint_building: 同じ色なら何もしない）
function paintPiece(p) {
  const hex = penColorHex();
  if (!hex) return false;
  const rgb = hexToRgb(hex);
  const cur = p.row.paint_color;
  if (cur && Math.abs(cur[0] - rgb[0]) < 1e-3 && Math.abs(cur[1] - rgb[1]) < 1e-3 && Math.abs(cur[2] - rgb[2]) < 1e-3) return true;
  const row = { ...p.row, paint_color: [...rgb, 1] };
  removePiece(p);
  addRow(row);
  // 前の塗りの取り消しが、新しい建材を指すように付けかえる
  for (const u of undoStack) if (u.row === p.row) u.row = row;
  pushUndo({ op: 'paint', row, prev: p.row.paint_color || null });
  playPlace('glass');
  save();
  return true;
}

function evaluateAim(origin, dir) {
  const kind = kindSelected();
  // 回収とマジックペンは、ねらった建材を選ぶ
  aimState.pickMode = kind === 'pickup' || kind === 'pen';
  aimState.pen = kind === 'pen';
  const hit = castAim(origin, dir);
  aimState.hit = hit;
  aimState.target = null;
  aimState.pickPiece = null;
  aimState.reason = '';
  if (!hit) return;
  if (aimState.pickMode) {
    if (hit.piece && xz(hit.piece.position).distanceTo(xz(player.pos)) <= PLACE_MAX_RANGE) aimState.pickPiece = hit.piece;
    return;
  }
  const vertical = aimState.pressing && performance.now() - aimState.pressAt >= HEX_WALL_HOLD_MSEC;
  const snap = resolveBuildingPlacement(world, kind, hit.point, dir, vertical);
  if (!snap || !snap.pos) return;
  if (kind === 'curtain' && !snap.support) {
    // 吊るす板が無い: ガイドは出さず、置ける所を案内する
    aimState.reason = '暖簾は、床・天井の板の下か、暖簾の下に吊るせます';
    aimState.target = { ...snap, ok: false, kind, hidden: true };
    return;
  }
  let ok = !!snap.ok;
  const pos = snap.pos;
  if (xz(pos).distanceTo(xz(player.pos)) > PLACE_MAX_RANGE) { ok = false; aimState.reason = '遠すぎます'; }
  // 屋上の上だけ（ゲームの _roof_wall_name と同じ）
  const roof = domeShellY(pos.x, pos.z);
  if (roof <= -1000 || pos.y < roof - 0.15) {
    if (!(kind === 'curtain' && snap.support)) { ok = false; aimState.reason = '屋上の上に置けます'; }
  }
  if ((stock[kind] | 0) <= 0) { ok = false; aimState.reason = `${ITEMS[selected].label}がありません（宝箱から出ます）`; }
  aimState.target = { ...snap, ok, kind };
}

function targetRow(t) {
  return {
    kind: t.kind, pos: t.pos.clone(), yaw: t.yaw || 0, horizontal: !!t.horizontal,
    pitch: t.pitch || 0, span_x: t.span_x, stacks: 1, paint_color: null,
  };
}

let ghostKey = '';
function updateGhost() {
  // 同じ置き場所なら作りなおさない
  const t0 = aimState.target;
  const key = !aimState.pickMode && t0
    ? `${t0.kind}|${t0.ok}|${t0.pos.x.toFixed(3)},${t0.pos.y.toFixed(3)},${t0.pos.z.toFixed(3)}|${(t0.yaw || 0).toFixed(3)}|${(t0.pitch || 0).toFixed(3)}|${t0.horizontal}`
    : '';
  if (key && key === ghostKey && ghost) return;
  ghostKey = key;
  if (ghost) { piecesRoot.remove(ghost); disposeObject(ghost); ghost = null; }
  if (aimState.pickMode) {
    showPickOutline(aimState.pickPiece);
    return;
  }
  showPickOutline(null);
  const t = aimState.target;
  if (!t || t.hidden) return;
  const p = new Piece(targetRow(t));
  ghost = buildPieceMesh(p, t.ok ? 'ok' : 'bad');
  ghost.renderOrder = 2;
  piecesRoot.add(ghost);
}

function commitPress() {
  if (kindSelected() === 'pen') {
    // 色をまだ選んでいなければ、色えらびを出す（ゲームと同じ）
    if (!penColorHex()) { openPenPalette(); return; }
    const p = aimState.pickPiece;
    if (!p) { hud.toast('建材をねらってください'); return; }
    paintPiece(p);
    return;
  }
  if (aimState.pickMode) {
    const p = aimState.pickPiece;
    if (p) {
      removePiece(p);
      pushUndo({ op: 'pickup', row: p.row });
      playPickup();
      if (p.kind in stock) stock[p.kind] += 1;
      save();
      hud.refresh();
      hud.toast(`${labelOf(p.kind)}を回収しました`);
    }
    return;
  }
  const t = aimState.target;
  if (!t) return;
  if (!t.ok) { if (aimState.reason) hud.toast(aimState.reason); return; }
  const placed = addRow(targetRow(t));
  pushUndo({ op: 'place', row: placed.row });
  playPlace(t.kind);
  stock[t.kind] -= 1;
  save();
  hud.refresh();
}

const labelOf = (kind) => (ITEMS.find((i) => i.kind === kind) || { label: kind }).label;

function beginPress(source) {
  aimState.pressing = true;
  aimState.pressAt = performance.now();
  aimState.pressSource = source;
}

function endPress(source, cancel = false) {
  if (!aimState.pressing || aimState.pressSource !== source) return;
  // 押していた長さで決まる（押す = 床、長押し = 壁）。最後のねらいで置く
  if (!cancel) {
    const o = aimOrigin.clone(), d = aimDir.clone();
    evaluateAim(o, d);
    commitPress();
  }
  aimState.pressing = false;
  aimState.pressAt = -1;
}

// --- 入力（デスクトップ・スマホ） ---
const aimOrigin = new THREE.Vector3();
const aimDir = new THREE.Vector3(0, 0, -1);
const pointer = new THREE.Vector2(0, 0);
let pointerInside = false;
let useCenterAim = false; // スマホは画面の真ん中でねらう
const keys = new Set();
let rmbDrag = null;

function selectItem(i) {
  selected = (i + ITEMS.length) % ITEMS.length;
  hud.refresh();
  xr.refreshMenu();
}

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  keys.add(e.code);
  if (e.code === 'Space') { if (!e.repeat) input.jump = true; e.preventDefault(); }
  const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(e.code);
  if (n >= 0) selectItem(n);
  if (e.code === 'KeyQ') selectItem(selected - 1);
  if (e.code === 'KeyE') selectItem(selected + 1);
  if (e.code === 'KeyF') selectItem(selected === 4 ? 0 : 4);
  if (e.code === 'KeyR') chests.tryOpenNear(player.pos, 2.2);
  if (e.code === 'Escape' && fan.open) fan.close();
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) { undoLast(); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return; // タッチは touch.js 側
  canvas.setPointerCapture(e.pointerId);
  pointerInside = true;
  setPointer(e);
  if (e.button === 2 || e.button === 1) {
    rmbDrag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, at: performance.now(), moved: false, button: e.button };
    return;
  }
  if (e.button === 0 && fan.open) {
    // 扇が出ているときの左クリックは、板をクリックすればその板、それ以外はカーソルの項目を持つ
    if (!fan.clickAt(e.clientX, e.clientY)) fan.confirm();
    return;
  }
  if (e.button === 0) {
    // 宝箱のカード・リンクの看板を先に見る
    computeAimRay();
    if (chests.handleRay(aimOrigin, aimDir)) return;
    if (links.handleRay(aimOrigin, aimDir)) return;
    beginPress('mouse');
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  pointerInside = true;
  setPointer(e);
  if (rmbDrag) {
    if (Math.abs(e.clientX - rmbDrag.x) + Math.abs(e.clientY - rmbDrag.y) > 6) rmbDrag.moved = true;
    cam.yaw = rmbDrag.yaw - (e.clientX - rmbDrag.x) * 0.006;
    cam.pitch = Math.max(-1.45, Math.min(0.9, rmbDrag.pitch - (e.clientY - rmbDrag.y) * 0.005));
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') return;
  if ((e.button === 2 || e.button === 1) && rmbDrag) {
    // 動かさずに短く押した右クリック: 扇メニューを出す／閉じる（ゲームと同じ）。登っているときは壁から外へ跳ぶ
    const click = rmbDrag.button === 2 && !rmbDrag.moved && performance.now() - rmbDrag.at < RMB_MOUSE_ORBIT_HOLD_MS;
    rmbDrag = null;
    if (click) {
      if (climber.active) climber.leapAway(player);
      else fan.toggle();
    }
    return;
  }
  if (e.button === 0) endPress('mouse');
});
canvas.addEventListener('pointerleave', () => { pointerInside = false; });
canvas.addEventListener('wheel', (e) => {
  // 扇が出ているあいだは、ホイールで項目を選ぶ
  if (fan.open) { fan.step(e.deltaY > 0 ? 1 : -1); e.preventDefault(); return; }
  cam.dist = Math.max(2.0, Math.min(16, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
  e.preventDefault();
}, { passive: false });

function setPointer(e) {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
}

function computeAimRay() {
  const p = useCenterAim ? new THREE.Vector2(0, 0.08) : pointer;
  ray.setFromCamera(p, camera);
  aimOrigin.copy(ray.ray.origin);
  aimDir.copy(ray.ray.direction);
}

// スマホ: 左のスティックで歩く、右をなぞって見回す、ボタンで置く
const touch = { stick: null, look: null, stickVec: new THREE.Vector2() };
function setupTouch() {
  const stickEl = document.getElementById('stick');
  const knob = document.getElementById('stick-knob');
  const placeBtn = document.getElementById('btn-place');
  const jumpBtn = document.getElementById('btn-jump');
  const enableTouchUi = () => {
    if (useCenterAim) return;
    useCenterAim = true;
    document.body.classList.add('touch');
  };
  canvas.addEventListener('touchstart', (e) => {
    enableTouchUi();
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.4 && !touch.stick) {
        touch.stick = { id: t.identifier, x: t.clientX, y: t.clientY };
        stickEl.style.left = `${t.clientX - 60}px`;
        stickEl.style.top = `${t.clientY - 60}px`;
        stickEl.classList.add('on');
      } else if (!touch.look) {
        touch.look = { id: t.identifier, x: t.clientX, y: t.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: false, at: performance.now() };
      }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (touch.stick && t.identifier === touch.stick.id) {
        const dx = t.clientX - touch.stick.x, dy = t.clientY - touch.stick.y;
        const v = new THREE.Vector2(dx, dy);
        if (v.length() > 50) v.setLength(50);
        knob.style.transform = `translate(${v.x}px, ${v.y}px)`;
        touch.stickVec.set(v.x / 50, -v.y / 50);
      } else if (touch.look && t.identifier === touch.look.id) {
        const dx = t.clientX - touch.look.x, dy = t.clientY - touch.look.y;
        if (Math.abs(dx) + Math.abs(dy) > 8) touch.look.moved = true;
        cam.yaw = touch.look.yaw - dx * 0.008;
        cam.pitch = Math.max(-1.45, Math.min(0.9, touch.look.pitch - dy * 0.006));
      }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (touch.stick && t.identifier === touch.stick.id) {
        touch.stick = null;
        touch.stickVec.set(0, 0);
        knob.style.transform = '';
        stickEl.classList.remove('on');
      } else if (touch.look && t.identifier === touch.look.id) {
        // 動かさずに軽くたたいた: カードや看板、宝箱を選ぶ
        if (!touch.look.moved && performance.now() - touch.look.at < 300) {
          pointer.set((t.clientX / window.innerWidth) * 2 - 1, -(t.clientY / window.innerHeight) * 2 + 1);
          ray.setFromCamera(pointer, camera);
          if (!chests.handleRay(ray.ray.origin, ray.ray.direction)) links.handleRay(ray.ray.origin, ray.ray.direction);
        }
        touch.look = null;
      }
    }
  };
  canvas.addEventListener('touchend', end);
  canvas.addEventListener('touchcancel', end);
  const hold = (el, down, up) => {
    el.addEventListener('touchstart', (e) => { enableTouchUi(); down(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    el.addEventListener('touchend', (e) => { up(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    el.addEventListener('touchcancel', () => up(true));
  };
  hold(placeBtn, () => beginPress('touch'), (cancel) => endPress('touch', cancel === true));
  hold(jumpBtn, () => { input.jump = true; touch.jumpHeld = true; }, () => { touch.jumpHeld = false; });
}

// --- HUD・宝箱・看板・VR ---
// 右手の扇メニュー（PC）。右手の画面の位置に出す
const fan = new FanMenu({
  page: (name) => {
    if (name === 'pen-shoes') {
      // ペン: 靴のテーマをえらぶ
      return {
        cursor: Math.max(0, pen.shoe),
        entries: [
          ...SHOE_THEMES.map(([, label, cols], i) => ({
            label, swatch: `linear-gradient(135deg, ${cols.join(', ')})`,
            held: () => pen.shoe === i, run: () => `pen-colors:${i}`,
          })),
          { label: 'もどる', sym: '↩', run: () => 'main' },
        ],
      };
    }
    if (name.startsWith('pen-colors:')) {
      const si = Number(name.split(':')[1]);
      const [, , cols] = SHOE_THEMES[si];
      return {
        cursor: pen.shoe === si ? pen.index : 0,
        entries: [
          ...cols.map((c, ci) => ({
            label: `${ci + 1}`, swatch: c, held: () => pen.shoe === si && pen.index === ci,
            run: () => { setPenColor(si, ci); selectItem(ITEMS.findIndex((it) => it.kind === 'pen')); return null; },
          })),
          { label: 'もどる', sym: '↩', run: () => 'pen-shoes' },
        ],
      };
    }
    // いちばん上: 建材・回収・マジックペン・とじる
    return {
      cursor: selected,
      entries: [
        ...ITEMS.map((it, i) => ({
          label: it.label, art: it.art,
          sym: it.kind === 'pickup' ? '⤺' : (it.kind === 'pen' ? '✎' : ''),
          swatch: it.kind === 'pen' ? (penColorHex() || null) : null,
          count: it.kind in stock ? () => stock[it.kind] | 0 : null,
          empty: it.kind in stock ? () => (stock[it.kind] | 0) <= 0 : null,
          held: () => selected === i,
          // ペンは選ぶと色えらびへ（ゲームの「入れ物」と同じく扇の 2 階層目）
          run: () => { selectItem(i); return it.kind === 'pen' ? 'pen-shoes' : null; },
        })),
        // 取り消し（ゲームと同じく、選んでも扇は開いたまま）
        { label: '取り消し', sym: '↶', count: () => undoStack.length || '', run: () => { undoLast(); return 'main'; } },
        { label: 'とじる', sym: '×', run: () => null },
      ],
    };
  },
  anchor: () => {
    const hand = playerView.rightHand;
    const v = new THREE.Vector3();
    if (hand) hand.getWorldPosition(v); else v.copy(player.pos).add(new THREE.Vector3(0, 1.0, 0));
    v.project(camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
  },
});

const hud = new Hud({
  undo: () => undoLast(),
  penColor: () => penColorHex(),
  penPalette: () => openPenPalette(),
  items: ITEMS,
  stock,
  getSelected: () => selected,
  select: selectItem,
  exportJson: () => {
    const title = buildTitle();
    downloadBytes(new TextEncoder().encode(toJson(rows(), title)), `${title}.json`, 'application/json');
  },
  importJson: (text) => {
    const res = fromJson(text);
    if (!res.ok) { hud.toast(res.error === 'version' ? '新しい版の JSON は読めません' : 'しろを塗るの屋上 JSON ではありません'); return; }
    replaceRows(res.rows);
    hud.toast(`${world.pieces.length} 個の建材を読み込みました`);
  },
  export3mf: (withBase) => {
    const title = buildTitle();
    const res = export3mf(rows(), 100.0, withBase, true, title);
    if (!res.ok) { hud.toast('レンガ・ガラス・大理石の建材がありません'); return; }
    downloadBytes(res.bytes, `${title}_1-100.3mf`, 'model/3mf');
    let msg = `3MF を書き出しました（${res.objects} 個の部品）`;
    if (res.skipped_noren) msg += `。両どなりに壁のない暖簾 ${res.skipped_noren} 本は入れていません`;
    if (res.over_bed) msg += '。256mm の台に入りきりません';
    hud.toast(msg, 6000);
  },
  loadSample: async () => { await loadSample(); hud.toast('見本の建物を読み込みました'); },
  clearAll: () => { replaceRows([]); hud.toast('屋上の建材をすべて消しました'); },
  respawn: () => { player.pos.copy(spawnPoint()); player.vel.set(0, 0, 0); },
});

function buildTitle() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `roof_build_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBytes(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const chests = new Chests(scene, {
  items: ITEMS,
  camera,
  isXr: () => renderer.xr.isPresenting,
  onOpen: () => playChest(),
  onPick: (kind, n) => {
    stock[kind] = (stock[kind] | 0) + n;
    save();
    hud.refresh();
    xr.refreshMenu();
    hud.toast(`${labelOf(kind)} +${n}`);
  },
  roofPointNear: (center) => {
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, d = 2.5 + Math.random() * 5;
      const x = center.x + Math.cos(a) * d, z = center.z + Math.sin(a) * d;
      if (insideWalk(x, z, 0.8)) return new THREE.Vector3(x, groundAt(x, z, ROOF_Y + 30), z);
    }
    return new THREE.Vector3(0, ROOF_Y, 0);
  },
  showChoice: (cards, pick) => hud.showCards(cards, pick),
});

const links = new LinkBoards(scene, {
  onOpen: (url, label) => {
    if (renderer.xr.isPresenting) {
      xr.pendingUrl = url;
      xr.notice(`${label} は VR を終えると開きます`);
      return;
    }
    window.open(url, '_blank', 'noopener');
  },
});

const xr = new XrControls(renderer, scene, rig, camera, {
  items: ITEMS,
  stock,
  getSelected: () => selected,
  select: selectItem,
  input,
  beginPress: () => beginPress('xr'),
  endPress: () => endPress('xr'),
  handleRay: (o, d) => chests.handleRay(o, d) || links.handleRay(o, d),
  onEnd: () => { if (xr.pendingUrl) { window.open(xr.pendingUrl, '_blank', 'noopener'); xr.pendingUrl = null; } },
});
hud.setupXrButton(xr);
{
  // 数が変わったら VR の右手メニューも書きなおす
  const refreshHud = hud.refresh.bind(hud);
  hud.refresh = () => { refreshHud(); xr.refreshMenu(); };
}

setupTouch();
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- 暖簾のたわみ（ゲームの lobby_tart_room.gd の _animate_curtain と同じ数値） ---
const STRIP_MAX_ANGLE = 1.0;
const STRIP_REACH_X = 0.95; // 布の前後（面からの距離）
const STRIP_REACH_Z = 0.5; // 布の左右
const curtainSide = new Map();

// 同じ場所・向きで縦に連なった暖簾を 1 本にまとめる（いちばん上を支点に一緒に揺れる）
function curtainColumns() {
  const groups = new Map();
  for (const p of world.pieces) {
    if (!p.isCurtain || !p.mesh.userData.strips) continue;
    const yawKey = (((p.yaw % Math.PI) + Math.PI) % Math.PI);
    const key = `${p.position.x.toFixed(2)}|${p.position.z.toFixed(2)}|${(yawKey > Math.PI - 0.02 ? 0 : yawKey).toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const cols = [];
  for (const list of groups.values()) {
    list.sort((x, y) => y.position.y - x.position.y); // 上から
    let cur = null;
    for (const p of list) {
      const top = p.position.y + p.shapeSize.y / 2;
      if (cur && Math.abs(cur.bottom - top) < 0.05) {
        cur.pieces.push(p);
        cur.bottom = p.position.y - p.shapeSize.y / 2;
      } else {
        cur = { key: '', ref: p, top, bottom: p.position.y - p.shapeSize.y / 2, pieces: [p] };
        cols.push(cur);
      }
    }
  }
  for (const c of cols) c.key = `${c.ref.position.x.toFixed(2)}|${c.top.toFixed(2)}|${c.ref.position.z.toFixed(2)}`;
  return cols;
}

function animateCurtains(dt) {
  const k = 1.0 - Math.exp(-dt * 9.0);
  const t = performance.now() * 0.0011;
  const pushers = [player.pos.clone().add(new THREE.Vector3(0, 0.9, 0))];
  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  pushers.push(camPos);
  for (const col of curtainColumns()) {
    const ref = col.ref;
    const refStrips = ref.mesh.userData.strips;
    const near = pushers.some((q) => Math.hypot(q.x - ref.position.x, q.z - ref.position.z) < 4);
    // 柱の中の高さは、いちばん上の暖簾の中心から見た位置
    const topLocal = col.top - ref.position.y;
    const bottomLocal = col.bottom - ref.position.y;
    const locals = near ? pushers.map((q) => ref.toLocal(q)) : [];
    const sides = curtainSide.get(col.key) || [0, 0];
    const angles = refStrips.map((s, i) => {
      let target = 0;
      locals.forEach((l, j) => {
        if (l.y < bottomLocal - 0.3 || l.y > topLocal + 0.3) return;
        const dx = l.z; // 布の面からの距離
        if (Math.abs(dx) > STRIP_REACH_X || Math.abs(l.x) > ref.spanX / 2 + 0.3) return;
        if (Math.abs(dx) > 0.14 || !sides[j]) sides[j] = dx < 0 ? -1 : 1;
        const wz = Math.min(1, Math.max(0, 1 - (Math.abs(l.x - s.x) - 0.2) / STRIP_REACH_Z));
        const wx = Math.min(1, Math.max(0, 1 - Math.abs(dx) / STRIP_REACH_X));
        const a = sides[j] * STRIP_MAX_ANGLE * wz * Math.sqrt(wx);
        if (Math.abs(a) > Math.abs(target)) target = a;
      });
      // 風もないのに少しゆれる
      target += Math.sin(t + i * 1.3 + ref.position.x) * 0.015;
      s.angle += (target - s.angle) * k;
      return s.angle;
    });
    curtainSide.set(col.key, sides);
    // 柱の暖簾を、いちばん上を支点に同じ角度で回す（下の暖簾は上の布の続きになる）
    for (const p of col.pieces) {
      const same = Math.cos(p.yaw - ref.yaw) > 0;
      const half = p.shapeSize.y / 2;
      const dTop = col.top - (p.position.y + half); // この暖簾の上端から柱の上端まで
      p.mesh.userData.strips.forEach((s, j) => {
        const th = same ? angles[j] : -angles[2 - j];
        s.pivot.position.set(s.x, half + dTop - dTop * Math.cos(th), -dTop * Math.sin(th));
        s.pivot.rotation.x = th;
      });
    }
  }
}

// --- まわす ---
const clock = new THREE.Clock();
let saveTimer = 0;
let frameNo = 0;
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  xr.status('画面（WebGL）が失われました。ページを読み込みなおしてください', true);
});

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const inXr = renderer.xr.isPresenting;
  let viewYaw = cam.yaw;
  if (inXr) {
    xr.update(dt);
    viewYaw = xr.headYaw();
    input.move.copy(xr.move);
    input.sprint = xr.sprint;
    input.jumpHeld = xr.jumpHeld;
  } else {
    const mv = new THREE.Vector2(
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
    );
    if (touch.stickVec.lengthSq() > 0.0004) mv.copy(touch.stickVec);
    input.move.copy(mv);
    input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.stickVec.length() > 0.95;
    input.jumpHeld = keys.has('Space') || touch.jumpHeld;
  }
  stepPlayer(dt, viewYaw, inXr);
  playerView.update(dt, player.pos, player.facing, player.vel, player.onGround, climber.active ? climber : null);
  playerView.root.visible = !inXr;

  if (inXr) {
    xr.placeRig(player.pos);
    xr.aimRay(aimOrigin, aimDir);
  } else {
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    updateCamera();
    if (pointerInside || useCenterAim) computeAimRay();
  }
  if (fan.open) { aimState.target = null; aimState.pickPiece = null; } // 扇を出しているあいだは置かない
  else if (inXr || pointerInside || useCenterAim) evaluateAim(aimOrigin, aimDir);
  else { aimState.target = null; aimState.pickPiece = null; }
  updateGhost();
  hud.setAimHint(aimState, inXr);

  chests.update(dt, player.pos);
  fan.update(dt);
  animateCurtains(dt);
  links.update(aimOrigin, aimDir);
  sun.position.set(player.pos.x + 30, player.pos.y + 50, player.pos.z + 20);
  sun.target.position.copy(player.pos);

  saveTimer += dt;
  if (saveTimer > 5) { saveTimer = 0; save(); }
  // VR では両目を描くので、影は 6 フレームに 1 回だけ描きなおす
  frameNo += 1;
  renderer.shadowMap.autoUpdate = !inXr;
  if (inXr && frameNo % 6 === 0) renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  if (inXr && xr.firstFramePending) { xr.firstFramePending = false; xr.status('VR の最初の画面を描きました'); }
}

await loadInitial();
hud.refresh();
xr.refreshMenu();
renderer.setAnimationLoop(frame);
document.body.classList.add('ready');
window.__siro = { world, stock, player, rows, export3mf, toJson, chests, climber, playerView, camera, cam };
