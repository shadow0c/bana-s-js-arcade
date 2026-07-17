// src/lib/editor/EditorEngine.ts
//
// UE5/Unity tarzı editörün "viewport" katmanı. Kasıtlı olarak GameEngine'den
// (src/lib/game/engine.ts) TAMAMEN BAĞIMSIZ: kendi THREE.Scene, kendi
// PerspectiveCamera + OrbitControls, kendi renderer'ı vardır. Bu iki dosya
// birbirini import ETMEZ — editör, oyunun içine gömülü bir katman değil, ayrı
// bir uygulamadır. Köprü yalnızca `levelSchema.ts` üzerinden veri (JSON /
// MAP_WALLS kaynak kodu) seviyesinde kurulur, çalışma zamanı nesnesi seviyesinde
// DEĞİL.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  type LevelData, type LevelEntity, type BoxEntity, type SpawnPointEntity,
  type BombsiteEntity, type LightEntity, type ModelEntity,
  createEmptyLevel, generateEntityId,
} from './levelSchema';
import { AssetLibrary } from './AssetLibrary';

type TransformMode = 'translate' | 'rotate' | 'scale';

interface SceneNode {
  entity: LevelEntity;
  object3D: THREE.Object3D;
  helperLight?: THREE.PointLight;
}

const TEAM_COLOR = { t: 0xd9822b, ct: 0x2b6fd9 } as const;

export class EditorEngine {
  public readonly assets = new AssetLibrary();

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private orbit!: OrbitControls;
  private transformControls!: TransformControls;
  private gizmoHelper: THREE.Object3D | null = null;

  private grid!: THREE.GridHelper;
  private raycaster = new THREE.Raycaster();
  private pointerNDC = new THREE.Vector2();

  private nodes = new Map<string, SceneNode>();
  private level: LevelData = createEmptyLevel();
  private selectedId: string | null = null;

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  public onSelectionChange: ((entity: LevelEntity | null) => void) | null = null;
  public onLevelChange: ((level: LevelData) => void) | null = null;

