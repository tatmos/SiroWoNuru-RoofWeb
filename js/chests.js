// 空から降る宝箱。開けると建築の補給カード（レンガ・ガラス・暖簾・大理石）を 3 枚から 1 枚えらぶ
import * as THREE from 'three';

const CHEST_INTERVAL_SEC = 60.0;
const FIRST_CHEST_SEC = 8.0;
const CHEST_SPAWN_HEIGHT = 22.0;
const MAX_CHESTS = 3;
const STOCK_ADD = 10;
// ここから下はゲームの scripts/game/treasure_chest.gd と同じ
const FALL_SPEED = 1.35; // 風船につられて一定の速さで降りる
const BOB_AMP = 0.12;
const BOB_HZ = 1.6;
const BUMP_RADIUS = 1.35; // この距離に BUMP_OPEN_SEC いると開く
const BUMP_AIR_Y = 2.2; // 降りている途中は高さもこの範囲
const BUMP_OPEN_SEC = 0.425;
const DEFLATE_SEC = 0.7;
const BALLOON_Y = 1.55;
const STRING_Y = 0.76;
const LID_TOP_Y = 0.18;
const LAND_OFFSET = 0.35; // 原点は箱の底からこの高さ
const BOX_W = 0.7, BOX_D = 0.55, BOX_HB = 0.34, BOX_HL = 0.19;

const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

export class Chests {
  constructor(scene, o) {
    this.scene = scene;
    this.o = o;
    this.list = [];
    this.timer = CHEST_INTERVAL_SEC - FIRST_CHEST_SEC;
    this.choice = null; // {group, cards: [{mesh, item}]}
    this.boxMat = new THREE.MeshStandardMaterial({ color: srgb(0.62, 0.36, 0.16), roughness: 0.7, emissive: srgb(0.85, 0.5, 0.18), emissiveIntensity: 0.08 });
    this.bandMat = new THREE.MeshStandardMaterial({ color: srgb(0.2, 0.19, 0.2), roughness: 0.5, metalness: 0.4 });
    this.accentMat = new THREE.MeshStandardMaterial({ color: srgb(1.0, 0.8, 0.3), roughness: 0.35, metalness: 0.6, emissive: srgb(1.0, 0.75, 0.3), emissiveIntensity: 0.25 });
    this.texLoader = new THREE.TextureLoader();
    this.tex = {};
  }

