import * as THREE from 'three';
import {
  WEAPONS,
  DEFAULT_WEAPON,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  MOUSE_SENSITIVITY,
  MAP_WALLS,
  MAP_BOUNDS,
  COLORS,
  MAX_HEALTH,
  RESPAWN_TIME,
  TEXTURES,
} from './constants';
import type { PlayerState, RemotePlayer, Team, Vector3Like } from './types';
import { gameAudio } from './audio';

export interface GameEngineCallbacks {
  onShoot: (event: { origin: Vector3Like; direction: Vector3Like; weaponId: string }) => void;
  onHit: (targetId: string, damage: number) => void;
  onDeath: (killerId: string, victimId: string, weaponId: string) => void;
  onStateChange: (state: PlayerState) => void;
  onFlash?: (duration: number) => void;
}

interface Grenade {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  type: 'flash' | 'he';
  detonateAt: number;
}

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private raycaster: THREE.Raycaster;

  private playerId: string;
  private playerName: string;
  private team: Team;
  private callbacks: GameEngineCallbacks;

  private state: PlayerState;
  private direction = new THREE.Vector3();
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

  // Mobile touch state
  private touchMove = { x: 0, y: 0 };
  private mobileFire = false;
  private mobileAim = false;

  private yaw = 0;
  private pitch = 0;

  private weaponModel: THREE.Group | null = null;
  private remotePlayers = new Map<string, RemotePlayer>();
  private colliders: THREE.Box3[] = [];
  private wallMeshes: THREE.Mesh[] = [];
  private bulletHoles: THREE.Mesh[] = [];
  private grenades: Grenade[] = [];

  private lastBroadcastTime = 0;
  private readonly BROADCAST_INTERVAL = 50;

  private tracers: THREE.Line[] = [];

  private rafId: number | null = null;
  private lastTime = performance.now();
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

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.05, 500);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.raycaster = new THREE.Raycaster();

    this.setupScene();
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
    // T spawn = sol alt (B tarafı), CT spawn = sağ üst (A tarafı)
    const base = this.team === 't' ? { x: -45, z: -45 } : { x: 45, z: 45 };
    return {
      x: base.x + (Math.random() - 0.5) * 8,
      y: PLAYER_HEIGHT,
      z: base.z + (Math.random() - 0.5) * 8,
    };
  }

  private setupScene() {
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 40, 160);

    const hemiLight = new THREE.HemisphereLight(0xfff2d9, 0x554433, 0.7);
    this.scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffe4b5, 1.1);
    dirLight.position.set(40, 90, 30);
    this.scene.add(dirLight);

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    // Floor with texture
    const floorTex = loader.load(TEXTURES.floor);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(20, 20);
    const floorGeo = new THREE.PlaneGeometry(120, 120);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, color: COLORS.floor, roughness: 0.95 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.userData.isWall = true;
    this.scene.add(floor);
    this.wallMeshes.push(floor);

    // Walls with brick texture
    const wallTex = loader.load(TEXTURES.wall);
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    const crateTex = loader.load(TEXTURES.crate);

    for (const box of MAP_WALLS) {
      const geo = new THREE.BoxGeometry(box.w, box.h, box.d);
      const useCrate = box.w <= 6 && box.d <= 6 && box.h <= 2.5;
      const tex = useCrate ? crateTex : wallTex.clone();
      if (!useCrate) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(Math.max(1, box.w / 2), Math.max(1, box.h / 2));
        tex.needsUpdate = true;
      }
      const mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.85 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.userData.isWall = true;
      this.scene.add(mesh);
      this.wallMeshes.push(mesh);
      this.colliders.push(new THREE.Box3().setFromObject(mesh));
    }

    // Bombsite markers (A / B)
    const makeSite = (label: 'A' | 'B', x: number, z: number, color: number) => {
      const g = new THREE.RingGeometry(3, 3.5, 32);
      const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
      const ring = new THREE.Mesh(g, m);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.02, z);
      this.scene.add(ring);
      void label;
    };
    makeSite('A', 30, 35, 0xff4444);
    makeSite('B', -30, -35, 0x44ff44);

    const spawn = this.state.position;
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.camera.rotation.order = 'YXZ';
    // face map center
    this.yaw = Math.atan2(-spawn.x, -spawn.z);
    this.camera.rotation.y = this.yaw;
  }

  private setupControls() {
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('resize', this.onResize);

    this.canvas.addEventListener('click', () => {
      // Mobil cihazlarda pointer lock istemiyoruz
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch && !this.mouseLocked && !this.state.isDead) {
        this.canvas.requestPointerLock();
      }
    });
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onPointerLockChange = () => {
    this.mouseLocked = document.pointerLockElement === this.canvas;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.mouseLocked || this.state.isDead) return;
    this.yaw -= e.movementX * MOUSE_SENSITIVITY;
    this.pitch -= e.movementY * MOUSE_SENSITIVITY;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.state.rotation = { x: this.pitch, y: this.yaw };
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.state.isDead) return;
    switch (e.code) {
      case 'KeyW': this.moveForward = true; break;
      case 'KeyA': this.moveLeft = true; break;
      case 'KeyS': this.moveBackward = true; break;
      case 'KeyD': this.moveRight = true; break;
      case 'Space': e.preventDefault(); break;
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

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      this.isShooting = true;
      this.tryShoot();
    } else if (e.button === 2) {
      this.isScoped = true;
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.isShooting = false;
    } else if (e.button === 2) {
      this.isScoped = false;
      this.camera.fov = 75;
      this.camera.updateProjectionMatrix();
    }
  };

  private onResize = () => {
    this.camera.aspect = this.canvas.clientWidth / this.canvas.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
  };

  // ============ MOBILE PUBLIC API ============
  public mobileLook(dx: number, dy: number) {
    if (this.state.isDead) return;
    this.yaw -= dx * MOUSE_SENSITIVITY * 2;
    this.pitch -= dy * MOUSE_SENSITIVITY * 2;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.state.rotation = { x: this.pitch, y: this.yaw };
  }
  public mobileMove(x: number, y: number) {
    this.touchMove.x = x;
    this.touchMove.y = y;
  }
  public mobileSetFire(v: boolean) {
    this.mobileFire = v;
    this.isShooting = v;
    if (v) this.tryShoot();
  }
  public mobileSetAim(v: boolean) {
    this.mobileAim = v;
    this.isScoped = v;
    if (!v) {
      this.camera.fov = 75;
      this.camera.updateProjectionMatrix();
    }
  }
  public mobileReload() { this.reload(); }
  public mobileThrow(type: 'flash' | 'he') { this.throwGrenade(type); }

  public lockPointer() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch) this.canvas.requestPointerLock();
  }

  public unlockPointer() {
    document.exitPointerLock();
  }

  public isLocked() {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    return isTouch ? true : this.mouseLocked;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this.loop();
  }

  public stop() {
    this.isRunning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  public cleanup() {
    this.stop();
    try { this.unlockPointer(); } catch { /* ignore */ }
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.update(dt, now);
    this.renderer.render(this.scene, this.camera);
  };

  private update(dt: number, now: number) {
    if (this.state.isDead) return;
    this.updateMovement(dt);
    this.updateShooting(now);
    this.updateReload(now);
    this.updateWeaponModel(dt);
    this.updateRemotePlayers(dt);
    this.updateGrenades(dt, now);
    this.broadcastStateIfNeeded(now);
  }

  private updateMovement(dt: number) {
    let dz = Number(this.moveForward) - Number(this.moveBackward);
    let dx = Number(this.moveRight) - Number(this.moveLeft);
    // Touch joystick (y up = forward)
    if (this.touchMove.x !== 0 || this.touchMove.y !== 0) {
      dx += this.touchMove.x;
      dz += -this.touchMove.y;
    }
    this.direction.set(dx, 0, dz);
    if (this.direction.lengthSq() === 0) return;
    this.direction.normalize();

    const speed = this.isScoped ? PLAYER_SPEED * 0.35 : PLAYER_SPEED;
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    const move = new THREE.Vector3()
      .addScaledVector(forward, this.direction.z * speed * dt)
      .addScaledVector(right, this.direction.x * speed * dt);

    const nextPos = this.camera.position.clone();
    nextPos.x += move.x;
    if (!this.collides(nextPos)) this.camera.position.x = nextPos.x;
    nextPos.copy(this.camera.position);
    nextPos.z += move.z;
    if (!this.collides(nextPos)) this.camera.position.z = nextPos.z;
    this.camera.position.y = PLAYER_HEIGHT;
  }

  private collides(pos: THREE.Vector3): boolean {
    const r = PLAYER_RADIUS;
    if (pos.x - r < MAP_BOUNDS.minX || pos.x + r > MAP_BOUNDS.maxX ||
        pos.z - r < MAP_BOUNDS.minZ || pos.z + r > MAP_BOUNDS.maxZ) return true;
    for (const box of this.colliders) {
      if (pos.x + r > box.min.x && pos.x - r < box.max.x &&
          pos.z + r > box.min.z && pos.z - r < box.max.z &&
          pos.y < box.max.y + 0.1) return true;
    }
    return false;
  }

  private updateShooting(now: number) {
    if (this.isShooting) this.tryShoot(now);
  }

  private tryShoot(now = performance.now()) {
    if (this.state.isDead || this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (weapon.grenade) return; // fire tuşu granatları atmaz
    if (now - this.lastShotTime < weapon.fireRate) return;
    if (this.state.ammo <= 0) { this.reload(); return; }

    this.lastShotTime = now;
    this.state.ammo--;
    gameAudio.shoot(weapon.id);

    this.pitch += weapon.recoil * (Math.random() * 0.5 + 0.8);
    this.pitch = Math.min(Math.PI / 2 - 0.01, this.pitch);
    this.camera.rotation.x = this.pitch;

    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const origin = this.camera.position.clone();

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);

    // First check players
    const targets: THREE.Object3D[] = [];
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.userData.playerId = rp.id;
          targets.push(child);
        }
      });
    }
    const playerHits = this.raycaster.intersectObjects(targets, false);
    const wallHits = this.raycaster.intersectObjects(this.wallMeshes, false);

    const firstPlayer = playerHits[0];
    const firstWall = wallHits[0];

    if (firstPlayer && (!firstWall || firstPlayer.distance < firstWall.distance)) {
      const id = firstPlayer.object.userData.playerId as string | undefined;
      if (id && id !== this.playerId) {
        this.callbacks.onHit(id, weapon.damage);
      }
    } else if (firstWall) {
      this.addBulletHole(firstWall.point, firstWall.face?.normal ?? new THREE.Vector3(0, 1, 0), firstWall.object);
    }

    this.callbacks.onShoot({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      weaponId: weapon.id,
    });
    this.spawnTracer(origin, direction);
  }

  private addBulletHole(point: THREE.Vector3, normal: THREE.Vector3, target: THREE.Object3D) {
    // O şekli — ring geometry
    const ringGeo = new THREE.RingGeometry(0.05, 0.09, 20);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    // Convert normal to world space
    const worldNormal = normal.clone().transformDirection(target.matrixWorld).normalize();
    ring.position.copy(point).add(worldNormal.clone().multiplyScalar(0.01));
    // orient ring to face along normal
    const up = new THREE.Vector3(0, 0, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(up, worldNormal);
    ring.quaternion.copy(q);
    this.scene.add(ring);
    this.bulletHoles.push(ring);
    // limit
    if (this.bulletHoles.length > 120) {
      const old = this.bulletHoles.shift();
      if (old) this.scene.remove(old);
    }
  }

  private spawnTracer(origin: THREE.Vector3, direction: THREE.Vector3) {
    const start = origin.clone().add(direction.clone().multiplyScalar(0.4));
    const end = start.clone().add(direction.multiplyScalar(60));
    const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
    const mat = new THREE.LineBasicMaterial({ color: COLORS.bullet, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push(line);
    setTimeout(() => {
      this.scene.remove(line);
      const idx = this.tracers.indexOf(line);
      if (idx > -1) this.tracers.splice(idx, 1);
    }, 80);
  }

  private throwGrenade(type: 'flash' | 'he') {
    // silaha bakmadan direkt at
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const geo = new THREE.SphereGeometry(0.15, 12, 12);
    const mat = new THREE.MeshStandardMaterial({ color: type === 'flash' ? 0xcccccc : 0x2a5a2a });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.camera.position).add(dir.clone().multiplyScalar(0.6));
    this.scene.add(mesh);
    const velocity = dir.clone().multiplyScalar(18);
    velocity.y += 4;
    this.grenades.push({ mesh, velocity, type, detonateAt: performance.now() + 1800 });
  }

  private updateGrenades(dt: number, now: number) {
    const gravity = -18;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.velocity.y += gravity * dt;
      g.mesh.position.addScaledVector(g.velocity, dt);
      // floor bounce
      if (g.mesh.position.y < 0.15) {
        g.mesh.position.y = 0.15;
        g.velocity.y *= -0.4;
        g.velocity.x *= 0.7;
        g.velocity.z *= 0.7;
      }
      if (now >= g.detonateAt) {
        this.detonateGrenade(g);
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }
  }

  private detonateGrenade(g: Grenade) {
    if (g.type === 'flash') {
      const dist = g.mesh.position.distanceTo(this.camera.position);
      if (dist < 15) {
        const duration = Math.max(500, 2500 - dist * 120);
        this.callbacks.onFlash?.(duration);
      }
    } else {
      // HE — damage self if close, and remote via hit events
      const dist = g.mesh.position.distanceTo(this.camera.position);
      if (dist < 6) {
        this.takeDamage(Math.round(80 * (1 - dist / 6)), this.playerId);
      }
      // burst puff
      const geo = new THREE.SphereGeometry(1.5, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff9944, transparent: true, opacity: 0.7 });
      const puff = new THREE.Mesh(geo, mat);
      puff.position.copy(g.mesh.position);
      this.scene.add(puff);
      setTimeout(() => this.scene.remove(puff), 250);
    }
  }

  private reload() {
    if (this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (!weapon || weapon.reloadTime === 0 || this.state.ammo >= weapon.clipSize) return;
    this.isReloading = true;
    this.reloadEndTime = performance.now() + weapon.reloadTime;
  }

  private updateReload(now: number) {
    if (this.isReloading && now >= this.reloadEndTime) {
      this.isReloading = false;
      this.state.ammo = WEAPONS[this.state.weaponId].clipSize;
    }
  }

  private equipWeapon(id: string) {
    if (this.weaponModel) this.camera.remove(this.weaponModel);
    const def = WEAPONS[id];
    const group = new THREE.Group();

    // Skin-toned hands
    const handMat = new THREE.MeshStandardMaterial({ color: 0xd9a67a, roughness: 0.8 });
    const forearmGeo = new THREE.BoxGeometry(0.08, 0.08, 0.35);
    const leftHand = new THREE.Mesh(forearmGeo, handMat);
    leftHand.position.set(-0.05, -0.02, -0.12);
    const rightHand = new THREE.Mesh(forearmGeo, handMat);
    rightHand.position.set(0.08, -0.02, -0.05);
    group.add(leftHand, rightHand);

    // Weapon by type
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b3a1a, roughness: 0.7 });

    if (def.grenade === 'flash') {
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0xbbbbbb }));
      g.position.set(0.06, -0.02, -0.15); group.add(g);
    } else if (def.grenade === 'he') {
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), new THREE.MeshStandardMaterial({ color: 0x2a5a2a }));
      g.position.set(0.06, -0.02, -0.15); group.add(g);
    } else if (def.id === 'knife') {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.3), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.2 }));
      blade.position.set(0.05, 0, -0.25); group.add(blade);
    } else {
      const barrelLen = def.id === 'sniper' ? 1.1 : def.id === 'rifle' || def.id === 'm4' ? 0.75 : 0.5;
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, barrelLen), bodyMat);
      barrel.position.set(0.05, -0.02, -0.25 - barrelLen / 2 + 0.15);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.08), woodMat);
      grip.position.set(0.05, -0.12, -0.05);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 0.22), woodMat);
      stock.position.set(0.05, -0.04, 0.08);
      group.add(barrel, grip, stock);
      if (def.id === 'rifle') {
        const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.08), bodyMat);
        mag.position.set(0.05, -0.13, -0.15);
        group.add(mag);
      }
      if (def.scope) {
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.32, 12), bodyMat);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0.05, 0.05, -0.15);
        group.add(scope);
      }
    }

    group.position.set(0.18, -0.25, -0.4);
    this.camera.add(group);
    if (!this.camera.parent) this.scene.add(this.camera); // ensure attached
    this.weaponModel = group;

    this.state.weaponId = id;
    this.state.ammo = def.clipSize;
    this.state.maxAmmo = def.clipSize;
    this.isReloading = false;
  }

  public setWeapon(id: string) {
    if (!WEAPONS[id] || this.state.weaponId === id) return;
    this.equipWeapon(id);
  }

  private updateWeaponModel(dt: number) {
    if (!this.weaponModel) return;
    const time = performance.now() / 1000;
    const moving = this.direction.lengthSq() > 0;
    const bob = Math.sin(time * (moving ? 12 : 2)) * (moving ? 0.012 : 0.004);
    this.weaponModel.position.y = -0.25 + bob;

    const targetFov = this.isScoped && WEAPONS[this.state.weaponId].scope ? 22 : 75;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, dt * 12);
      this.camera.updateProjectionMatrix();
    }
  }

  public takeDamage(amount: number, sourceId: string) {
    if (this.state.isDead) return;
    this.state.health = Math.max(0, this.state.health - amount);
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
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.isScoped = false;
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
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
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: state.team === 't' ? COLORS.t : COLORS.ct });
    const body = new THREE.Mesh(new THREE.BoxGeometry(PLAYER_RADIUS * 2, PLAYER_HEIGHT, PLAYER_RADIUS * 2), bodyMat);
    body.position.y = PLAYER_HEIGHT / 2;
    body.userData.playerId = state.id;
    group.add(body);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), new THREE.MeshStandardMaterial({ color: 0xffdbac }));
    head.position.y = PLAYER_HEIGHT + 0.14;
    head.userData.playerId = state.id;
    group.add(head);
    const weaponMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.55), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    weaponMesh.position.set(0.25, PLAYER_HEIGHT - 0.35, 0.35);
    weaponMesh.userData.playerId = state.id;
    group.add(weaponMesh);

    group.position.set(state.position.x, 0, state.position.z);
    this.scene.add(group);
    this.remotePlayers.set(state.id, {
      id: state.id, name: state.name, team: state.team, mesh: group, weaponMesh,
      targetPosition: new THREE.Vector3(state.position.x, 0, state.position.z),
      targetRotation: { x: state.rotation.x, y: state.rotation.y },
      state,
    });
  }

  public updateRemotePlayer(state: PlayerState) {
    let rp = this.remotePlayers.get(state.id);
    if (!rp) { this.addRemotePlayer(state); rp = this.remotePlayers.get(state.id)!; }
    rp.state = state;
    rp.targetPosition.set(state.position.x, 0, state.position.z);
    rp.targetRotation.x = state.rotation.x;
    rp.targetRotation.y = state.rotation.y;
    const head = rp.mesh.children[1];
    if (head) head.rotation.x = state.rotation.x;
  }

  public removeRemotePlayer(id: string) {
    const rp = this.remotePlayers.get(id);
    if (rp) { this.scene.remove(rp.mesh); this.remotePlayers.delete(id); }
  }

  private updateRemotePlayers(dt: number) {
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.position.lerp(rp.targetPosition, 1 - Math.pow(0.001, dt));
      const targetYaw = -rp.targetRotation.y + Math.PI;
      rp.mesh.rotation.y = THREE.MathUtils.lerp(rp.mesh.rotation.y, targetYaw, 1 - Math.pow(0.001, dt));
    }
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
