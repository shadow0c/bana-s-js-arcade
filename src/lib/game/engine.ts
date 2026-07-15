import {
  Engine,
  Scene,
  FreeCamera,
  HemisphericLight,
  DirectionalLight,
  Vector3,
  Color3,
  Color4,
  MeshBuilder,
  StandardMaterial,
  Mesh,
  Ray,
  Quaternion,
} from '@babylonjs/core';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import HavokPhysics from '@babylonjs/havok';
import type { PhysicsBody } from '@babylonjs/core';
import {
  WEAPONS,
  DEFAULT_WEAPON,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  JUMP_FORCE,
  GRAVITY,
  MOUSE_SENSITIVITY,
  MAP_WALLS,
  MAP_BOUNDS,
  COLORS,
  MAX_HEALTH,
  RESPAWN_TIME,
  BOMBSITES,
  SPAWN_POINTS,
} from './constants';
import type { PlayerState, RemotePlayer, Team, Vector3Like } from './types';
import { gameAudio } from './audio';
import { createCharacterModel, setWeaponPose, type CharacterParts } from './characterModel';

export interface GameEngineCallbacks {
  onShoot: (event: { origin: Vector3Like; direction: Vector3Like; weaponId: string }) => void;
  onHit: (targetId: string, damage: number) => void;
  onDeath: (killerId: string, victimId: string, weaponId: string) => void;
  onStateChange: (state: PlayerState) => void;
  onFlash?: (duration: number) => void;
}

interface Grenade {
  mesh: Mesh;
  type: 'flash' | 'he';
  detonateAt: number;
  velocity: Vector3;
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private camera: FreeCamera;
  private havokPlugin: HavokPlugin | null = null;

  private playerId: string;
  private playerName: string;
  private team: Team;
  private callbacks: GameEngineCallbacks;

  private state: PlayerState;
  private moveForward = false;
  private moveBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private isShooting = false;
  private lastShotTime = 0;
  private reloadEndTime = 0;
  private isReloading = false;
  private isScoped = false;
  private mouseLocked = false;
  private isOnGround = true;
  private verticalVelocity = 0;

  private touchMove = { x: 0, y: 0 };
  private mobileFire = false;
  private mobileAim = false;

  private yaw = 0;
  private pitch = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private consecutiveShots = 0;
  private lastFireGap = 0;

  private remotePlayers = new Map<string, RemotePlayer>();
  private remoteParts = new Map<string, CharacterParts>();
  private colliders: { min: Vector3; max: Vector3 }[] = [];
  private wallMeshes: Mesh[] = [];
  private bulletHoles: Mesh[] = [];
  private grenades: Grenade[] = [];
  private tracers: Mesh[] = [];

  private isMobile = false;
  private lastBroadcastTime = 0;
  private readonly BROADCAST_INTERVAL = 50;

  private isRunning = false;

  constructor(
    canvas: HTMLCanvasElement,
    playerId: string,
    playerName: string,
    team: Team,
    callbacks: GameEngineCallbacks,
  ) {
    this.canvas = canvas;
    this.playerId = playerId;
    this.playerName = playerName;
    this.team = team;
    this.callbacks = callbacks;
    this.state = this.createInitialState();

    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new Scene(this.engine);
    this.isMobile = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

    this.camera = new FreeCamera('player_cam', new Vector3(0, PLAYER_HEIGHT, 0), this.scene);
    this.camera.minZ = 0.05;
    this.camera.maxZ = 500;
    this.camera.fov = 1.0472;
    this.camera.rotationQuaternion = Quaternion.Identity();

    void this.setupScene();
    this.setupControls();
    this.equipWeapon(DEFAULT_WEAPON);
  }

  private createInitialState(): PlayerState {
    return {
      id: this.playerId,
      name: this.playerName,
      team: this.team,
      position: this.getSpawnPoint(),
      rotation: { x: 0, y: 0 },
      health: MAX_HEALTH,
      weaponId: DEFAULT_WEAPON,
      ammo: WEAPONS[DEFAULT_WEAPON].clipSize,
      maxAmmo: WEAPONS[DEFAULT_WEAPON].clipSize,
      money: 800,
      kills: 0,
      deaths: 0,
      isDead: false,
      isReloading: false,
      isScoped: false,
    };
  }

