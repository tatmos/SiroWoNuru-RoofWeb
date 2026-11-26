// 建材の見た目（ゲームの placeable_wall.gd の材質とメッシュ）
import * as THREE from 'three';
import { WALL_W, TRIANGLE_FACES } from './wall.js';

const BRICK_NORMAL_SCALE = 1.15;
const BRICK_NORMAL_GRAD = 3.2;
let brickTex = null, brickNormal = null, marbleTex = null;
const matCache = new Map();

function brickHeightField(w, h) {
  const BRICK_W = 16, BRICK_H = 8, MORTAR = 2;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / BRICK_H), ly = y % BRICK_H;
    const offset = row % 2 === 1 ? BRICK_W / 2 : 0;
    for (let x = 0; x < w; x++) {
      const sx = (x + offset) % w, lx = sx % BRICK_W;
      const mortar = ly < MORTAR || lx < MORTAR;
      let height = 0.12;
      if (!mortar) {
        const dx = Math.min(lx - MORTAR, BRICK_W - 1 - lx), dy = Math.min(ly - MORTAR, BRICK_H - 1 - ly);
        const bevel = Math.min(1, Math.max(0, Math.min(dx, dy) / 2.0));
        height = 0.35 + (1.0 - 0.35) * bevel * bevel;
      }
      out[x + y * w] = height;
    }
  }
  return out;
}

function getBrickTexture() {
  if (brickTex) return brickTex;
  const W = 64, H = 64, BRICK_W = 16, BRICK_H = 8, MORTAR = 2;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const mortar = [0.62, 0.58, 0.52];
  const bricks = [[0.72, 0.32, 0.22], [0.58, 0.26, 0.18], [0.78, 0.38, 0.26]];
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / BRICK_H), ly = y % BRICK_H;
    const offset = row % 2 === 1 ? BRICK_W / 2 : 0;
    for (let x = 0; x < W; x++) {
      let col = mortar;
      if (ly >= MORTAR) {
        const sx = (x + offset) % W, lx = sx % BRICK_W;
        if (lx >= MORTAR) {
          col = bricks[(Math.floor(sx / BRICK_W) + row * 3) % 3];
          if (lx === MORTAR || ly === MORTAR) col = col.map((v) => v * 0.88);
        }
      }
      const i = (x + y * W) * 4;
      img.data[i] = col[0] * 255; img.data[i + 1] = col[1] * 255; img.data[i + 2] = col[2] * 255; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  brickTex = new THREE.CanvasTexture(c);
  brickTex.colorSpace = THREE.SRGBColorSpace;
  brickTex.wrapS = brickTex.wrapT = THREE.RepeatWrapping;
  brickTex.anisotropy = 8;
  return brickTex;
}

function getBrickNormal() {
  if (brickNormal) return brickNormal;
  const W = 64, H = 64;
  const hf = brickHeightField(W, H);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const hl = hf[((x - 1 + W) % W) + y * W], hr = hf[((x + 1) % W) + y * W];
    const hu = hf[x + ((y - 1 + H) % H) * W], hd = hf[x + ((y + 1) % H) * W];
    const n = new THREE.Vector3((hl - hr) * BRICK_NORMAL_GRAD, (hu - hd) * BRICK_NORMAL_GRAD, 1).normalize();
    const i = (x + y * W) * 4;
    img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
    img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  brickNormal = new THREE.CanvasTexture(c);
  brickNormal.wrapS = brickNormal.wrapT = THREE.RepeatWrapping;
  return brickNormal;
}

export function setMarbleTexture(tex) {
  marbleTex = tex;
  marbleTex.wrapS = marbleTex.wrapT = THREE.RepeatWrapping;
  marbleTex.colorSpace = THREE.SRGBColorSpace;
  for (const [k, m] of matCache) if (k.startsWith('marble')) { m.map = marbleTex; m.needsUpdate = true; }
}

