// src/lib/game/physics.ts
//
// PHYSICS / RENDER AYRIMI: Bu dosya yalnızca konum, hız ve çarpışma matematiği
// içerir — hiçbir THREE.Camera, THREE.Scene veya THREE.Renderer referansı YOK.
// Eskiden bu mantık engine.ts içinde `updateMovement`/`collides` olarak
// kamera nesnesiyle iç içe geçmişti; artık `PlayerMovementController` saf bir
// pozisyon (THREE.Vector3) üzerinde çalışıyor, engine.ts her karede bu
// pozisyonu kameraya kopyalıyor (render, fiziğin bir SONUCUNU çiziyor, fiziğin
// kendisini yönetmiyor).
//
// Hazır bir fizik motoru (Cannon/Ammo/Rapier) KASITLI olarak kullanılmadı;
// mevcut AABB tabanlı çarpışma matematiği bire bir korunarak taşındı.

import * as THREE from 'three';

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PlayerMovementConfig {
  radius: number;
  height: number;
  speed: number;
  bounds: MapBounds;
}

export interface MovementInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  touchX: number;
  touchY: number;
}

export class PlayerMovementController {
  /** Oyuncunun dünya-uzayı pozisyonu (göz yüksekliği dahil). Render tarafı bunu kameraya kopyalar. */
  public readonly position = new THREE.Vector3();

  private readonly config: PlayerMovementConfig;
  private colliders: THREE.Box3[];

  private readonly _direction = new THREE.Vector3();
  private readonly _forward = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _move = new THREE.Vector3();
  private readonly _nextPos = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(config: PlayerMovementConfig, colliders: THREE.Box3[], initialPosition: THREE.Vector3) {
    this.config = config;
    this.colliders = colliders;
    this.position.copy(initialPosition);
  }

  /** Duvar/kutu listesi runtime'da güncellenirse (ör. harita yeniden yüklenirse) çağrılır. */
  setColliders(colliders: THREE.Box3[]) {
    this.colliders = colliders;
  }

  /**
   * @param dt saniye cinsinden delta time
   * @param yaw kameranın mevcut yaw açısı (hareket yönü buna göre hesaplanır)
   * @param input tuş/joystick durumu
   * @param speedMultiplier ör. nişan alırken 0.35 (scope yavaşlaması)
   */
  update(dt: number, yaw: number, input: MovementInput, speedMultiplier: number) {
    let dz = Number(input.forward) - Number(input.backward);
    let dx = Number(input.right) - Number(input.left);
    if (input.touchX !== 0 || input.touchY !== 0) {
      dx += input.touchX;
      dz += -input.touchY;
    }

    this._direction.set(dx, 0, dz);
    if (this._direction.lengthSq() === 0) return;
    this._direction.normalize();

    const speed = this.config.speed * speedMultiplier;

    this._forward.set(0, 0, -1).applyAxisAngle(this._up, yaw);
    this._right.set(1, 0, 0).applyAxisAngle(this._up, yaw);
    this._move.set(0, 0, 0)
      .addScaledVector(this._forward, this._direction.z * speed * dt)
      .addScaledVector(this._right, this._direction.x * speed * dt);

    // Eksen-eksen çözümleme (X ve Z ayrı test edilir) — böylece bir duvara paralel
    // kayarken (sliding) tek eksende bloklanma diğer ekseni durdurmaz.
    this._nextPos.copy(this.position);
    this._nextPos.x += this._move.x;
    if (!this.collides(this._nextPos)) this.position.x = this._nextPos.x;

    this._nextPos.copy(this.position);
    this._nextPos.z += this._move.z;
    if (!this.collides(this._nextPos)) this.position.z = this._nextPos.z;

    this.position.y = this.config.height;
  }

  collides(pos: THREE.Vector3): boolean {
    const r = this.config.radius;
    const b = this.config.bounds;
    if (pos.x - r < b.minX || pos.x + r > b.maxX || pos.z - r < b.minZ || pos.z + r > b.maxZ) {
      return true;
    }
    for (const box of this.colliders) {
      if (
        pos.x + r > box.min.x && pos.x - r < box.max.x &&
        pos.z + r > box.min.z && pos.z - r < box.max.z &&
        pos.y < box.max.y + 0.1
      ) {
        return true;
      }
    }
    return false;
  }
}