  private getSpawnPoint(): Vector3Like {
    const points = SPAWN_POINTS[this.team];
    const base = points[Math.floor(Math.random() * points.length)];
    return {
      x: base.x + (Math.random() - 0.5) * 4,
      y: PLAYER_HEIGHT,
      z: base.z + (Math.random() - 0.5) * 4,
    };
  }

  private async setupScene() {
    this.scene.clearColor = new Color4(
      ((COLORS.sky >> 16) & 0xff) / 255,
      ((COLORS.sky >> 8) & 0xff) / 255,
      (COLORS.sky & 0xff) / 255,
      1,
    );
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = new Color3(
      ((COLORS.sky >> 16) & 0xff) / 255,
      ((COLORS.sky >> 8) & 0xff) / 255,
      (COLORS.sky & 0xff) / 255,
    );
    this.scene.fogStart = 40;
    this.scene.fogEnd = 160;

    try {
      const havok = await HavokPhysics();
      this.havokPlugin = new HavokPlugin(true, havok);
      this.scene.enablePhysics(new Vector3(0, GRAVITY, 0), this.havokPlugin);
    } catch (e) {
      console.warn('Havok init failed, using manual physics', e);
    }

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.5, 0.4, 0.3);

    const dirLight = new DirectionalLight('dir', new Vector3(-0.5, -1, -0.3), this.scene);
    dirLight.intensity = 1.0;
    dirLight.diffuse = new Color3(1, 0.95, 0.8);

    const floorMat = new StandardMaterial('floor_mat', this.scene);
    floorMat.diffuseColor = Color3.FromInts(
      (COLORS.floor >> 16) & 0xff,
      (COLORS.floor >> 8) & 0xff,
      COLORS.floor & 0xff,
    );
    const floor = MeshBuilder.CreateGround('floor', { width: 122, height: 122 }, this.scene);
    floor.material = floorMat;
    floor.metadata = { isWall: true };
    this.wallMeshes.push(floor);

