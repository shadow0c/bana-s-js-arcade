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
import { gameAudio } from './audio';
import { PhysicalReflectiveFloor } from './reflectiveFloor';

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

// HE granatının maksimum etkili yarıçapı (metre) — hem kendine hem uzak oyunculara uygulanır.
const HE_BLAST_RADIUS = 6;
const HE_MAX_DAMAGE = 80;

/**
 * Bir Object3D alt ağacındaki tüm Mesh/Line geometrilerini ve materyallerini
 * (materyale bağlı texture'lar dahil) GPU belleğinden serbest bırakır.
 *
 * NEDEN GEREKLİ: three.js'te `scene.remove(obj)` yalnızca sahne grafiğinden
 * çıkarır; WebGLRenderer'ın iç kaydındaki buffer/texture/program referansları
 * `.dispose()` çağrılmadan serbest kalmaz. Bu proje sürekli obje yaratıp
 * (mermi izi, kurşun deliği, granat, uzak oyuncu modeli) kaldırdığı için,
 * dispose çağrılmaması doğrudan sınırsız büyüyen bir GPU bellek sızıntısıdır.
 *
 * NOT: `scene.environment` (PMREM env map) burada KASITLI olarak dokunulmaz —
 * materyaller ona ayrı bir `envMap` referansı olarak değil, global
 * `scene.environment` üzerinden erişir; bu fonksiyon yalnızca materyalin
 * kendi sahip olduğu texture slotlarını (map, normalMap, vb.) temizler.
 */
const DISPOSABLE_TEXTURE_KEYS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
  'emissiveMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
] as const;

