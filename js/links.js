// 屋上の北の端に立てる看板（Steam・Discord・YouTube へのリンク）
import * as THREE from 'three';
import { ROOF_Y, HALL_HALF_Z } from './roof.js';

export const LINKS = [
  { label: 'Steam', sub: 'ストアページ・ウィッシュリスト', url: 'https://store.steampowered.com/app/5254900/', color: '#1b2838', accent: '#66c0f4' },
  { label: 'Discord', sub: 'コミュニティに参加', url: 'https://discord.gg/5tVwyskeCd', color: '#5865f2', accent: '#ffffff' },
  { label: 'YouTube', sub: '動画を見る', url: 'https://www.youtube.com/@%E3%81%97%E3%82%8D%E3%82%92%E5%A1%97%E3%82%8BCastlePaint', color: '#ff0033', accent: '#ffffff' },
];

export class LinkBoards {
  constructor(scene, o) {
    this.o = o;
    this.boards = [];
    const z = -HALL_HALF_Z + 0.6;
    LINKS.forEach((l, i) => {
      const g = new THREE.Group();
      const tex = boardTexture(l);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshBasicMaterial({ map: tex }));
      face.position.y = 1.55;
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.55, 1.35, 0.08), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.8 }));
      back.position.set(0, 1.55, -0.05);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
      post.position.y = 0.5;
      g.add(face, back, post);
      g.position.set((i - 1) * 3.2 - 4.0, ROOF_Y, z);
      back.castShadow = post.castShadow = true;
      scene.add(g);
      this.boards.push({ g, face, link: l, hover: false });
    });
    this._rc = new THREE.Raycaster();
  }

  _hit(origin, dir) {
    this._rc.set(origin, dir.clone().normalize());
    this._rc.far = 30;
    const hit = this._rc.intersectObjects(this.boards.map((b) => b.face), false)[0];
    return hit ? this.boards.find((b) => b.face === hit.object) : null;
  }

  update(origin, dir) {
    const b = this._hit(origin, dir);
    for (const x of this.boards) {
      const on = x === b;
      if (on !== x.hover) { x.hover = on; x.g.scale.setScalar(on ? 1.05 : 1); }
    }
    document.body.classList.toggle('over-link', !!b);
  }

  handleRay(origin, dir) {
    const b = this._hit(origin, dir);
    if (!b) return false;
    this.o.onOpen(b.link.url, b.link.label);
    return true;
  }
}

function boardTexture(l) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = l.color;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = l.accent;
  g.font = 'bold 92px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(l.label, 256, 104);
  g.font = '30px system-ui, sans-serif';
  g.fillText(l.sub, 256, 186);
  g.font = '24px system-ui, sans-serif';
  g.globalAlpha = 0.75;
  g.fillText('しろを塗る Castle Paint ↗', 256, 232);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
