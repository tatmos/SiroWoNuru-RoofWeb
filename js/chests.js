// 空から降る宝箱。開けると建築の補給カード（レンガ・ガラス・暖簾・大理石）を 3 枚から 1 枚えらぶ
import * as THREE from 'three';

const CHEST_INTERVAL_SEC = 60.0;
const FIRST_CHEST_SEC = 8.0;
const CHEST_SPAWN_HEIGHT = 22.0;
const OPEN_RANGE = 1.6;
const MAX_CHESTS = 3;
const STOCK_ADD = 10;

export class Chests {
  constructor(scene, o) {
    this.scene = scene;
    this.o = o;
    this.list = [];
    this.timer = CHEST_INTERVAL_SEC - FIRST_CHEST_SEC;
    this.choice = null; // {group, cards: [{mesh, item}]}
    this.lidMat = new THREE.MeshStandardMaterial({ color: 0xc8892e, roughness: 0.6, metalness: 0.2 });
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 });
    this.bandMat = new THREE.MeshStandardMaterial({ color: 0xe8c35a, roughness: 0.35, metalness: 0.7, emissive: 0x403010 });
    this.texLoader = new THREE.TextureLoader();
    this.tex = {};
  }

  _makeChest() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.6), this.bodyMat);
    body.position.y = 0.25;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12, 1, false, 0, Math.PI), this.lidMat);
    lid.rotation.z = Math.PI / 2;
    lid.position.y = 0.5;
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.82, 0.64), this.bandMat);
    band.position.y = 0.4;
    for (const m of [body, lid, band]) { m.castShadow = true; g.add(m); }
    const glow = new THREE.PointLight(0xffd27a, 2.5, 5);
    glow.position.y = 0.9;
    g.add(glow);
    this.scene.add(g);
    return g;
  }

  spawnNear(center) {
    if (this.list.length >= MAX_CHESTS) return;
    const at = this.o.roofPointNear(center);
    const g = this._makeChest();
    g.position.set(at.x, at.y + CHEST_SPAWN_HEIGHT, at.z);
    this.list.push({ g, ground: at.y, vy: 0, landed: false, spin: Math.random() * 6 });
  }

  update(dt, playerPos) {
    this.timer += dt;
    if (this.timer >= CHEST_INTERVAL_SEC) {
      this.timer = 0;
      this.spawnNear(playerPos);
    }
    for (const c of this.list) {
      if (!c.landed) {
        c.vy -= 9.0 * dt;
        c.vy = Math.max(c.vy, -9.0);
        c.g.position.y += c.vy * dt;
        c.g.rotation.y += dt * 1.5;
        if (c.g.position.y <= c.ground) { c.g.position.y = c.ground; c.landed = true; }
      } else {
        c.spin += dt;
        c.g.children[1].position.y = 0.5 + Math.max(0, Math.sin(c.spin * 3)) * 0.03;
      }
    }
    if (!this.choice) this.tryOpenNear(playerPos, OPEN_RANGE);
    if (this.choice && this.choice.vr) this._faceChoice();
  }

  tryOpenNear(pos, range) {
    if (this.choice) return false;
    for (const c of this.list) {
      if (!c.landed) continue;
      const d = Math.hypot(c.g.position.x - pos.x, c.g.position.z - pos.z);
      if (d <= range && Math.abs(c.g.position.y - pos.y) < 1.6) { this._open(c); return true; }
    }
    return false;
  }

  _open(c) {
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
      if (hit && c.landed && hit.distance < 14) { this._open(c); return true; }
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