function disposeMaterial(material: THREE.Material) {
  const mat = material as unknown as Record<string, unknown>;
  for (const key of DISPOSABLE_TEXTURE_KEYS) {
    const tex = mat[key];
    if (tex instanceof THREE.Texture) tex.dispose();
  }
  material.dispose();
}

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry?.dispose();
      const material = child.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach(disposeMaterial);
      else if (material) disposeMaterial(material);
    }
  });
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
  // Recoil (tepme birikimi & toparlanma)
  private recoilPitch = 0;
  private recoilYaw = 0;
  private consecutiveShots = 0;
  private lastFireGap = 0;

  private remotePlayers = new Map<string, RemotePlayer>();
  private colliders: THREE.Box3[] = [];
  private wallMeshes: THREE.Mesh[] = [];
  private bulletHoles: THREE.Mesh[] = [];
  private grenades: Grenade[] = [];

  // Vuruş (raycast) hedef önbelleği — her atışta yeniden kurulmak yerine
  // sadece oyuncu katılıp/ayrıldığında geçersiz kılınır (bkz. hitTargetsDirty).
  private cachedHitTargets: THREE.Object3D[] = [];
  private hitTargetsDirty = true;

  // Inspector (sahne düzenleyici) açıkken true olur: WASD hareketi, ateş etme
  // ve pointer-lock devre dışı kalır ki fare TransformControls gizmo'larıyla
  // serbestçe etkileşebilsin. Inspector kapanınca normal oyun akışı devam eder.
  private inspectorModeActive = false;

  private isMobile = false;
  private reflectiveFloor: PhysicalReflectiveFloor | null = null;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;

  private lastBroadcastTime = 0;
  private readonly BROADCAST_INTERVAL = 50;

  private tracers: THREE.Line[] = [];

  private rafId: number | null = null;
  private lastTime = performance.now();
  private isRunning = false;

  // cleanup() sırasında iptal edilebilmesi için tüm zamanlayıcı kimlikleri burada tutulur.
  // Aksi halde bir bileşen unmount olduktan sonra (ör. React StrictMode çift-mount,
  // sekme kapatma sırasında yarışan respawn) "ölü" bir engine örneği üzerinde kod
  // çalışmaya devam eder — hem mantık hatası hem bellek sızıntısı kaynağıdır.
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

  // Sıcak yol (her karede/her atışta çalışan) allokasyonlarını önlemek için
  // önceden ayrılmış geçici vektörler. reflectiveFloor.ts'deki aynı desenle tutarlı.
  private readonly _scratchForward = new THREE.Vector3();
  private readonly _scratchRight = new THREE.Vector3();
  private readonly _scratchMove = new THREE.Vector3();
  private readonly _scratchNextPos = new THREE.Vector3();
  private readonly _scratchUp = new THREE.Vector3(0, 1, 0);
  private readonly _scratchShotDir = new THREE.Vector3();
  private readonly _scratchShotOrigin = new THREE.Vector3();

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
    // clientWidth/clientHeight, canvas layout tamamlanmadan (ör. flex konteyner henüz
    // ölçülenmeden) 0 gelebilir; 0/0 -> NaN aspect ratio -> bozuk projeksiyon matrisi.
    // Bu yüzden minimum 1 ile korunuyor.
    const initialWidth = canvas.clientWidth || 1;
    const initialHeight = canvas.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(75, initialWidth / initialHeight, 0.05, 500);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(initialWidth, initialHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Gölge (mobilde performans için kapalı)
    this.isMobile = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    if (!this.isMobile) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
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

  private makeCanvasTexture(kind: 'floor' | 'wall' | 'crate'): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    if (kind === 'floor') {
      // Kum/toprak - dust2 zemini
      ctx.fillStyle = '#c9a878';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 3000; i++) {
        const x = Math.random() * size, y = Math.random() * size;
        const v = Math.random() * 40 - 20;
        ctx.fillStyle = `rgba(${139 + v},${115 + v},${75 + v},0.5)`;
        ctx.fillRect(x, y, 2, 2);
      }
    } else if (kind === 'wall') {
      // Kum taş duvar
      ctx.fillStyle = '#a08052';
      ctx.fillRect(0, 0, size, size);
      const bw = 64, bh = 32;
      for (let y = 0; y < size; y += bh) {
        const off = (y / bh) % 2 === 0 ? 0 : bw / 2;
        for (let x = -bw; x < size; x += bw) {
          ctx.fillStyle = `hsl(${25 + Math.random() * 10}, ${35 + Math.random() * 15}%, ${45 + Math.random() * 15}%)`;
          ctx.fillRect(x + off, y, bw - 2, bh - 2);
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      for (let y = 0; y < size; y += bh) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
      }
    } else {
      // Ahşap kutu
      ctx.fillStyle = '#7a4a1e';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 12; i++) {
        ctx.strokeStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.2})`;
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        ctx.moveTo(0, i * 22 + Math.random() * 5);
        ctx.bezierCurveTo(size / 3, i * 22, (size * 2) / 3, i * 22 + 8, size, i * 22 + Math.random() * 5);
        ctx.stroke();
      }
      ctx.strokeStyle = '#3a1f08';
      ctx.lineWidth = 6;
      ctx.strokeRect(0, 0, size, size);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /**
   * Sahne için PMREM tabanlı, fiziksel olarak makul bir çevre (environment) haritası
   * üretir. Bu harita, MeshStandardMaterial/MeshPhysicalMaterial yüzeylerinde
   * (silahlar, yelek, kask, duvarlar) gerçekçi image-based specular yansımalar sağlar —
   * düz renkli materyallerin aksine, yüzeyler artık gökyüzünü/ortamı "görür".
   */
  private buildEnvironmentMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();

    const topColor = new THREE.Color(COLORS.sky);
    const bottomColor = new THREE.Color(0xd8b98a); // sıcak kum yansıması

    const gradientGeo = new THREE.SphereGeometry(50, 32, 16);
    const gradientMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: topColor },
        bottomColor: { value: bottomColor },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y * 0.5 + 0.5;
          gl_FragColor = vec4(mix(bottomColor, topColor, clamp(h, 0.0, 1.0)), 1.0);
        }
      `,
      side: THREE.BackSide,
    });
    const gradientSky = new THREE.Mesh(gradientGeo, gradientMat);
    envScene.add(gradientSky);

    // Yönlü ışıkla eşleşen, parlak yüzeylerde belirgin bir specular vurgu oluşturan güneş
    const sunGeo = new THREE.SphereGeometry(4, 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff2c8 });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(28, 40, 18);
    envScene.add(sun);

    const rt = pmrem.fromScene(envScene, 0.035);
    this.scene.environment = rt.texture;
    this.envRenderTarget = rt;

    pmrem.dispose();
    gradientGeo.dispose();
    gradientMat.dispose();
    sunGeo.dispose();
    sunMat.dispose();
  }

  private setupScene() {
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 40, 160);
    this.buildEnvironmentMap();

    // Ortam ışığı (AO benzeri yumuşak)
    const hemiLight = new THREE.HemisphereLight(0xfff2d9, 0x554433, 0.55);
    this.scene.add(hemiLight);
    const ambient = new THREE.AmbientLight(0x6b5a44, 0.25);
    this.scene.add(ambient);

    // Yönlü ışık + gölge
    const dirLight = new THREE.DirectionalLight(0xffe4b5, 1.4);
    dirLight.position.set(45, 100, 30);
    dirLight.castShadow = this.renderer.shadowMap.enabled;
    if (dirLight.castShadow) {
      dirLight.shadow.mapSize.set(1024, 1024);
      dirLight.shadow.camera.near = 5;
      dirLight.shadow.camera.far = 200;
      dirLight.shadow.camera.left = -70;
      dirLight.shadow.camera.right = 70;
      dirLight.shadow.camera.top = 70;
      dirLight.shadow.camera.bottom = -70;
      dirLight.shadow.bias = -0.0005;
    }
    this.scene.add(dirLight);

    // Floor - prosedürel doku
    const floorTex = this.makeCanvasTexture('floor');
    floorTex.repeat.set(30, 30);
    const floorGeo = new THREE.PlaneGeometry(120, 120);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.94,
      metalness: 0.05,
      envMapIntensity: 0.5,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.isWall = true;
    this.scene.add(floor);
    this.wallMeshes.push(floor);

    // Gerçek zamanlı, fiziksel (Fresnel) düzlemsel zemin yansıması.
    // Sahneyi bir ayna gibi ayrı render eder ve bakış açısına göre kum dokusuyla
    // harmanlar: tepeden bakışta neredeyse görünmez, sıyırma açısında belirgindir —
    // masraflı olduğu için mobilde performans adına devre dışı bırakılır.
    if (!this.isMobile) {
      const reflectionRes = Math.round(512 * Math.min(window.devicePixelRatio, 1.5));
      this.reflectiveFloor = new PhysicalReflectiveFloor({
        size: 120,
        diffuseMap: floorTex,
        repeat: { x: 30, y: 30 },
        textureWidth: reflectionRes,
        textureHeight: reflectionRes,
        multisample: 4,
        tintColor: 0xd7cdb8,
        baseReflectivity: 0.06,
      });
      this.reflectiveFloor.rotation.x = -Math.PI / 2;
      this.reflectiveFloor.position.y = 0.015; // z-fighting'i önlemek için hafif yukarıda
      this.scene.add(this.reflectiveFloor);
    }

    // Duvarlar - prosedürel doku
    for (const box of MAP_WALLS) {
      const useCrate = box.w <= 6 && box.d <= 6 && box.h <= 2.5;
      const tex = this.makeCanvasTexture(useCrate ? 'crate' : 'wall');
      if (!useCrate) tex.repeat.set(Math.max(1, box.w / 3), Math.max(1, box.h / 3));
      const geo = new THREE.BoxGeometry(box.w, box.h, box.d);
      const mat = new THREE.MeshStandardMaterial(
        useCrate
          ? { map: tex, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.15 } // ahşap - az yansıtıcı
          : { map: tex, roughness: 0.82, metalness: 0.06, envMapIntensity: 0.45 }, // kum taşı - hafif parlak
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(box.x, box.h / 2, box.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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
    // Önceden anonim bir arrow function idi -> cleanup() içinde asla removeEventListener
    // edilemiyordu, bu da canvas her yeniden kullanıldığında (ör. React remount) `this`
    // referansını tutan yeni bir dinleyicinin birikmesine (bellek sızıntısı) yol açıyordu.
    this.canvas.addEventListener('click', this.onCanvasClick);
  }

  private onCanvasClick = () => {
    // Mobil cihazlarda pointer lock istemiyoruz
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouch && !this.mouseLocked && !this.state.isDead) {
      this.canvas.requestPointerLock();
    }
  };

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
    if (this.inspectorModeActive) return;
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
    // clientWidth/Height geçici olarak 0 olabilir (ör. sekme gizliyken resize event'i
    // tetiklenmesi); 0'a bölme -> NaN aspect ratio -> projeksiyon matrisi bozulur.
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
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

  // ============ INSPECTOR / EDITOR PUBLIC API ============
  // Bu blok yalnızca Inspector (src/lib/game/inspector/Inspector.ts) tarafından
  // kullanılır. Sahneye doğrudan erişim vererek inspector'ın küp eklemesi,
  // asset import etmesi ve materyal/renk düzenlemesi mümkün olur.

  public getScene(): THREE.Scene { return this.scene; }
  public getCamera(): THREE.PerspectiveCamera { return this.camera; }
  public getRenderer(): THREE.WebGLRenderer { return this.renderer; }
  /** Inspector'ın renk boyayabilmesi/seçebilmesi için MEVCUT harita duvarlarının referansı (kopya değil). */
  public getWallMeshes(): THREE.Mesh[] { return this.wallMeshes; }

  /**
   * Inspector'daki "serbest bakış" (sağ-tık sürükle) bunu çağırarak kamerayı
   * döndürür. Doğrudan `camera.rotation` değiştirmek yerine bunun üzerinden
   * gitmek ÖNEMLİ: aksi halde inspector kapatıldığında `this.yaw`/`this.pitch`
   * (hareket ve recoil hesaplarının temel aldığı iç durum) eskide kalır ve
   * oyuncu normal moda dönünce kamera aniden "sıçrar" (senkron bozulması).
   */
  public getYawPitch() { return { yaw: this.yaw, pitch: this.pitch }; }
  public setYawPitch(yaw: number, pitch: number) {
    this.yaw = yaw;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  /** Inspector'ın eklediği bir küp/mesh'i çarpışma listesine dahil eder (oyuncu artık içinden geçemez). */
  public registerCollider(box: THREE.Box3) {
    this.colliders.push(box);
  }

  public unregisterCollider(box: THREE.Box3) {
    const idx = this.colliders.indexOf(box);
    if (idx > -1) this.colliders.splice(idx, 1);
  }

  /** Inspector'ın eklediği bir mesh'i mermi/raycast hedefi (duvar gibi) sayar. */
  public registerWallMesh(mesh: THREE.Mesh) {
    this.wallMeshes.push(mesh);
  }

  public unregisterWallMesh(mesh: THREE.Mesh) {
    const idx = this.wallMeshes.indexOf(mesh);
    if (idx > -1) this.wallMeshes.splice(idx, 1);
  }

  /** true iken oyuncu hareketi/ateşi/pointer-lock devre dışı kalır (bkz. update()). */
  public setInspectorModeActive(active: boolean) {
    this.inspectorModeActive = active;
    if (active) {
      this.moveForward = this.moveBackward = this.moveLeft = this.moveRight = false;
      this.isShooting = false;
      try { this.unlockPointer(); } catch { /* ignore */ }
    }
  }

  public isInspectorModeActive() { return this.inspectorModeActive; }

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

  /**
   * setTimeout tabanlı geçici efektleri (mermi izi, granat toparlanması, respawn)
   * izlenebilir hale getirir. cleanup() çağrıldığında tüm bekleyen zamanlayıcılar
   * iptal edilir; aksi halde "ölü" bir engine örneği üzerinde respawn/tracer-silme
   * gibi kod parçaları sessizce çalışmaya devam eder (hem mantık hatası hem sızıntı).
   */
  private scheduleTimeout(fn: () => void, delayMs: number) {
    const id = setTimeout(() => {
      this.pendingTimeouts.delete(id);
      fn();
    }, delayMs);
    this.pendingTimeouts.add(id);
    return id;
  }

  public cleanup() {
    this.stop();
    try { this.unlockPointer(); } catch { /* ignore */ }

    for (const id of this.pendingTimeouts) clearTimeout(id);
    this.pendingTimeouts.clear();

    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('click', this.onCanvasClick);

    // Yansıtıcı zemin kendi render-target/material/geometry'sini serbest bırakır.
    // Genel sahne temizliğinden ÖNCE sahneden çıkarılıyor ki aşağıdaki traversal
    // onu bir kez daha (zararsız ama gereksiz) dispose etmeye çalışmasın.
    if (this.reflectiveFloor) {
      this.reflectiveFloor.disposeFloor();
      this.scene.remove(this.reflectiveFloor);
      this.reflectiveFloor = null;
    }
    this.envRenderTarget?.dispose();
    this.envRenderTarget = null;

    // Sahnede kalan her şeyi (duvarlar, zemin, kurşun delikleri, mermi izleri,
    // granatlar, uzak oyuncu modelleri) GPU belleğinden serbest bırak.
    disposeObject3D(this.scene);
    this.bulletHoles = [];
    this.tracers = [];
    this.grenades = [];
    this.remotePlayers.clear();
    this.cachedHitTargets = [];

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
    if (!this.inspectorModeActive) {
      this.updateMovement(dt);
      this.updateShooting(now);
      this.updateReload(now);
      this.updateRecoilRecovery(dt, now);
      this.updateWeaponModel(dt);
    }
    this.updateRemotePlayers(dt);
    this.updateGrenades(dt, now);
    this.broadcastStateIfNeeded(now);
  }

  private updateRecoilRecovery(dt: number, now: number) {
    // Ateş bittikten kısa süre sonra kamerayı yumuşakça geri getir.
    // ÖNEMLİ: Eskiden `if (this.isShooting) return;` burada vardı — bu, düşük ateş
    // hızlı silahlarda (sniper/pistol) tetik basılı tutulduğu sürece (fireRate
    // beklemesi sırasında bile) toparlanmayı tamamen durduruyordu; kamera, atışlar
    // arasında hiç yerleşmeden yukarı sürükleniyordu. Doğru koşul sadece "son atıştan
    // bu yana yeterince zaman geçti mi" olmalı.
    if (now - this.lastShotTime < 60) return;
    const recover = Math.min(1, dt * 8);
    const dp = this.recoilPitch * recover;
    const dy = this.recoilYaw * recover;
    this.pitch -= dp; this.recoilPitch -= dp;
    this.yaw -= dy; this.recoilYaw -= dy;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
    if (Math.abs(this.recoilPitch) < 0.001) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 0.001) this.recoilYaw = 0;
    if (!this.isShooting && this.consecutiveShots > 0 && now - this.lastShotTime > 300) this.consecutiveShots = 0;
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

    // Önceden her karede 3-4 yeni THREE.Vector3 allocate ediliyordu (GC baskısı).
    // Artık sınıf seviyesinde önceden ayrılmış (scratch) vektörler yeniden kullanılıyor.
    this._scratchForward.set(0, 0, -1).applyAxisAngle(this._scratchUp, this.yaw);
    this._scratchRight.set(1, 0, 0).applyAxisAngle(this._scratchUp, this.yaw);
    this._scratchMove.set(0, 0, 0)
      .addScaledVector(this._scratchForward, this.direction.z * speed * dt)
      .addScaledVector(this._scratchRight, this.direction.x * speed * dt);

    const nextPos = this._scratchNextPos.copy(this.camera.position);
    nextPos.x += this._scratchMove.x;
    if (!this.collides(nextPos)) this.camera.position.x = nextPos.x;
    nextPos.copy(this.camera.position);
    nextPos.z += this._scratchMove.z;
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

  private rebuildHitTargets() {
    this.cachedHitTargets = [];
    for (const rp of this.remotePlayers.values()) {
      rp.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) this.cachedHitTargets.push(child);
      });
    }
    this.hitTargetsDirty = false;
  }

  private tryShoot(now = performance.now()) {
    if (this.state.isDead || this.isReloading) return;
    const weapon = WEAPONS[this.state.weaponId];
    if (weapon.grenade) return; // fire tuşu granatları atmaz
    // Bıçak mermi tüketmez ve raycast/ses "ateş" akışını kullanmaz — kısa
    // menzilli bir "slash" mekaniği ilerideki bir turda eklenecek; şimdilik
    // primary trigger sessizce yutulur (aksi halde her tıkta ateş sesi + boş
    // mermi kontrolü tetiklenip HUD'da yanlış davranış yaratıyordu).
    if (weapon.melee) return;
    if (now - this.lastShotTime < weapon.fireRate) return;
    if (this.state.ammo <= 0) { this.reload(); return; }

    // Otomatik silahda ardışık atışlar için birikim faktörü
    this.lastFireGap = now - this.lastShotTime;
    this.lastShotTime = now;
    this.state.ammo--;
    gameAudio.shoot(weapon.id);

    // ÖNEMLİ SIRALAMA DÜZELTMESİ:
    // Eskiden recoil (tepme) kameraya UYGULANDIKTAN sonra raycast yapılıyordu —
    // yani her mermi, kendi ürettiği tepmeden etkilenerek nişan noktasından
    // sapmış bir yönde ateş ediyordu. Doğrusu: bu atışın isabetini MEVCUT
    // (henüz tepmemiş) kamera yönelimiyle hesapla, tepmeyi SONRA uygula —
    // tepme bir sonraki atışı ve görsel geri bildirimi etkilesin.
    this.camera.getWorldDirection(this._scratchShotDir);
    this._scratchShotOrigin.copy(this.camera.position);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);

    if (this.hitTargetsDirty) this.rebuildHitTargets();
    const playerHits = this.raycaster.intersectObjects(this.cachedHitTargets, false);
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
      origin: { x: this._scratchShotOrigin.x, y: this._scratchShotOrigin.y, z: this._scratchShotOrigin.z },
      direction: { x: this._scratchShotDir.x, y: this._scratchShotDir.y, z: this._scratchShotDir.z },
      weaponId: weapon.id,
    });
    this.spawnTracer(this._scratchShotOrigin, this._scratchShotDir);

    // Tepmeyi raycast'ten SONRA uygula.
    // Ateş hızlı geldikçe birikim artar
    if (this.lastFireGap < weapon.fireRate * 3) this.consecutiveShots++;
    else this.consecutiveShots = 1;
    const buildUp = 1 + Math.min(4, this.consecutiveShots * 0.35);
    // Scope yaparken tepme yarıya iner
    const scopeMul = this.isScoped ? 0.5 : 1;

    const vert = weapon.recoil * buildUp * scopeMul;
    const horiz = weapon.recoil * 0.4 * (Math.random() - 0.5) * buildUp * scopeMul;
    this.recoilPitch += vert;
    this.recoilYaw += horiz;
    this.pitch += vert;
    this.yaw += horiz;
    this.pitch = Math.min(Math.PI / 2 - 0.01, this.pitch);
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
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
    // limit — kapasite dolunca en eskisini hem sahneden hem GPU belleğinden kaldır
    if (this.bulletHoles.length > 120) {
      const old = this.bulletHoles.shift();
      if (old) {
        this.scene.remove(old);
        disposeObject3D(old);
      }
    }
  }

  private spawnTracer(origin: THREE.Vector3, direction: THREE.Vector3) {
    const start = origin.clone().add(direction.clone().multiplyScalar(0.4));
    const end = start.clone().add(direction.clone().multiplyScalar(60));
    const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
    const mat = new THREE.LineBasicMaterial({ color: COLORS.bullet, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push(line);
    this.scheduleTimeout(() => {
      this.scene.remove(line);
      disposeObject3D(line);
      const idx = this.tracers.indexOf(line);
      if (idx > -1) this.tracers.splice(idx, 1);
    }, 80);
  }

  private throwGrenade(type: 'flash' | 'he') {
    // Ölü bir oyuncu granat atamaz — önceden bu kontrol yalnızca klavye
    // yolunda (onKeyDown) vardı; mobil `mobileThrow` yolunda YOKTU. Artık
    // tek doğru kaynak burada, her iki giriş yolu için de geçerli.
    if (this.state.isDead) return;
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
    const r = 0.15;
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.velocity.y += gravity * dt;
      const prev = g.mesh.position.clone();
      g.mesh.position.addScaledVector(g.velocity, dt);

      // Zemin
      if (g.mesh.position.y < r) {
        g.mesh.position.y = r;
        g.velocity.y *= -0.4;
        g.velocity.x *= 0.75;
        g.velocity.z *= 0.75;
      }

      // Dış harita sınırları
      if (g.mesh.position.x - r < MAP_BOUNDS.minX) { g.mesh.position.x = MAP_BOUNDS.minX + r; g.velocity.x *= -0.5; }
      if (g.mesh.position.x + r > MAP_BOUNDS.maxX) { g.mesh.position.x = MAP_BOUNDS.maxX - r; g.velocity.x *= -0.5; }
      if (g.mesh.position.z - r < MAP_BOUNDS.minZ) { g.mesh.position.z = MAP_BOUNDS.minZ + r; g.velocity.z *= -0.5; }
      if (g.mesh.position.z + r > MAP_BOUNDS.maxZ) { g.mesh.position.z = MAP_BOUNDS.maxZ - r; g.velocity.z *= -0.5; }

      // Duvar AABB çarpışması - kutu yönüne göre sekme
      for (const box of this.colliders) {
        if (
          g.mesh.position.x + r > box.min.x && g.mesh.position.x - r < box.max.x &&
          g.mesh.position.y + r > box.min.y && g.mesh.position.y - r < box.max.y &&
          g.mesh.position.z + r > box.min.z && g.mesh.position.z - r < box.max.z
        ) {
          // Hangi eksende girildiyse o eksende sek
          const enteredX = prev.x + r <= box.min.x || prev.x - r >= box.max.x;
          const enteredZ = prev.z + r <= box.min.z || prev.z - r >= box.max.z;
          const enteredY = prev.y + r <= box.min.y || prev.y - r >= box.max.y;
          if (enteredX) { g.mesh.position.x = prev.x; g.velocity.x *= -0.5; }
          else if (enteredZ) { g.mesh.position.z = prev.z; g.velocity.z *= -0.5; }
          else if (enteredY) { g.mesh.position.y = prev.y; g.velocity.y *= -0.4; }
          else { g.mesh.position.copy(prev); g.velocity.multiplyScalar(-0.5); }
          g.velocity.multiplyScalar(0.8);
        }
      }
      if (now >= g.detonateAt) {
        this.detonateGrenade(g);
        this.scene.remove(g.mesh);
        disposeObject3D(g.mesh);
        this.grenades.splice(i, 1);
      }
    }
  }

  private detonateGrenade(g: Grenade) {
    if (g.type === 'flash') {
      gameAudio.flashBang();
      const dist = g.mesh.position.distanceTo(this.camera.position);
      if (dist < 15) {
        const duration = Math.max(500, 2500 - dist * 120);
        this.callbacks.onFlash?.(duration);
      }
    } else {
      gameAudio.explosion();

      // Kendine hasar (yakınsa)
      const selfDist = g.mesh.position.distanceTo(this.camera.position);
      if (selfDist < HE_BLAST_RADIUS) {
        this.takeDamage(Math.round(HE_MAX_DAMAGE * (1 - selfDist / HE_BLAST_RADIUS)), this.playerId);
      }

      // KRİTİK DÜZELTME: Önceden HE granatı yalnızca kendine hasar veriyordu —
      // `callbacks.onHit` uzak oyunculara HİÇ çağrılmıyordu, yani multiplayer'da
      // granatlar rakipleri asla öldüremiyordu. Şimdi patlama yarıçapındaki her
      // uzak oyuncuya, mesafeye göre azalan hasar uygulanıyor.
      for (const rp of this.remotePlayers.values()) {
        const dist = g.mesh.position.distanceTo(rp.mesh.position);
        if (dist < HE_BLAST_RADIUS) {
          const damage = Math.round(HE_MAX_DAMAGE * (1 - dist / HE_BLAST_RADIUS));
          if (damage > 0) this.callbacks.onHit(rp.id, damage);
        }
      }

      // burst puff
      const geo = new THREE.SphereGeometry(1.5, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff9944, transparent: true, opacity: 0.7 });
      const puff = new THREE.Mesh(geo, mat);
      puff.position.copy(g.mesh.position);
      this.scene.add(puff);
      this.scheduleTimeout(() => {
        this.scene.remove(puff);
        disposeObject3D(puff);
      }, 250);
    }
  }

  private reload() {
    // Ölü bir oyuncu şarjör değiştiremez — önceden bu kontrol yoktu; ölü
    // karakter üzerinde `isReloading` durumu anlamsız şekilde değişebiliyordu.
    if (this.state.isDead) return;
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
    // NOT: Önceki sürümde `weaponModel: THREE.Group | null` alanı ve onu
    // kaldıran ölü (hiçbir yerde atanmayan) kontrol kodu vardı — HUD artık
    // 2D silah görseli kullandığı için bu alan/kontrol tamamen kullanılmayan
    // "junk code" idi; kaldırıldı.
    const def = WEAPONS[id];
    if (!def) return;

    if (!this.camera.parent) this.scene.add(this.camera); // ensure attached
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
    // Scope FOV lerp (silah 2D HUD'da)
    const targetFov = this.isScoped && WEAPONS[this.state.weaponId].scope ? 22 : 75;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, dt * 12);
      this.camera.updateProjectionMatrix();
    }
  }

  public takeDamage(amount: number, sourceId: string) {
    if (this.state.isDead) return;
    // Negatif/NaN/Infinity bir `amount` (ör. bozuk ağ paketi veya hesaplama
    // hatası) canın MAX_HEALTH üzerine çıkmasına ya da tanımsız davranışa yol
    // açabilirdi — eski kod yalnızca `Math.max(0, ...)` ile ALT sınırı koruyordu,
    // ÜST sınır hiç yoktu. Artık hem giriş doğrulanıyor hem de [0, MAX_HEALTH]
    // aralığına sıkıştırılıyor.
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.state.health = THREE.MathUtils.clamp(this.state.health - amount, 0, MAX_HEALTH);
    gameAudio.hit();
    if (this.state.health <= 0) this.die(sourceId);
  }

  private die(killerId: string) {
    this.state.isDead = true;
    this.state.deaths++;
    // Ölüm anında birikmiş tepme durumunu temizle — aksi halde respawn()
    // sonrası kamera, ölmeden önce biriken recoilPitch/recoilYaw değerlerini
    // "toparlamaya" çalışarak kendiliğinden sürüklenir (respawn() içinde de
    // ayrıca sıfırlanıyor, burada da erken temizlemek update() döngüsünün
    // ölüm anındaki son karesinde tutarsız bir toparlanma denemesini önler).
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.consecutiveShots = 0;
    try { this.unlockPointer(); } catch { /* ignore */ }
    this.callbacks.onDeath(killerId, this.playerId, this.state.weaponId);
    this.scheduleTimeout(() => this.respawn(), RESPAWN_TIME);
  }

  public respawn() {
    const spawn = this.getSpawnPoint();
    this.camera.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = Math.atan2(-spawn.x, -spawn.z);
    this.pitch = 0;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    // Bkz. die() — kalan tepme durumu sıfırlanmazsa yeni spawn'da kamera
    // kendiliğinden hareket eder (updateRecoilRecovery eski değerleri "toparlamaya"
    // çalışır). Burada da güvence altına alınıyor.
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.consecutiveShots = 0;
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
    const teamColor = state.team === 't' ? COLORS.t : COLORS.ct;
    const uniformMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.75, metalness: 0.0, envMapIntensity: 0.15 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.1 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b088, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.08 });
    // Taktik yelek: yarı-sert polimer görünümü için clearcoat (üstte ince, pürüzsüz bir kaplama) kullanılır
    const vestMat = new THREE.MeshPhysicalMaterial({
      color: 0x1a1a1a,
      roughness: 0.45,
      metalness: 0.15,
      clearcoat: 0.55,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.8,
    });

    // Bacaklar
    const legGeo = new THREE.BoxGeometry(0.22, 0.85, 0.22);
    const leftLeg = new THREE.Mesh(legGeo, pantsMat);
    leftLeg.position.set(-0.12, 0.42, 0); leftLeg.userData.playerId = state.id;
    const rightLeg = new THREE.Mesh(legGeo, pantsMat);
    rightLeg.position.set(0.12, 0.42, 0); rightLeg.userData.playerId = state.id;
    // Gövde
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.32), uniformMat);
    torso.position.y = 1.15; torso.userData.playerId = state.id;
    // Yelek
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.42, 0.34), vestMat);
    vest.position.y = 1.15; vest.userData.playerId = state.id;
    // Kollar
    const armGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
    const leftArm = new THREE.Mesh(armGeo, uniformMat);
    leftArm.position.set(-0.36, 1.15, 0); leftArm.userData.playerId = state.id;
    const rightArm = new THREE.Mesh(armGeo, uniformMat);
    rightArm.position.set(0.36, 1.15, 0); rightArm.userData.playerId = state.id;
    // Boyun + Kafa
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.15), skinMat);
    neck.position.y = 1.5; neck.userData.playerId = state.id;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), skinMat);
    head.position.y = 1.72; head.userData.playerId = state.id;
    // İsimle etiketleniyor ki updateRemotePlayer() sihirli bir children[7]
    // index'ine güvenmek yerine bu mesh'i güvenle bulabilsin (bkz. aşağıda).
    head.name = 'head';
    // Kask
    const helmet = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.14, 0.34),
      new THREE.MeshStandardMaterial({
        color: state.team === 't' ? 0x552211 : 0x1a2f5a,
        roughness: 0.4,
        metalness: 0.35,
        envMapIntensity: 0.9,
      }),
    );
    helmet.position.y = 1.9; helmet.userData.playerId = state.id;

    group.add(leftLeg, rightLeg, torso, vest, leftArm, rightArm, neck, head, helmet);

    // Silah
    const weaponMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.1, 0.65),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.75, roughness: 0.28, envMapIntensity: 1.1 }),
    );
    weaponMesh.position.set(0.28, 1.2, 0.35);
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
    // Vuruş hedef önbelleği artık geçersiz — bir sonraki atışta yeniden kurulacak.
    this.hitTargetsDirty = true;
  }

  public updateRemotePlayer(state: PlayerState) {
    let rp = this.remotePlayers.get(state.id);
    if (!rp) { this.addRemotePlayer(state); rp = this.remotePlayers.get(state.id)!; }
    rp.state = state;
    rp.targetPosition.set(state.position.x, 0, state.position.z);
    rp.targetRotation.x = state.rotation.x;
    rp.targetRotation.y = state.rotation.y;
    // Eskiden `rp.mesh.children[7]` — grup çocuklarının ekleniş sırasına bağlı
    // sihirli bir index'ti; gövde parçalarının ekleme sırası değişirse (ör. yeni
    // bir aksesuar eklenirse) SESSİZCE yanlış mesh'i döndürür, derleme hatası
    // vermez, sadece kafa dönüşü bozulur. İsimle arama, bu sınıf hatasını
    // yapısal olarak imkansız kılar.
    const head = rp.mesh.getObjectByName('head');
    if (head) head.rotation.x = state.rotation.x;
  }

  public removeRemotePlayer(id: string) {
    const rp = this.remotePlayers.get(id);
    if (rp) {
      this.scene.remove(rp.mesh);
      disposeObject3D(rp.mesh); // Önceden dispose edilmiyordu -> GPU bellek sızıntısı
      this.remotePlayers.delete(id);
      this.hitTargetsDirty = true;
    }
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