  _makeChest() {
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
    const y0 = -LAND_OFFSET;
    add(new THREE.BoxGeometry(BOX_W, BOX_HB, BOX_D), this.boxMat, 0, y0 + BOX_HB / 2, 0);
    const lid = add(new THREE.BoxGeometry(BOX_W + 0.02, BOX_HL, BOX_D + 0.02), this.boxMat, 0, y0 + BOX_HB + BOX_HL / 2, 0);
    add(new THREE.BoxGeometry(0.1, BOX_HB + BOX_HL + 0.01, BOX_D + 0.03), this.bandMat, -BOX_W * 0.3, y0 + (BOX_HB + BOX_HL) / 2, 0);
    add(new THREE.BoxGeometry(0.1, BOX_HB + BOX_HL + 0.01, BOX_D + 0.03), this.bandMat, BOX_W * 0.3, y0 + (BOX_HB + BOX_HL) / 2, 0);
    add(new THREE.BoxGeometry(0.12, 0.12, 0.04), this.accentMat, 0, y0 + BOX_HB, BOX_D / 2 + 0.02);
    // 風船とひも（ゲームと同じ大きさ・色）
    const balloonMat = new THREE.MeshStandardMaterial({ color: srgb(1.0, 0.35, 0.4), roughness: 0.35, emissive: srgb(0.9, 0.2, 0.25), emissiveIntensity: 0.15, transparent: true });
    const balloon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), balloonMat);
    balloon.position.y = BALLOON_Y;
    balloon.scale.set(1.0, 1.12, 1.0);
    balloon.castShadow = true;
    const knot = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 8), balloonMat);
    knot.position.y = -0.53;
    knot.rotation.x = Math.PI;
    balloon.add(knot);
    const stringMat = new THREE.MeshBasicMaterial({ color: srgb(0.9, 0.85, 0.7), transparent: true });
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.15, 8), stringMat);
    string.position.y = STRING_Y;
    g.add(balloon, string);
    const glow = new THREE.PointLight(srgb(1.0, 0.8, 0.35), 0, 5);
    glow.position.y = 0.5;
    g.add(glow);
    this.scene.add(g);
    return { g, lid, balloon, balloonMat, string, stringMat, glow };
  }

  spawnNear(center) {
    if (this.list.length >= MAX_CHESTS) return;
    const at = this.o.roofPointNear(center);
    const parts = this._makeChest();
    parts.g.position.set(at.x, at.y + LAND_OFFSET + CHEST_SPAWN_HEIGHT, at.z);
    this.list.push({ ...parts, target: at.y + LAND_OFFSET, falling: true, bob: Math.random() * 6, bump: 0, deflate: -1 });
  }

  update(dt, playerPos) {
    this.timer += dt;
    if (this.timer >= CHEST_INTERVAL_SEC) {
      this.timer = 0;
      this.spawnNear(playerPos);
    }
    for (const c of this.list) {
      c.bob += dt;
      if (c.falling) {
        c.g.position.y = Math.max(c.g.position.y - FALL_SPEED * dt, c.target);
        if (c.g.position.y <= c.target + 0.02) {
          c.g.position.y = c.target;
          c.falling = false;
          c.deflate = 0;
        } else {
          // 降りているあいだも風船が少しゆれる
          c.balloon.position.y = BALLOON_Y + Math.sin(c.bob * BOB_HZ * Math.PI * 2) * BOB_AMP * 0.5;
        }
      } else {
        if (c.deflate >= 0 && c.deflate < 1) this._deflateStep(c, dt);
        c.glow.intensity = 1.2 + 0.35 * Math.sin(c.bob * 3.0) + c.bump / BUMP_OPEN_SEC * 2.0;
      }
    }
    if (!this.choice) this._tickBump(dt, playerPos);
    if (this.choice && this.choice.vr) this._faceChoice();
  }

  // 着地したら風船がしぼむ（前半: 横にたわむ／後半: つぶれて箱に寄る）
  _deflateStep(c, dt) {
    c.deflate = Math.min(1, c.deflate + dt / DEFLATE_SEC);
    const t = c.deflate * c.deflate * c.deflate; // ease in
    const lerp = (a, b, u) => a + (b - a) * u;
    if (t < 0.4) {
      const u = t / 0.4;
      c.balloon.scale.set(lerp(1, 1.25, u), lerp(1.12, 0.4, u), lerp(1, 1.25, u));
      c.balloon.position.y = lerp(BALLOON_Y, 0.85, u);
    } else {
      const u = (t - 0.4) / 0.6;
      c.balloon.scale.set(lerp(1.25, 0.05, u), lerp(0.4, 0.02, u), lerp(1.25, 0.05, u));
      c.balloon.position.y = lerp(0.85, LID_TOP_Y + 0.05, u);
    }
    c.string.scale.set(lerp(1, 0.2, c.deflate), lerp(1, 0.05, c.deflate), lerp(1, 0.2, c.deflate));
    c.string.position.y = lerp(STRING_Y, LID_TOP_Y, c.deflate);
    c.stringMat.opacity = 1 - Math.min(1, c.deflate / 0.9);
    if (c.deflate >= 1) { c.balloon.visible = false; c.string.visible = false; }
  }

  // 体当たり: BUMP_RADIUS 以内に BUMP_OPEN_SEC いると開く
  _tickBump(dt, pos) {
    for (const c of this.list) {
      const d = Math.hypot(c.g.position.x - pos.x, c.g.position.z - pos.z);
      const near = d <= BUMP_RADIUS && (!c.falling || Math.abs(c.g.position.y - pos.y) <= BUMP_AIR_Y);
      c.bump = near ? c.bump + dt : Math.max(0, c.bump - dt);
      if (c.bump >= BUMP_OPEN_SEC) { this._open(c); return; }
    }
  }

  tryOpenNear(pos, range) {
    if (this.choice) return false;
    for (const c of this.list) {
      const d = Math.hypot(c.g.position.x - pos.x, c.g.position.z - pos.z);
      if (d <= range && Math.abs(c.g.position.y - pos.y) < BUMP_AIR_Y) { this._open(c); return true; }
    }
    return false;
  }

  _open(c) {
    if (this.o.onOpen) this.o.onOpen();
    this.scene.remove(c.g);
    this.list.splice(this.list.indexOf(c), 1);
    const pool = this.o.items.filter((it) => it.card);
    const cards = pool.sort(() => Math.random() - 0.5).slice(0, 3);
    const pick = (item) => {
      this._closeChoice();
      this.o.onPick(item.kind, STOCK_ADD);
    };
    if (this.o.isXr()) this._showVrChoice(cards, pick);
    else { this.choice = { vr: false, cards, pick }; this.o.showChoice(cards, (item) => pick(item)); }
  }

  _texture(url) {
    if (!this.tex[url]) {
      const t = this.texLoader.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      this.tex[url] = t;
    }
    return this.tex[url];
  }

  // VR では目の前に 3 枚のカードを出し、指して引き金でえらぶ
  _showVrChoice(cards, pick) {
    const group = new THREE.Group();
    const entries = cards.map((item, i) => {
      const card = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.48), new THREE.MeshBasicMaterial({ color: 0xf6efe0 }));
      const art = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.28), new THREE.MeshBasicMaterial({ map: this._texture(item.art) }));
      art.position.set(0, 0.06, 0.002);
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.08), new THREE.MeshBasicMaterial({ map: textTexture(`${item.label}+10`), transparent: true }));
      label.position.set(0, -0.16, 0.002);
      card.add(plate, art, label);
      card.position.set((i - 1) * 0.4, 0, 0);
      group.add(card);
      return { mesh: plate, item, card };
    });
    this.scene.add(group);
    this.choice = { vr: true, group, entries, pick };
    this._faceChoice(true);
  }

  _faceChoice(force = false) {
    const cam = this.o.camera;
    const head = new THREE.Vector3();
    cam.getWorldPosition(head);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const g = this.choice.group;
    if (force) {
      g.position.copy(head).add(fwd.multiplyScalar(0.9));
      g.position.y = head.y - 0.15;
      g.lookAt(head.x, g.position.y, head.z);
    }
  }

  _closeChoice() {
    if (this.choice && this.choice.group) this.scene.remove(this.choice.group);
    this.choice = null;
  }

  // レイでカードや宝箱を選ぶ。使ったら true
  handleRay(origin, dir) {
    const rc = new THREE.Raycaster(origin, dir.clone().normalize(), 0, 40);
    if (this.choice && this.choice.vr) {
      const hit = rc.intersectObjects(this.choice.entries.map((e) => e.mesh), false)[0];
      if (hit) {
        const e = this.choice.entries.find((x) => x.mesh === hit.object);
        this.choice.pick(e.item);
        return true;
      }
      return false;
    }
    for (const c of this.list) {
      const hit = rc.intersectObject(c.g, true)[0];
      if (hit && hit.distance < 14) { this._open(c); return true; }
    }
    return false;
  }
}

function textTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#3a2a1a';
  g.font = 'bold 40px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