    for (const box of MAP_WALLS) {
      const isCrate = box.w <= 6 && box.d <= 6 && box.h <= 2.5;
      const mat = new StandardMaterial(`wall_${box.x}_${box.z}`, this.scene);
      const color = isCrate ? COLORS.crate : COLORS.wall;
      mat.diffuseColor = Color3.FromInts((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
      if (!isCrate) mat.diffuseColor = mat.diffuseColor.scale(0.85);

      const mesh = MeshBuilder.CreateBox(`wall_${box.x}_${box.z}`, {
        width: box.w, height: box.h, depth: box.d,
      }, this.scene);
      mesh.material = mat;
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.metadata = { isWall: true };
      this.wallMeshes.push(mesh);

      this.colliders.push({
        min: new Vector3(box.x - box.w / 2, 0, box.z - box.d / 2),
        max: new Vector3(box.x + box.w / 2, box.h, box.z + box.d / 2),
      });
    }

    for (const site of BOMBSITES) {
      const ring = MeshBuilder.CreateTorus(`site_${site.label}`, {
        diameter: 7, thickness: 0.5, tessellation: 32,
      }, this.scene);
      ring.position.set(site.x, 0.02, site.z);
      ring.rotation.x = Math.PI / 2;
      const ringMat = new StandardMaterial(`site_mat_${site.label}`, this.scene);
      ringMat.emissiveColor = Color3.FromInts(
        (site.color >> 16) & 0xff, (site.color >> 8) & 0xff, site.color & 0xff,
      );
      ringMat.alpha = 0.6;
      ring.material = ringMat;
    }

    const spawn = this.state.position;
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = Math.atan2(-spawn.x, -spawn.z);
    this.updateCameraRotation();
  }

  private updateCameraRotation() {
    this.camera.rotationQuaternion = Quaternion.FromEulerAngles(this.pitch, this.yaw, 0);
  }

  private setupControls() {
    this.scene.onPointerObservable.add((pi) => {
      if (pi.type === 1) { // POINTERDOWN
        const evt = pi.event as MouseEvent;
        if (evt.button === 0) { this.isShooting = true; this.tryShoot(); }
        else if (evt.button === 2) { this.toggleScope(true); }
      } else if (pi.type === 2) { // POINTERUP
        const evt = pi.event as MouseEvent;
        if (evt.button === 0) { this.isShooting = false; }
        else if (evt.button === 2) { this.toggleScope(false); }
      }
    });

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('resize', this.onResize);

    this.canvas.addEventListener('click', () => {
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch && !this.mouseLocked && !this.state.isDead) {
        this.canvas.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerLockChange = () => {
    this.mouseLocked = document.pointerLockElement === this.canvas;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.mouseLocked || this.state.isDead) return;
    this.yaw -= e.movementX * MOUSE_SENSITIVITY;
    this.pitch -= e.movementY * MOUSE_SENSITIVITY;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    this.updateCameraRotation();
    this.state.rotation = { x: this.pitch, y: this.yaw };
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.state.isDead) return;
    switch (e.code) {
      case 'KeyW': this.moveForward = true; break;
      case 'KeyA': this.moveLeft = true; break;
      case 'KeyS': this.moveBackward = true; break;
      case 'KeyD': this.moveRight = true; break;
      case 'Space':
        e.preventDefault();
        if (this.isOnGround) { this.verticalVelocity = JUMP_FORCE; this.isOnGround = false; }
        break;
      case 'KeyR': this.reload(); break;
      case 'Digit1': this.setWeapon('pistol'); break;
      case 'Digit2': this.setWeapon('rifle'); break;
      case 'Digit3': this.setWeapon('sniper'); break;
      case 'Digit4': this.setWeapon('knife'); break;
      case 'KeyF': this.throwGrenade('flash'); break;
      case 'KeyG': this.throwGrenade('he'); break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW': this.moveForward = false; break;
      case 'KeyA': this.moveLeft = false; break;
      case 'KeyS': this.moveBackward = false; break;
      case 'KeyD': this.moveRight = false; break;
    }
  };

  private onResize = () => { this.engine.resize(); };

  private toggleScope(v: boolean) {
    this.isScoped = v;
    if (!v) this.camera.fov = 1.0472;
  }

  // ============ MOBILE API ============
  public mobileLook(dx: number, dy: number) {
    if (this.state.isDead) return;
    this.yaw -= dx * MOUSE_SENSITIVITY * 2;
    this.pitch -= dy * MOUSE_SENSITIVITY * 2;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    this.updateCameraRotation();
    this.state.rotation = { x: this.pitch, y: this.yaw };
  }
  public mobileMove(x: number, y: number) { this.touchMove.x = x; this.touchMove.y = y; }
  public mobileSetFire(v: boolean) { this.mobileFire = v; this.isShooting = v; if (v) this.tryShoot(); }
  public mobileSetAim(v: boolean) { this.mobileAim = v; this.toggleScope(v); }
  public mobileReload() { this.reload(); }
  public mobileThrow(type: 'flash' | 'he') { this.throwGrenade(type); }
  public lockPointer() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch) this.canvas.requestPointerLock();
  }
  public unlockPointer() { document.exitPointerLock(); }
  public isLocked() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    return isTouch ? true : this.mouseLocked;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt = this.engine.getDeltaTime() / 1000;
      this.update(dt, now);
      this.scene.render();
    });
  }

  public stop() { this.isRunning = false; this.engine.stopRenderLoop(); }

  public cleanup() {
    this.stop();
    try { this.unlockPointer(); } catch { /* ignore */ }
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.engine.dispose();
  }

  private update(dt: number, now: number) {
    if (this.state.isDead) return;
    this.updateMovement(dt);
    this.updateShooting(now);
    this.updateReload(now);
    this.updateRecoilRecovery(dt, now);
    this.updateRemotePlayers(dt);
    this.updateGrenades(now);
    this.broadcastStateIfNeeded(now);
  }

  private updateRecoilRecovery(dt: number, now: number) {
    if (this.isShooting) return;
    if (now - this.lastShotTime < 60) return;
    const recover = Math.min(1, dt * 8);
    const dp = this.recoilPitch * recover;
    const dy = this.recoilYaw * recover;
    this.pitch -= dp; this.recoilPitch -= dp;
    this.yaw -= dy; this.recoilYaw -= dy;
    this.updateCameraRotation();
    if (Math.abs(this.recoilPitch) < 0.001) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 0.001) this.recoilYaw = 0;
    if (!this.isShooting && this.consecutiveShots > 0 && now - this.lastShotTime > 300) this.consecutiveShots = 0;
  }

  private updateMovement(dt: number) {
    let dz = Number(this.moveForward) - Number(this.moveBackward);
    let dx = Number(this.moveRight) - Number(this.moveLeft);
    if (this.touchMove.x !== 0 || this.touchMove.y !== 0) {
      dx += this.touchMove.x;
      dz += -this.touchMove.y;
    }

    const forward = this.camera.getDirection(Vector3.Forward());
    forward.y = 0; forward.normalize();
    const right = this.camera.getDirection(Vector3.Right());
    right.y = 0; right.normalize();

    const speed = this.isScoped ? PLAYER_SPEED * 0.35 : PLAYER_SPEED;
    const moveVec = new Vector3(0, 0, 0);
    if (dz !== 0 || dx !== 0) {
      const len = Math.hypot(dx, dz);
      dx /= len; dz /= len;
      moveVec.addInPlace(forward.scale(dz * speed * dt));
      moveVec.addInPlace(right.scale(dx * speed * dt));
    }

    this.verticalVelocity += GRAVITY * dt;
    moveVec.y = this.verticalVelocity * dt;

    const nextPos = this.camera.position.add(moveVec);
    const checkPos = new Vector3(nextPos.x, this.camera.position.y, nextPos.z);
    if (!this.collides(checkPos)) {
      this.camera.position.x = nextPos.x;
      this.camera.position.z = nextPos.z;
    }

    this.camera.position.y += moveVec.y;

    const groundY = this.getGroundHeight(this.camera.position);
    if (this.camera.position.y <= groundY + PLAYER_HEIGHT) {
      this.camera.position.y = groundY + PLAYER_HEIGHT;
      this.verticalVelocity = 0;
      this.isOnGround = true;
    } else {
      this.isOnGround = false;
    }

    const r = PLAYER_RADIUS;
    this.camera.position.x = Math.max(MAP_BOUNDS.minX + r, Math.min(MAP_BOUNDS.maxX - r, this.camera.position.x));
    this.camera.position.z = Math.max(MAP_BOUNDS.minZ + r, Math.min(MAP_BOUNDS.maxZ - r, this.camera.position.z));
  }

  private collides(pos: Vector3): boolean {
    const r = PLAYER_RADIUS;
    for (const box of this.colliders) {
      if (
        pos.x + r > box.min.x && pos.x - r < box.max.x &&
        pos.z + r > box.min.z && pos.z - r < box.max.z &&
        pos.y - PLAYER_HEIGHT < box.max.y
      ) {
        if (pos.y - PLAYER_HEIGHT >= box.max.y - 0.3) continue;
        return true;
      }
    }
    return false;
  }

  private getGroundHeight(pos: Vector3): number {
    let groundY = 0;
    const r = PLAYER_RADIUS * 0.8;
    for (const box of this.colliders) {
      if (
        pos.x + r > box.min.x && pos.x - r < box.max.x &&
        pos.z + r > box.min.z && pos.z - r < box.max.z
      ) {
        if (box.max.y > groundY && box.max.y <= pos.y - PLAYER_HEIGHT + 0.5) {
          groundY = box.max.y;
        }
      }
    }
    return groundY;
  }

  private updateShooting(now: number) {
    if (this.isShooting) this.tryShoot(now);
  }

  private tryShoot(now = performance.now()) {
    if (this.state.isDead || this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (weapon.grenade) return;
    if (now - this.lastShotTime < weapon.fireRate) return;
    if (this.state.ammo <= 0) { this.reload(); return; }

    this.lastFireGap = now - this.lastShotTime;
    this.lastShotTime = now;
    this.state.ammo--;
    gameAudio.shoot(weapon.id);

    if (this.lastFireGap < weapon.fireRate * 3) this.consecutiveShots++;
    else this.consecutiveShots = 1;
    const buildUp = 1 + Math.min(4, this.consecutiveShots * 0.35);
    const scopeMul = this.isScoped ? 0.5 : 1;

    const vert = weapon.recoil * buildUp * scopeMul;
    const horiz = weapon.recoil * 0.4 * (Math.random() - 0.5) * buildUp * scopeMul;
    this.recoilPitch += vert;
    this.recoilYaw += horiz;
    this.pitch += vert;
    this.yaw += horiz;
    this.pitch = Math.min(Math.PI / 2 - 0.01, this.pitch);
    this.updateCameraRotation();

    const origin = this.camera.position.clone();
    const direction = this.camera.getDirection(Vector3.Forward());

    const ray = new Ray(origin, direction, weapon.range);
    const pickInfo = this.scene.pickWithRay(ray, (m) => {
      const meta = m.metadata;
      return meta?.isWall === true || (meta?.playerId !== undefined && meta.playerId !== this.playerId);
    });

    let hitPlayerId: string | undefined;
    let hitPoint = origin.add(direction.scale(weapon.range));

    if (pickInfo?.hit) {
      hitPoint = pickInfo.pickedPoint ?? hitPoint;
      const meta = pickInfo.pickedMesh?.metadata as { playerId?: string; isWall?: boolean } | undefined;
      if (meta?.playerId && meta.playerId !== this.playerId) {
        hitPlayerId = meta.playerId;
      } else if (meta?.isWall) {
        this.addBulletHole(hitPoint, pickInfo.getNormal(true) ?? Vector3.Up());
      }
    }

    if (hitPlayerId) this.callbacks.onHit(hitPlayerId, weapon.damage);

    this.callbacks.onShoot({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      weaponId: weapon.id,
    });
    this.spawnTracer(origin, hitPoint);
  }

  private addBulletHole(point: Vector3, normal: Vector3) {
    const hole = MeshBuilder.CreateDisc(`hole_${Date.now()}`, { radius: 0.08, tessellation: 16 }, this.scene);
    hole.position.copyFrom(point).addInPlace(normal.scale(0.01));
    hole.setDirection(normal);
    const mat = new StandardMaterial(`hole_mat_${Date.now()}`, this.scene);
    mat.diffuseColor = new Color3(0.07, 0.07, 0.07);
    mat.emissiveColor = new Color3(0.02, 0.02, 0.02);
    hole.material = mat;
    this.bulletHoles.push(hole);
    if (this.bulletHoles.length > 120) {
      const old = this.bulletHoles.shift();
      if (old) old.dispose();
    }
  }

  private spawnTracer(origin: Vector3, end: Vector3) {
    const distance = Vector3.Distance(origin, end);
    if (distance < 0.5) return;
    const tracer = MeshBuilder.CreateLines(`tracer_${Date.now()}`, { points: [origin, end] }, this.scene);
    tracer.color = Color3.FromInts(
      (COLORS.bullet >> 16) & 0xff, (COLORS.bullet >> 8) & 0xff, COLORS.bullet & 0xff,
    );
    this.tracers.push(tracer);
    setTimeout(() => {
      tracer.dispose();
      const idx = this.tracers.indexOf(tracer);
      if (idx > -1) this.tracers.splice(idx, 1);
    }, 80);
  }

  private throwGrenade(type: 'flash' | 'he') {
    const dir = this.camera.getDirection(Vector3.Forward());
    const mesh = MeshBuilder.CreateSphere(`grenade_${Date.now()}`, { diameter: 0.3, segments: 8 }, this.scene);
    mesh.position.copyFrom(this.camera.position).addInPlace(dir.scale(0.6));
    const mat = new StandardMaterial(`grenade_mat_${Date.now()}`, this.scene);
    mat.diffuseColor = type === 'flash' ? new Color3(0.8, 0.8, 0.8) : new Color3(0.16, 0.35, 0.16);
    mesh.material = mat;

    const velocity = dir.scale(18);
    velocity.y += 4;
    this.grenades.push({ mesh, type, detonateAt: performance.now() + 1800, velocity });
  }

  private updateGrenades(now: number) {
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.velocity.y += GRAVITY * dt;
      const prev = g.mesh.position.clone();
      g.mesh.position.addInPlace(g.velocity.scale(dt));

      if (g.mesh.position.y < 0.15) {
        g.mesh.position.y = 0.15;
        g.velocity.y *= -0.4;
        g.velocity.x *= 0.75;
        g.velocity.z *= 0.75;
      }

      const r = 0.15;
      if (g.mesh.position.x - r < MAP_BOUNDS.minX) { g.mesh.position.x = MAP_BOUNDS.minX + r; g.velocity.x *= -0.5; }
      if (g.mesh.position.x + r > MAP_BOUNDS.maxX) { g.mesh.position.x = MAP_BOUNDS.maxX - r; g.velocity.x *= -0.5; }
      if (g.mesh.position.z - r < MAP_BOUNDS.minZ) { g.mesh.position.z = MAP_BOUNDS.minZ + r; g.velocity.z *= -0.5; }
      if (g.mesh.position.z + r > MAP_BOUNDS.maxZ) { g.mesh.position.z = MAP_BOUNDS.maxZ - r; g.velocity.z *= -0.5; }

      for (const box of this.colliders) {
        if (
          g.mesh.position.x + r > box.min.x && g.mesh.position.x - r < box.max.x &&
          g.mesh.position.y + r > box.min.y && g.mesh.position.y - r < box.max.y &&
          g.mesh.position.z + r > box.min.z && g.mesh.position.z - r < box.max.z
        ) {
          const enteredX = prev.x + r <= box.min.x || prev.x - r >= box.max.x;
          const enteredZ = prev.z + r <= box.min.z || prev.z - r >= box.max.z;
          if (enteredX) { g.mesh.position.x = prev.x; g.velocity.x *= -0.5; }
          else if (enteredZ) { g.mesh.position.z = prev.z; g.velocity.z *= -0.5; }
          else { g.mesh.position.copyFrom(prev); g.velocity.multiplyInPlace(new Vector3(-0.5, -0.4, -0.5)); }
        }
      }

      if (now >= g.detonateAt) {
        this.detonateGrenade(g);
        g.mesh.dispose();
        this.grenades.splice(i, 1);
      }
    }
  }

  private detonateGrenade(g: Grenade) {
    if (g.type === 'flash') {
      gameAudio.flashBang();
      const dist = Vector3.Distance(g.mesh.position, this.camera.position);
      if (dist < 15) {
        const duration = Math.max(500, 2500 - dist * 120);
        this.callbacks.onFlash?.(duration);
      }
    } else {
      gameAudio.explosion();
      const dist = Vector3.Distance(g.mesh.position, this.camera.position);
      if (dist < 6) this.takeDamage(Math.round(80 * (1 - dist / 6)), this.playerId);
      const puff = MeshBuilder.CreateSphere(`puff_${Date.now()}`, { diameter: 3, segments: 12 }, this.scene);
      puff.position.copyFrom(g.mesh.position);
      const mat = new StandardMaterial(`puff_mat_${Date.now()}`, this.scene);
      mat.diffuseColor = new Color3(1, 0.6, 0.27);
      mat.alpha = 0.7;
      puff.material = mat;
      setTimeout(() => puff.dispose(), 250);
    }
  }

  private reload() {
    if (this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (!weapon || weapon.reloadTime === 0 || this.state.ammo >= weapon.clipSize) return;
    this.isReloading = true;
    this.reloadEndTime = performance.now() + weapon.reloadTime;
    gameAudio.reload();
  }

  private updateReload(now: number) {
    if (this.isReloading && now >= this.reloadEndTime) {
      this.isReloading = false;
      this.state.ammo = WEAPONS[this.state.weaponId].clipSize;
    }
  }

  private equipWeapon(id: string) {
    const def = WEAPONS[id];
    if (!def) return;
    this.state.weaponId = id;
    this.state.ammo = def.clipSize;
    this.state.maxAmmo = def.clipSize;
    this.isReloading = false;
  }

  public setWeapon(id: string) {
    if (!WEAPONS[id] || this.state.weaponId === id) return;
    this.equipWeapon(id);
  }

  public takeDamage(amount: number, sourceId: string) {
    if (this.state.isDead) return;
    this.state.health = Math.max(0, this.state.health - amount);
    gameAudio.hit();
    if (this.state.health <= 0) this.die(sourceId);
  }

  private die(killerId: string) {
    this.state.isDead = true;
    this.state.deaths++;
    try { this.unlockPointer(); } catch { /* ignore */ }
    this.callbacks.onDeath(killerId, this.playerId, this.state.weaponId);
    setTimeout(() => this.respawn(), RESPAWN_TIME);
  }

  public respawn() {
    const spawn = this.getSpawnPoint();
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = Math.atan2(-spawn.x, -spawn.z);
    this.pitch = 0;
    this.updateCameraRotation();
    this.isScoped = false;
    this.camera.fov = 1.0472;
    this.verticalVelocity = 0;
    this.isOnGround = true;
    this.state.position = spawn;
    this.state.health = MAX_HEALTH;
    this.state.isDead = false;
    this.equipWeapon('pistol');
  }

  public getState(): PlayerState { return this.state; }
  public addMoney(amount: number) { this.state.money += amount; }
  public addKill() { this.state.kills++; }

  public buyWeapon(id: string): boolean {
    const weapon = WEAPONS[id];
    if (!weapon || this.state.money < weapon.cost || this.state.weaponId === id) return false;
    this.state.money -= weapon.cost;
    this.equipWeapon(id);
    return true;
  }

  public addRemotePlayer(state: PlayerState) {
    if (this.remotePlayers.has(state.id)) return;
    const parts = createCharacterModel(this.scene, state.team, state.id);
    setWeaponPose(parts, state.weaponId, this.scene);
    parts.root.position.set(state.position.x, 0, state.position.z);

    this.remoteParts.set(state.id, parts);
    this.remotePlayers.set(state.id, {
      id: state.id, name: state.name, team: state.team,
      root: parts.root, weaponGroup: parts.weaponGroup,
      targetPosition: { x: state.position.x, y: 0, z: state.position.z },
      targetRotation: { x: state.rotation.x, y: state.rotation.y },
      state,
    });
  }

  public updateRemotePlayer(state: PlayerState) {
    let rp = this.remotePlayers.get(state.id);
    if (!rp) { this.addRemotePlayer(state); rp = this.remotePlayers.get(state.id)!; }
    const parts = this.remoteParts.get(state.id);
    if (parts && parts.root.metadata?.weaponId !== state.weaponId) {
      setWeaponPose(parts, state.weaponId, this.scene);
      parts.root.metadata = { ...parts.root.metadata, weaponId: state.weaponId };
    }
    rp.state = state;
    rp.targetPosition = { x: state.position.x, y: 0, z: state.position.z };
    rp.targetRotation.x = state.rotation.x;
    rp.targetRotation.y = state.rotation.y;
  }

  public removeRemotePlayer(id: string) {
    const rp = this.remotePlayers.get(id);
    if (rp) {
      rp.root.dispose();
      this.remotePlayers.delete(id);
    }
    this.remoteParts.delete(id);
  }

  private updateRemotePlayers(dt: number) {
    const lerpFactor = 1 - Math.pow(0.001, dt);
    for (const rp of this.remotePlayers.values()) {
      const target = new Vector3(rp.targetPosition.x, rp.targetPosition.y, rp.targetPosition.z);
      rp.root.position = Vector3.Lerp(rp.root.position, target, lerpFactor);
      const targetYaw = -rp.targetRotation.y + Math.PI;
      rp.root.rotation.y = this.lerpAngle(rp.root.rotation.y, targetYaw, lerpFactor);
    }
  }

  private lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  private broadcastStateIfNeeded(now: number) {
    if (now - this.lastBroadcastTime > this.BROADCAST_INTERVAL) {
      this.state.position = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
      this.state.isReloading = this.isReloading;
      this.state.isScoped = this.isScoped;
      this.callbacks.onStateChange({ ...this.state });
      this.lastBroadcastTime = now;
    }
  }
}