export function materialFor(kind, paint = null, ghost = null) {
  const key = `${kind}|${paint ? paint.join(',') : ''}|${ghost || ''}`;
  if (matCache.has(key)) return matCache.get(key);
  let m;
  if (kind === 'curtain') {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.24, 0.19, 0.14, THREE.SRGBColorSpace), roughness: 1, side: THREE.DoubleSide });
  } else if (kind === 'glass') {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.53, 0.88, 1.0, THREE.SRGBColorSpace), transparent: true, opacity: 0.34, roughness: 0.15, depthWrite: false });
  } else if (kind === 'marble') {
    m = new THREE.MeshStandardMaterial({ map: marbleTex, roughness: 0.42, color: 0xffffff });
  } else {
    m = new THREE.MeshStandardMaterial({ map: getBrickTexture(), normalMap: getBrickNormal(), roughness: 0.92, metalness: 0 });
    m.normalScale.set(BRICK_NORMAL_SCALE, BRICK_NORMAL_SCALE);
  }
  if (paint && paint[3] > 0 && kind !== 'glass' && kind !== 'curtain' && kind !== 'marble') {
    m.color.setRGB(paint[0], paint[1], paint[2], THREE.SRGBColorSpace);
  }
  if (ghost) {
    m = m.clone();
    m.transparent = true;
    m.opacity = 0.55;
    m.depthWrite = false;
    m.emissive = new THREE.Color(ghost === 'ok' ? 0x2f8f50 : 0xc03030);
    m.emissiveIntensity = 0.6;
  }
  matCache.set(key, m);
  return m;
}

function curtainGeometry(width, height) {
  const pos = [];
  const panel = width / 3.0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 8; j++) {
    const pts = [];
    for (const t of [j / 8.0, (j + 1) / 8.0]) {
      const x = -width * 0.5 + panel * (i + 0.035 + t * 0.93);
      const z = Math.sin(t * Math.PI * 4.0) * panel * 0.045;
      pts.push([x, height * 0.5, z], [x, -height * 0.5, z]);
    }
    for (const k of [0, 2, 1, 1, 2, 3]) pos.push(...pts[k]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function triangleGeometry(piece, uvScale) {
  const P = piece.localPoints;
  const side = piece.spanX;
  const pos = [], nor = [], uv = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const f of TRIANGLE_FACES) {
    a.copy(P[f[0]]); b.copy(P[f[1]]); c.copy(P[f[2]]);
    const n = c.clone().sub(a).cross(b.clone().sub(a)).normalize();
    // Godot は時計回りが表。three.js は反時計回りが表なので順番を入れかえる
    for (const p of [a, c, b]) {
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      const uz = Math.abs(n.y) < 0.5 ? p.y : p.z;
      const ux = Math.abs(n.x) > 0.5 ? p.z : p.x;
      uv.push((ux / side + 0.5) * uvScale[0], (uz / side + 0.5) * uvScale[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function boxGeometry(size, uvScale) {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale[0], uv.getY(i) * uvScale[1]);
  return g;
}

export function buildPieceMesh(piece, ghost = null) {
  let geo;
  const kind = piece.kind;
  const marble = kind === 'marble';
  if (piece.hexPiece && piece.isHorizontal) {
    geo = triangleGeometry(piece, marble ? [piece.spanX * 0.67, piece.spanX * 0.67] : [2.4, 1.6]);
  } else if (piece.isCurtain) {
    geo = curtainGeometry(piece.spanX, piece.shapeSize.y);
  } else {
    const s = piece.shapeSize;
    const uvs = marble ? [s.x * 0.67, s.y * 0.67] : [2.4 * (s.x / WALL_W), 1.6 * piece.stackCount];
    geo = boxGeometry(s, uvs);
  }
  const mesh = new THREE.Mesh(geo, materialFor(kind, piece.paintColor, ghost));
  mesh.position.copy(piece.position);
  mesh.rotation.y = piece.yaw;
  if (piece.isRamp) mesh.rotation.set(piece.rampPitch, piece.yaw, 0, 'YXZ');
  mesh.castShadow = !ghost && kind !== 'glass';
  mesh.receiveShadow = !ghost;
  mesh.userData.piece = piece;
  return mesh;
}
