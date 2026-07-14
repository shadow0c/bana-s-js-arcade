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
} from './constants';
import type { PlayerState, RemotePlayer, Team, Vector3Like } from './types';

export interface GameEngineCallbacks {
  onShoot: (event: { origin: Vector3Like; direction: Vector3Like; weaponId: string }) => void;
  onHit: (targetId: string, damage: number) => void;
  onDeath: (killerId: string, victimId: string, weaponId: string) => void;
  onStateChange: (state: PlayerState) => void;
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
  private velocity = new THREE.Vector3();
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

  private yaw = 0;
  private pitch = 0;

  private weaponModel: THREE.Group | null = null;
  private remotePlayers = new Map<string, RemotePlayer>();
  private colliders: THREE.Box3[] = [];

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
    const offset = this.team === 't' ? -35 : 35;
    return {
      x: offset + (Math.random() - 0.5) * 10,
      y: PLAYER_HEIGHT,
      z: (Math.random() - 0.5) * 70,
    };
  }

  private setupScene() {
    this.scene.background = new THREE.Color(0xa3a3a3);
    this.scene.fog = new THREE.Fog(0xa3a3a3, 20, 120);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(30, 80, 40);
    this.scene.add(dirLight);

    const floorGeo = new THREE.PlaneGeometry(100, 100);
    const floorMat = new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(100, 50, COLORS.grid, COLORS.grid);
    grid.position.y = 0.01;
    this.scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: COLORS.wall });
    for (const box of MAP_WALLS) {
      const geo = new THREE.BoxGeometry(box.w, box.h, box.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(box.x, box.h / 2, box.z);
      this.scene.add(mesh);
      this.colliders.push(new THREE.Box3().setFromObject(mesh));
    }

    const spawn = this.state.position;
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.camera.rotation.order = 'YXZ';
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
      if (!this.mouseLocked && !this.state.isDead) {
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
      case 'KeyW':
        this.moveForward = true;
        break;
      case 'KeyA':
        this.moveLeft = true;
        break;
      case 'KeyS':
        this.moveBackward = true;
        break;
      case 'KeyD':
        this.moveRight = true;
        break;
      case 'Space':
        e.preventDefault();
        break;
      case 'KeyR':
        this.reload();
        break;
      case 'Digit1':
        this.setWeapon('pistol');
        break;
      case 'Digit2':
        this.setWeapon('rifle');
        break;
      case 'Digit3':
        this.setWeapon('sniper');
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW':
        this.moveForward = false;
        break;
      case 'KeyA':
        this.moveLeft = false;
        break;
      case 'KeyS':
        this.moveBackward = false;
        break;
      case 'KeyD':
        this.moveRight = false;
        break;
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

  public lockPointer() {
    this.canvas.requestPointerLock();
  }

  public unlockPointer() {
    document.exitPointerLock();
  }

  public isLocked() {
    return this.mouseLocked;
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
    this.unlockPointer();
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
    this.updateTracers();
    this.broadcastStateIfNeeded(now);
  }

  private updateMovement(dt: number) {
    this.direction.z = Number(this.moveForward) - Number(this.moveBackward);
    this.direction.x = Number(this.moveRight) - Number(this.moveLeft);

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
    const minX = pos.x - r;
    const maxX = pos.x + r;
    const minZ = pos.z - r;
    const maxZ = pos.z + r;

    if (minX < MAP_BOUNDS.minX || maxX > MAP_BOUNDS.maxX || minZ < MAP_BOUNDS.minZ || maxZ > MAP_BOUNDS.maxZ) {
      return true;
    }

    for (const box of this.colliders) {
      if (maxX > box.min.x && minX < box.max.x && maxZ > box.min.z && minZ < box.max.z) {
        return true;
      }
    }
    return false;
  }

  private updateShooting(now: number) {
    if (this.isShooting) {
      this.tryShoot(now);
    }
  }

  private tryShoot(now = performance.now()) {
    if (this.state.isDead || this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (now - this.lastShotTime < weapon.fireRate) return;
    if (this.state.ammo <= 0) {
      this.reload();
      return;
    }

    this.lastShotTime = now;
    this.state.ammo--;

    this.pitch += weapon.recoil * (Math.random() * 0.5 + 0.8);
    this.pitch = Math.min(Math.PI / 2 - 0.01, this.pitch);
    this.camera.rotation.x = this.pitch;

    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const origin = this.camera.position.clone();

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const targets: THREE.Object3D[] = [];
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.userData.playerId = rp.id;
          targets.push(child);
        }
      });
    }

    const intersects = this.raycaster.intersectObjects(targets, false);
    if (intersects.length > 0) {
      const hit = intersects[0];
      const id = hit.object.userData.playerId as string | undefined;
      if (id && id !== this.playerId) {
        this.callbacks.onHit(id, weapon.damage);
      }
    }

    this.callbacks.onShoot({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      weaponId: weapon.id,
    });

    this.spawnTracer(origin, direction);
  }

  private spawnTracer(origin: THREE.Vector3, direction: THREE.Vector3) {
    const start = origin.clone().add(direction.clone().multiplyScalar(0.4));
    const end = start.clone().add(direction.multiplyScalar(50));
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

  private updateTracers() {
    // tracers auto-removed by timeout
  }

  private reload() {
    if (this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (this.state.ammo >= weapon.clipSize) return;
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
    this.weaponModel = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.12, 0.12, def.id === 'sniper' ? 1.0 : 0.65);
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 });
    const gun = new THREE.Mesh(geo, mat);
    this.weaponModel.add(gun);

    if (def.scope) {
      const scopeGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.35, 8);
      const scopeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
      const scope = new THREE.Mesh(scopeGeo, scopeMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.08, -0.15);
      this.weaponModel.add(scope);
    }

    this.weaponModel.position.set(0.2, -0.22, -0.45);
    this.camera.add(this.weaponModel);

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
    const bob = Math.sin(time * (this.direction.lengthSq() > 0 ? 12 : 0)) * 0.008;
    this.weaponModel.position.y = -0.22 + bob;

    const targetFov = this.isScoped && WEAPONS[this.state.weaponId].scope ? 22 : 75;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, dt * 12);
      this.camera.updateProjectionMatrix();
    }
  }

  public takeDamage(amount: number, sourceId: string) {
    if (this.state.isDead) return;
    this.state.health = Math.max(0, this.state.health - amount);
    if (this.state.health <= 0) {
      this.die(sourceId);
    }
  }

  private die(killerId: string) {
    this.state.isDead = true;
    this.state.deaths++;
    this.unlockPointer();
    this.callbacks.onDeath(killerId, this.playerId, this.state.weaponId);
    setTimeout(() => this.respawn(), RESPAWN_TIME);
  }

  public respawn() {
    const spawn = this.getSpawnPoint();
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = this.team === 't' ? 0 : Math.PI;
    this.pitch = 0;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.state.position = spawn;
    this.state.health = MAX_HEALTH;
    this.state.isDead = false;
    this.equipWeapon('pistol');
  }

  public getState(): PlayerState {
    return this.state;
  }

  public addMoney(amount: number) {
    this.state.money += amount;
  }

  public addKill() {
    this.state.kills++;
  }

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
    const bodyGeo = new THREE.BoxGeometry(PLAYER_RADIUS * 2, PLAYER_HEIGHT, PLAYER_RADIUS * 2);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = PLAYER_HEIGHT / 2;
    body.userData.playerId = state.id;
    group.add(body);

    const headGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffdbac });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = PLAYER_HEIGHT + 0.11;
    head.userData.playerId = state.id;
    group.add(head);

    const weaponGeo = new THREE.BoxGeometry(0.08, 0.08, 0.5);
    const weaponMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const weaponMesh = new THREE.Mesh(weaponGeo, weaponMat);
    weaponMesh.position.set(0.2, PLAYER_HEIGHT - 0.35, 0.35);
    weaponMesh.userData.playerId = state.id;
    group.add(weaponMesh);

    group.position.set(state.position.x, 0, state.position.z);
    this.scene.add(group);

    const rp: RemotePlayer = {
      id: state.id,
      name: state.name,
      team: state.team,
      mesh: group,
      weaponMesh,
      targetPosition: new THREE.Vector3(state.position.x, 0, state.position.z),
      targetRotation: { x: state.rotation.x, y: state.rotation.y },
      state,
    };
    this.remotePlayers.set(state.id, rp);
  }

  public updateRemotePlayer(state: PlayerState) {
    let rp = this.remotePlayers.get(state.id);
    if (!rp) {
      this.addRemotePlayer(state);
      rp = this.remotePlayers.get(state.id)!;
    }
    rp.state = state;
    rp.targetPosition.set(state.position.x, 0, state.position.z);
    rp.targetRotation.x = state.rotation.x;
    rp.targetRotation.y = state.rotation.y;

    const head = rp.mesh.children[1];
    if (head) head.rotation.x = state.rotation.x;
  }

  public removeRemotePlayer(id: string) {
    const rp = this.remotePlayers.get(id);
    if (rp) {
      this.scene.remove(rp.mesh);
      this.remotePlayers.delete(id);
    }
  }

  private updateRemotePlayers(dt: number) {
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.position.lerp(rp.targetPosition, 1 - Math.pow(0.001, dt));
      const targetYaw = -rp.targetRotation.y + Math.PI; // face camera direction
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
