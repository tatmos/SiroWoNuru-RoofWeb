// プレイヤー（しろ）。数値はゲームの scripts/game/player_avatar_3d.gd と同じ
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';

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
  }

  play(name, fade = 0.2) {
    if (this.current === name || !this.actions[name]) return;
    const next = this.actions[name];
    const prev = this.actions[this.current];
    next.reset().play();
    if (prev) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  // facing: 体の向き（カメラの向き）。vel: 水平の速度。
  // 横歩きのアニメが無いので、横へ動くときは見た目の体を進む向きへ回す。後ろへ動くときは前を向いたまま歩きを逆回し
  update(dt, pos, facing, vel, onGround, climb = null) {
    this.root.position.copy(pos);
    const speed = Math.hypot(vel.x, vel.z);
    let back = false;
    let visual = facing;
    if (!climb && speed > 0.4) {
      const moveYaw = Math.atan2(vel.x, vel.z);
      let d = Math.atan2(Math.sin(moveYaw - facing), Math.cos(moveYaw - facing));
      if (Math.abs(d) > Math.PI * 0.62) {
        // 後ろ向きに近い: 逆の向きを向いて逆回し（斜め後ろも同じ）
        back = true;
        d = Math.atan2(Math.sin(d + Math.PI), Math.cos(d + Math.PI));
      }
      visual = facing + d;
    }
    if (climb) this._visualYaw = facing;
    if (this._visualYaw === undefined) this._visualYaw = visual;
    const dv = Math.atan2(Math.sin(visual - this._visualYaw), Math.cos(visual - this._visualYaw));
    this._visualYaw += dv * Math.min(1, dt * 14.0); // ゲームの向きの追いつき（delta * 14）
    this.root.rotation.y = this._visualYaw;
    if (climb && this.actions.hanging) {
      // よじ登り: ぶら下がりのアニメ。動いている速さで回し、下りは逆回し
      this.play('hanging', 0.15);
      const m = Math.max(Math.abs(climb.upAxis), Math.abs(climb.sideAxis));
      const a = this.actions.hanging;
      a.timeScale = m < 0.12 ? 0.15 : (climb.upAxis < -0.12 ? -1 : 1) * Math.min(1.35, Math.max(0.7, m));
      if (this.mixer) this.mixer.update(dt);
      return;
    }
    if (!onGround) this.play('jump', 0.15);
    else if (speed > RUN_SPEED_THRESHOLD && !back) this.play('run');
    else if (speed > 0.4) this.play('walk');
    else this.play('idle');
    const a = this.actions[this.current];
    if (a && (this.current === 'walk' || this.current === 'run')) {
      // 足の運びを速さに合わせる（歩き 0.6〜1.1 倍、走り 0.8〜1.12 倍）
      const pace = this.current === 'walk' ? Math.min(1.1, Math.max(0.6, speed / 3.5)) : Math.min(1.12, Math.max(0.8, speed / 9));
      a.timeScale = back ? -pace : pace;
    } else if (a) a.timeScale = 1;
    if (this.mixer) this.mixer.update(dt);
  }
}