  mount(container: HTMLElement) {
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x1a1d23, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x1a1d23, 60, 160);

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 500);
    this.camera.position.set(12, 10, 12);
    this.camera.lookAt(0, 0, 0);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.update();

    const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(20, 30, 10);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(140, 70, 0x555555, 0x333333);
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(2));

    this.setupTransformControls();
    this.attachDomListeners();
    this.observeResize(container);
    this.loop();
  }

  unmount() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.resizeObserver?.disconnect();
    this.detachDomListeners();
    this.transformControls.dispose();
    this.clearAllEntities();
    this.assets.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private setupTransformControls() {
    const controls = new TransformControls(this.camera, this.renderer.domElement);
    controls.setSize(0.9);

    // three sürümüne göre iki olası şekil: yeni sürümlerde görsel gizmo
    // `getHelper()` ile ayrı alınır; eski sürümlerde controls doğrudan
    // sahneye eklenebilir bir Object3D'dir. (Bkz. önceki mesajdaki sürüm notu
    // - bu sohbette hâlâ canlı doğrulama yapamıyorum, feature-detect ediyorum.)
    const maybeGetHelper = (controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    if (typeof maybeGetHelper === 'function') {
      this.gizmoHelper = maybeGetHelper.call(controls);
      this.scene.add(this.gizmoHelper);
    } else {
      this.scene.add(controls as unknown as THREE.Object3D);
    }

    controls.addEventListener('dragging-changed', (event: { value: unknown }) => {
      this.orbit.enabled = !event.value;
    });
    controls.addEventListener('objectChange', () => {
      if (this.selectedId) this.syncEntityFromObject3D(this.selectedId);
    });

    this.transformControls = controls;
  }

  setTransformMode(mode: TransformMode) {
    this.transformControls.setMode(mode);
  }

  // ------------------------------------------------------------ RENDER LOOP --

  private loop = () => {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.loop);
  };

  private observeResize(container: HTMLElement) {
    this.resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeObserver.observe(container);
  }

  // ------------------------------------------------------------- SELECTION --

  private onPointerDownPos = { x: 0, y: 0 };

  private onPointerDown = (e: PointerEvent) => {
    this.onPointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    const moved = Math.hypot(e.clientX - this.onPointerDownPos.x, e.clientY - this.onPointerDownPos.y);
    const dragging = (this.transformControls as unknown as { dragging?: boolean }).dragging;
    if (moved > 5 || dragging) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const selectableRoots = [...this.nodes.values()].map((n) => n.object3D);
    const hits = this.raycaster.intersectObjects(selectableRoots, true);
    if (hits.length === 0) {
      this.select(null);
      return;
    }
    let obj: THREE.Object3D | null = hits[0].object;
    while (obj && !obj.userData.__entityId && obj.parent) obj = obj.parent;
    const id = obj?.userData.__entityId as string | undefined;
    this.select(id ?? null);
  };

  private attachDomListeners() {
    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
  }

  private detachDomListeners() {
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
  }

  select(id: string | null) {
    this.selectedId = id;
    const node = id ? this.nodes.get(id) : null;
    if (node) this.transformControls.attach(node.object3D);
    else this.transformControls.detach();
    this.onSelectionChange?.(node?.entity ?? null);
  }

  getSelectedId() { return this.selectedId; }

  // -------------------------------------------------------------- ENTITIES --

  loadLevel(level: LevelData) {
    this.clearAllEntities();
    this.level = level;
    for (const entity of level.entities) this.instantiateEntity(entity);
    this.onLevelChange?.(this.level);
  }

  getLevel(): LevelData {
    return this.level;
  }

  newLevel(name: string) {
    this.loadLevel(createEmptyLevel(name));
  }

  private clearAllEntities() {
    for (const id of [...this.nodes.keys()]) this.removeEntity(id);
  }

  private spawnPositionInFrontOfCamera(distance = 6): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const p = this.camera.position.clone().addScaledVector(dir, distance);
    p.y = 0.5;
    return p;
  }

  addBox(solid = true): BoxEntity {
    const pos = this.spawnPositionInFrontOfCamera();
    const entity: BoxEntity = {
      id: generateEntityId(),
      name: solid ? 'Duvar/Kutu' : 'Prop',
      kind: 'box',
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotationY: 0,
      scale: { x: 2, y: 2, z: 2 },
      color: '#8a8f98',
      metalness: 0.05,
      roughness: 0.85,
      solid,
    };
    this.addEntityToLevel(entity);
    return entity;
  }

  addSpawnPoint(team: 't' | 'ct'): SpawnPointEntity {
    const pos = this.spawnPositionInFrontOfCamera(4);
    const entity: SpawnPointEntity = {
      id: generateEntityId(),
      name: team === 't' ? 'T Spawn' : 'CT Spawn',
      kind: 'spawnPoint',
      position: { x: pos.x, y: 0.05, z: pos.z },
      rotationY: 0,
      scale: { x: 1, y: 1, z: 1 },
      team,
    };
    this.addEntityToLevel(entity);
    return entity;
  }

  addBombsite(label: string): BombsiteEntity {
    const pos = this.spawnPositionInFrontOfCamera(4);
    const entity: BombsiteEntity = {
      id: generateEntityId(),
      name: `Bombsite ${label}`,
      kind: 'bombsite',
      position: { x: pos.x, y: 0.02, z: pos.z },
      rotationY: 0,
      scale: { x: 1, y: 1, z: 1 },
      label,
      radius: 3,
    };
    this.addEntityToLevel(entity);
    return entity;
  }

  addLight(): LightEntity {
    const pos = this.spawnPositionInFrontOfCamera(4);
    const entity: LightEntity = {
      id: generateEntityId(),
      name: 'Işık',
      kind: 'light',
      position: { x: pos.x, y: 3, z: pos.z },
      rotationY: 0,
      scale: { x: 1, y: 1, z: 1 },
      color: '#ffe0b0',
      intensity: 2,
      distance: 15,
    };
    this.addEntityToLevel(entity);
    return entity;
  }

  addModelInstance(assetId: string, assetName: string): ModelEntity | null {
    const clone = this.assets.instantiateModel(assetId);
    if (!clone) return null;
    const pos = this.spawnPositionInFrontOfCamera(5);
    const entity: ModelEntity = {
      id: generateEntityId(),
      name: assetName,
      kind: 'model',
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotationY: 0,
      scale: { x: 1, y: 1, z: 1 },
      assetId,
      assetName,
    };
    this.addEntityToLevel(entity);
    return entity;
  }

  private addEntityToLevel(entity: LevelEntity) {
    this.level.entities.push(entity);
    this.instantiateEntity(entity);
    this.select(entity.id);
    this.onLevelChange?.(this.level);
  }

  removeEntity(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (this.selectedId === id) this.select(null);
    this.scene.remove(node.object3D);
    node.object3D.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
      }
    });
    this.nodes.delete(id);
    this.level.entities = this.level.entities.filter((e) => e.id !== id);
    this.onLevelChange?.(this.level);
  }

  removeSelected() {
    if (this.selectedId) this.removeEntity(this.selectedId);
  }

  private instantiateEntity(entity: LevelEntity) {
    let object3D: THREE.Object3D;
    let helperLight: THREE.PointLight | undefined;

    switch (entity.kind) {
      case 'box': {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({
          color: entity.color, metalness: entity.metalness, roughness: entity.roughness,
          transparent: !entity.solid, opacity: entity.solid ? 1 : 0.55,
        });
        object3D = new THREE.Mesh(geo, mat);
        object3D.castShadow = true;
        object3D.receiveShadow = true;
        break;
      }
      case 'spawnPoint': {
        const group = new THREE.Group();
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.4, 1.2, 12),
          new THREE.MeshStandardMaterial({ color: TEAM_COLOR[entity.team], emissive: TEAM_COLOR[entity.team], emissiveIntensity: 0.4 }),
        );
        cone.position.y = 0.6;
        group.add(cone);
        object3D = group;
        break;
      }
      case 'bombsite': {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(entity.radius - 0.15, entity.radius, 32),
          new THREE.MeshBasicMaterial({ color: 0xff3b30, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
        );
        ring.rotation.x = -Math.PI / 2;
        object3D = ring;
        break;
      }
      case 'light': {
        const group = new THREE.Group();
        helperLight = new THREE.PointLight(entity.color, entity.intensity, entity.distance);
        group.add(helperLight);
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.15, 12, 12),
          new THREE.MeshBasicMaterial({ color: entity.color }),
        );
        group.add(bulb);
        object3D = group;
        break;
      }
      case 'model': {
        const clone = this.assets.instantiateModel(entity.assetId);
        object3D = clone ?? new THREE.Group(); // asset bulunamazsa boş bir tutucu (çökme yok)
        break;
      }
    }

    object3D.position.set(entity.position.x, entity.position.y, entity.position.z);
    object3D.rotation.y = THREE.MathUtils.degToRad(entity.rotationY);
    object3D.scale.set(entity.scale.x, entity.scale.y, entity.scale.z);
    object3D.userData.__entityId = entity.id;

    this.scene.add(object3D);
    this.nodes.set(entity.id, { entity, object3D, helperLight });
  }

  /** TransformControls gizmo sürüklenirken çağrılır - entity verisini object3D'den senkronlar. */
  private syncEntityFromObject3D(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    const { entity, object3D } = node;
    entity.position = { x: object3D.position.x, y: object3D.position.y, z: object3D.position.z };
    entity.rotationY = THREE.MathUtils.radToDeg(object3D.rotation.y);
    entity.scale = { x: object3D.scale.x, y: object3D.scale.y, z: object3D.scale.z };
    this.onLevelChange?.(this.level);
  }

  /** Inspector panelinden (sayısal alanlar) gelen güncellemeyi hem entity'ye hem object3D'ye yazar. */
  applyEntityUpdate(id: string, patch: Partial<LevelEntity>) {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node.entity, patch);
    const { entity, object3D } = node;

    object3D.position.set(entity.position.x, entity.position.y, entity.position.z);
    object3D.rotation.y = THREE.MathUtils.degToRad(entity.rotationY);
    object3D.scale.set(entity.scale.x, entity.scale.y, entity.scale.z);

    if (entity.kind === 'box') {
      const mesh = object3D as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.set(entity.color);
      mat.metalness = entity.metalness;
      mat.roughness = entity.roughness;
      mat.transparent = !entity.solid;
      mat.opacity = entity.solid ? 1 : 0.55;
    } else if (entity.kind === 'light' && node.helperLight) {
      node.helperLight.color.set(entity.color);
      node.helperLight.intensity = entity.intensity;
      node.helperLight.distance = entity.distance;
    }

    this.onLevelChange?.(this.level);
  }
}
