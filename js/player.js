// プレイヤー（しろ）。数値はゲームの scripts/game/player_avatar_3d.gd と同じ
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { ProceduralGait } from './gait.js';

export const SPEED = 7.0;
export const SPRINT_SPEED_MUL = 2.0;
export const MOVE_ACCEL = 14.0;
export const MOVE_REVERSE_ACCEL = 52.0;
export const MOVE_DECEL = 20.0;
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
      const key = ['walk', 'idle', 'run', 'jump', 'hanging'].find((k) => name.endsWith(k) || name.includes('_' + k));
      if (key && !this.actions[key]) this.actions[key] = this.mixer.clipAction(clip);
    }
    this.play('idle');
    if (this.floorAt) this.gait = new ProceduralGait(model, this.floorAt);
  }

  play(name, fade = 0.2) {
    if (this.current === name || !this.actions[name]) return;
    const next = this.actions[name];
    const prev = this.actions[this.current];
    next.reset().play();
    if (prev) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  // facing: 体の向き（PC・スマホはカメラの向き。ゲームと同じく横歩きでも体は回さない）。
  // 地上では待機クリップを土台に、手続きの歩き（gait.js。ゲームの procedural_gait.gd）で脚・腰・腕を動かす
  update(dt, pos, facing, vel, onGround, climb = null) {
    this.root.position.copy(pos);
    this.root.rotation.y = facing;
    const gait = this.gait;
    if (gait) gait.restore();
    if (climb && this.actions.hanging) {
      // よじ登り: ぶら下がりのアニメ。動いている速さで回し、下りは逆回し
      this.play('hanging', 0.15);
      const m = Math.max(Math.abs(climb.upAxis), Math.abs(climb.sideAxis));
      const a = this.actions.hanging;
      a.timeScale = m < 0.12 ? 0.15 : (climb.upAxis < -0.12 ? -1 : 1) * Math.min(1.35, Math.max(0.7, m));
    } else if (!onGround) {
      this.play('jump', 0.15);
    } else if (gait && gait.ok) {
      this.play('idle', 0.15);
    } else {
      // 骨が見つからないモデルはクリップで歩く
      const speed = Math.hypot(vel.x, vel.z);
      this.play(speed > RUN_SPEED_THRESHOLD ? 'run' : (speed > 0.4 ? 'walk' : 'idle'));
    }
    if (this.mixer) this.mixer.update(dt);
    if (gait) {
      gait.gaitOn = !climb && onGround;
      gait.measure(dt, pos);
      gait.apply(dt, pos, facing);
    }
  }
}
