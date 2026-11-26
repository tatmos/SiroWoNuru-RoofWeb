// プレイヤー（しろ）。数値はゲームの scripts/game/player_avatar_3d.gd と同じ
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';

export const SPEED = 7.0;
export const SPRINT_SPEED_MUL = 2.0;
export const MOVE_ACCEL = 14.0;
export const MOVE_REVERSE_ACCEL = 52.0;
export const RUN_SPEED_THRESHOLD = 5.0;
export const GRAVITY = 20.0;
export const JUMP_VELOCITY = 7.0;
export const RADIUS = 0.3;
export const STEP = 0.45;
export const BODY_H = 1.6;

export class PlayerView {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'Player';
    scene.add(this.root);
    this.mixer = null;
    this.actions = {};
    this.current = '';
    this.model = null;
  }

  async load(url) {
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
    });
    // 背の高さを 1.6m 前後にそろえる（ゲームと同じ大きさならそのまま）
    const box = new THREE.Box3().setFromObject(model);
    const h = box.max.y - box.min.y;
    if (h > 0.01 && (h < 1.0 || h > 2.6)) model.scale.multiplyScalar(1.6 / h);
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y -= box2.min.y;
    this.root.add(model);
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const name = clip.name.toLowerCase();
      const key = ['walk', 'idle', 'run', 'jump'].find((k) => name.endsWith(k) || name.includes('_' + k));
      if (key && !this.actions[key]) this.actions[key] = this.mixer.clipAction(clip);
    }
    this.play('idle');
  }

  play(name, fade = 0.2) {
    if (this.current === name || !this.actions[name]) return;
    const next = this.actions[name];
    const prev = this.actions[this.current];
    next.reset().play();
    if (prev) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  update(dt, pos, facing, speed, onGround) {
    this.root.position.copy(pos);
    this.root.rotation.y = facing;
    if (!onGround) this.play('jump', 0.15);
    else if (speed > RUN_SPEED_THRESHOLD) this.play('run');
    else if (speed > 0.4) this.play('walk');
    else this.play('idle');
    if (this.mixer) this.mixer.update(dt);
  }
}
