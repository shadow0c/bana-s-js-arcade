// src/lib/game/inspector/Inspector.ts
//
// GENEL AMAÇLI SAHNE INSPECTOR'I (editör aracı, gameplay sistemi DEĞİL).
//
// Yapabildikleri:
//  - Küp (primitive) ekleme, TransformControls gizmo'suyla taşıma/döndürme/ölçekleme
//  - glTF/GLB model import + "derleme" (üçgen sayısı, malzeme sayısı, doku belleği
//    tahmini raporlanır; bounding box'tan otomatik çarpışma kutusu üretilir;
//    isteğe bağlı "auto-fit" ile aşırı büyük/küçük import'lar normalize edilir)
//  - Doku (PNG/JPG) import edip seçili nesnenin materyaline `map` olarak uygulama
//  - Seçili nesnenin rengini (materyal.color) ve metalness/roughness'ını
//    (bkz. materials.ts - GGX tabanlı PBR) canlı düzenleme
//  - Sağ-tık sürükle ile serbest bakış (engine'in yaw/pitch'iyle senkron)
//
// ÖNEMLİ SÜRÜM NOTU (dürüstlük için açıkça yazıyorum): Bu sohbette şu an canlı
// web erişimim yok, bu yüzden `three@0.185.1` ile birlikte gelen
// `TransformControls`'un TAM API şeklini (özellikle `getHelper()` ayrımının bu
// sürümde olup olmadığını) çalışma zamanında doğrulayamadım. Kod, her iki
// olası API şekli için de feature-detection (özellik sınaması) yapıyor —
// ama `npm install` sonrası konsolda bir uyarı görürsen three.js'in kendi
// TransformControls örneğine (three.js repo, examples/webgl_controls_transform)
// bakıp import/attach satırlarını karşılaştırman önerilir.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import GUI from 'lil-gui';
import type { GameEngine } from '../engine';
import { createBoardMaterial } from '../materials';

const LOOK_SENSITIVITY = 0.0026;
// Google'ın resmi, sürümlenmiş Draco decoder CDN'i - three.js örneklerinde
// standart olarak kullanılan, kararlı bir yol (uzun süredir değişmedi).
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

interface InspectorEntry {
  object: THREE.Object3D;
  colliderBox: THREE.Box3 | null;
  isWallRegistered: boolean;
  kind: 'cube' | 'importedModel';
}

/** Bir Object3D alt ağacındaki geometri/materyal/doku belleğini serbest bırakır. */
function disposeSubtree(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const tex = (mat as unknown as Record<string, unknown>)[key];
        if (tex instanceof THREE.Texture) tex.dispose();
      }
      mat.dispose();
    }
  });
}

function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    if (geo.index) tris += geo.index.count / 3;
    else if (geo.attributes.position) tris += geo.attributes.position.count / 3;
  });
  return Math.round(tris);
}

function estimateTextureBytes(root: THREE.Object3D): number {
  let bytes = 0;
  const seen = new Set<THREE.Texture>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (!mat) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const tex = (mat as unknown as Record<string, unknown>)[key];
        if (tex instanceof THREE.Texture && tex.image && !seen.has(tex)) {
          seen.add(tex);
          const w = tex.image.width ?? 0;
          const h = tex.image.height ?? 0;
          bytes += w * h * 4; // RGBA8 varsayımı - mipmap'ler hariç, kaba bir alt sınır tahmini
        }
      }
    }
  });
  return bytes;
}

export class SceneInspector {
  private readonly engine: GameEngine;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly domElement: HTMLElement;

  private active = false;
  private gui: GUI | null = null;
  private transformControls: TransformControls | null = null;
  private gizmoHelper: THREE.Object3D | null = null;

  private readonly entries: InspectorEntry[] = [];
  private selected: THREE.Object3D | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNDC = new THREE.Vector2();

  private isLooking = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private pointerDownX = 0;
  private pointerDownY = 0;

  private gltfLoader: GLTFLoader | null = null;

  // GUI'nin bağlı olduğu canlı proxy nesneler (lil-gui bir alanı, o alanın
  // sahip nesnesinden bağımsız olarak DOĞRUDAN referansladığı için, seçili
  // nesne değiştikçe kontrolleri yeniden kurmak yerine proxy'yi senkronluyoruz).
  private readonly transformProxy = { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 };
  private readonly materialProxy = { color: '#ffffff', metalness: 0, roughness: 0.8 };
  private readonly statusProxy = { status: 'Hazır.' };

  private syncRafId: number | null = null;

  constructor(engine: GameEngine) {
    this.engine = engine;
    this.scene = engine.getScene();
    this.camera = engine.getCamera();
    this.renderer = engine.getRenderer();
    this.domElement = this.renderer.domElement;
  }

  get isActive() { return this.active; }

  open() {
    if (this.active) return;
    this.active = true;
    this.engine.setInspectorModeActive(true);

    this.buildGizmo();
    this.buildGUI();
    this.attachDomListeners();
    this.runSyncLoop();
  }

  close() {
    if (!this.active) return;
    this.active = false;
    this.engine.setInspectorModeActive(false);

    this.detachDomListeners();
    if (this.syncRafId !== null) cancelAnimationFrame(this.syncRafId);
    this.syncRafId = null;

    this.gui?.destroy();
    this.gui = null;

    if (this.transformControls) {
      this.transformControls.detach();
      if (this.gizmoHelper) this.scene.remove(this.gizmoHelper);
      else this.scene.remove(this.transformControls as unknown as THREE.Object3D);
      this.transformControls.dispose();
      this.transformControls = null;
      this.gizmoHelper = null;
    }
  }

  toggle() {
    if (this.active) this.close();
    else this.open();
  }

  /** Editörün yarattığı TÜM nesneleri sahneden kaldırır ve belleği serbest bırakır. */
  disposeAll() {
    for (const entry of [...this.entries]) this.removeEntry(entry);
  }

  // ---------------------------------------------------------------- GIZMO --

  private buildGizmo() {
    const controls = new TransformControls(this.camera, this.domElement);
    controls.setSize(0.9);

    // three.js sürümüne göre iki olası API: yeni sürümlerde görsel gizmo
    // `controls.getHelper()` ile ayrı bir Object3D olarak alınır; eski
    // sürümlerde `controls` doğrudan sahneye eklenebilir bir Object3D'dir.
    const maybeGetHelper = (controls as unknown as { getHelper?: () => THREE.Object3D }).getHelper;
    if (typeof maybeGetHelper === 'function') {
      this.gizmoHelper = maybeGetHelper.call(controls);
      this.scene.add(this.gizmoHelper);
    } else {
      this.scene.add(controls as unknown as THREE.Object3D);
    }

    controls.addEventListener('dragging-changed', (event: { value: unknown }) => {
      // Gizmo sürüklenirken serbest-bakış (right-drag) çakışmasın.
      this.isLooking = this.isLooking && !event.value;
    });

    controls.addEventListener('objectChange', () => {
      if (this.selected) this.syncColliderFromObject(this.selected);
    });

    this.transformControls = controls;
  }

  // ------------------------------------------------------------------ GUI --

  private buildGUI() {
    const gui = new GUI({ title: 'Sahne Inspector' });
    this.gui = gui;

    gui.add(this.statusProxy, 'status').name('Durum').listen().disable();

    const addFolder = gui.addFolder('Ekle');
    addFolder.add({ addCube: () => this.addCube() }, 'addCube').name('+ Küp Ekle');

    const importFolder = gui.addFolder('Asset Import');
    importFolder.add({ importModel: () => this.promptImportFile('.glb,.gltf') }, 'importModel').name('Model içe aktar (.glb/.gltf)');
    importFolder.add({ importTexture: () => this.promptImportFile('image/png,image/jpeg,image/webp') }, 'importTexture').name('Doku içe aktar (seçili nesneye)');
    importFolder.add({ autoFit: true }, 'autoFit').name('Auto-fit (import sonrası ~2m normalize et)')
      .onChange((v: boolean) => { this.autoFitEnabled = v; });

    const transformFolder = gui.addFolder('Transform (seçili)');
    transformFolder.add(this.transformProxy, 'posX', -60, 60, 0.05).name('Konum X').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'posY', -5, 20, 0.05).name('Konum Y').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'posZ', -60, 60, 0.05).name('Konum Z').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'rotY', -180, 180, 1).name('Döndür Y°').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'scaleX', 0.05, 10, 0.05).name('Ölçek X').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'scaleY', 0.05, 10, 0.05).name('Ölçek Y').listen().onChange(() => this.applyTransformProxy());
    transformFolder.add(this.transformProxy, 'scaleZ', 0.05, 10, 0.05).name('Ölçek Z').listen().onChange(() => this.applyTransformProxy());

    const materialFolder = gui.addFolder('Malzeme (GGX/PBR)');
    materialFolder.addColor(this.materialProxy, 'color').name('Renk').onChange(() => this.applyMaterialProxy());
    materialFolder.add(this.materialProxy, 'metalness', 0, 1, 0.01).name('Metalness').onChange(() => this.applyMaterialProxy());
    materialFolder.add(this.materialProxy, 'roughness', 0, 1, 0.01).name('Roughness').onChange(() => this.applyMaterialProxy());

    const modeFolder = gui.addFolder('Gizmo Modu (W/E/R)');
    modeFolder.add({ move: () => this.transformControls?.setMode('translate') }, 'move').name('Taşı (W)');
    modeFolder.add({ rotate: () => this.transformControls?.setMode('rotate') }, 'rotate').name('Döndür (E)');
    modeFolder.add({ scale: () => this.transformControls?.setMode('scale') }, 'scale').name('Ölçekle (R)');

    gui.add({ deleteSelected: () => this.deleteSelected() }, 'deleteSelected').name('Seçiliyi Sil (Del)');
    gui.add({ close: () => this.close() }, 'close').name('Inspector\'ı Kapat (~)');
  }

  private autoFitEnabled = true;

  // ------------------------------------------------------------ SELECTION --

  private selectableObjects(): THREE.Object3D[] {
    return [...this.entries.map((e) => e.object), ...this.engine.getWallMeshes()];
  }

  select(object: THREE.Object3D | null) {
    this.selected = object;
    if (this.transformControls) {
      if (object) this.transformControls.attach(object);
      else this.transformControls.detach();
    }
    if (object) this.syncTransformProxyFromObject(object);
    this.syncMaterialProxyFromObject(object);
  }

  private syncTransformProxyFromObject(object: THREE.Object3D) {
    this.transformProxy.posX = object.position.x;
    this.transformProxy.posY = object.position.y;
    this.transformProxy.posZ = object.position.z;
    this.transformProxy.rotX = THREE.MathUtils.radToDeg(object.rotation.x);
    this.transformProxy.rotY = THREE.MathUtils.radToDeg(object.rotation.y);
    this.transformProxy.rotZ = THREE.MathUtils.radToDeg(object.rotation.z);
    this.transformProxy.scaleX = object.scale.x;
    this.transformProxy.scaleY = object.scale.y;
    this.transformProxy.scaleZ = object.scale.z;
  }

  private applyTransformProxy() {
    if (!this.selected) return;
    this.selected.position.set(this.transformProxy.posX, this.transformProxy.posY, this.transformProxy.posZ);
    this.selected.rotation.set(
      THREE.MathUtils.degToRad(this.transformProxy.rotX),
      THREE.MathUtils.degToRad(this.transformProxy.rotY),
      THREE.MathUtils.degToRad(this.transformProxy.rotZ),
    );
    this.selected.scale.set(this.transformProxy.scaleX, this.transformProxy.scaleY, this.transformProxy.scaleZ);
    this.syncColliderFromObject(this.selected);
  }

  private firstStandardMaterial(object: THREE.Object3D): THREE.MeshStandardMaterial | null {
    let found: THREE.MeshStandardMaterial | null = null;
    object.traverse((child) => {
      if (found) return;
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if ((mat as THREE.MeshStandardMaterial)?.isMeshStandardMaterial) found = mat as THREE.MeshStandardMaterial;
    });
    return found;
  }

  private syncMaterialProxyFromObject(object: THREE.Object3D | null) {
    const mat = object ? this.firstStandardMaterial(object) : null;
    if (!mat) return;
    this.materialProxy.color = `#${mat.color.getHexString()}`;
    this.materialProxy.metalness = mat.metalness;
    this.materialProxy.roughness = mat.roughness;
  }

  private applyMaterialProxy() {
    if (!this.selected) return;
    this.selected.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std?.isMeshStandardMaterial) continue;
        std.color.set(this.materialProxy.color);
        std.metalness = this.materialProxy.metalness;
        std.roughness = this.materialProxy.roughness;
      }
    });
  }

  // --------------------------------------------------------------- ACTIONS --

  private spawnPositionInFrontOfCamera(distance = 3): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return this.camera.position.clone().addScaledVector(dir, distance);
  }

  addCube() {
    const material = createBoardMaterial(undefined, 0.3);
    material.color.set(0xcccccc);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(this.spawnPositionInFrontOfCamera());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.__inspectorManaged = true;
    this.scene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    this.engine.registerCollider(box);
    this.engine.registerWallMesh(mesh); // mermi ile de vurulabilsin/delik açılabilsin diye

    this.entries.push({ object: mesh, colliderBox: box, isWallRegistered: true, kind: 'cube' });
    this.select(mesh);
    this.statusProxy.status = 'Küp eklendi.';
  }

  private syncColliderFromObject(object: THREE.Object3D) {
    const entry = this.entries.find((e) => e.object === object);
    if (!entry || !entry.colliderBox) return;
    entry.colliderBox.setFromObject(object);
  }

  deleteSelected() {
    if (!this.selected) return;
    const entry = this.entries.find((e) => e.object === this.selected);
    if (!entry) {
      this.statusProxy.status = 'Bu nesne inspector tarafından yönetilmiyor, silinemez (ör. harita duvarı).';
      return;
    }
    this.removeEntry(entry);
    this.select(null);
    this.statusProxy.status = 'Silindi.';
  }

  private removeEntry(entry: InspectorEntry) {
    this.scene.remove(entry.object);
    disposeSubtree(entry.object);
    if (entry.colliderBox) this.engine.unregisterCollider(entry.colliderBox);
    if (entry.isWallRegistered && entry.object instanceof THREE.Mesh) {
      this.engine.unregisterWallMesh(entry.object);
    } else if (entry.isWallRegistered) {
      // Grup (import edilmiş model) - içindeki tüm mesh'ler wallMesh olarak eklenmiş olabilir.
      entry.object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) this.engine.unregisterWallMesh(child as THREE.Mesh);
      });
    }
    const idx = this.entries.indexOf(entry);
    if (idx > -1) this.entries.splice(idx, 1);
  }

  // ------------------------------------------------------------ ASSET I/O --

  private ensureGltfLoader(): GLTFLoader {
    if (this.gltfLoader) return this.gltfLoader;
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER_PATH);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    this.gltfLoader = loader;
    return loader;
  }

  private promptImportFile(accept: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.handleImportedFile(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  private async handleImportedFile(file: File) {
    const isImage = file.type.startsWith('image/');
    const isModel = /\.(glb|gltf)$/i.test(file.name);

    if (isImage) {
      await this.importTextureFile(file);
    } else if (isModel) {
      await this.importModelFile(file);
    } else {
      this.statusProxy.status = `Desteklenmeyen dosya türü: ${file.name}`;
    }
  }

  private async importTextureFile(file: File) {
    if (!this.selected) {
      this.statusProxy.status = 'Önce bir nesne seç, sonra doku import et.';
      return;
    }
    const mat = this.firstStandardMaterial(this.selected);
    if (!mat) {
      this.statusProxy.status = 'Seçili nesnede MeshStandardMaterial yok - doku uygulanamadı.';
      return;
    }

    const url = URL.createObjectURL(file);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      mat.map?.dispose();
      mat.map = texture;
      mat.needsUpdate = true;
      this.statusProxy.status = `Doku uygulandı: ${file.name}`;
    } catch (err) {
      this.statusProxy.status = `Doku yüklenemedi: ${(err as Error).message}`;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async importModelFile(file: File) {
    this.statusProxy.status = `İçe aktarılıyor: ${file.name}...`;
    const buffer = await file.arrayBuffer();
    const loader = this.ensureGltfLoader();

    loader.parse(
      buffer,
      '',
      (gltf) => {
        const root = new THREE.Group();
        root.add(gltf.scene);
        root.userData.__inspectorManaged = true;

        // ---- "DERLEME" (compile) RAPORU ----
        const triangles = countTriangles(root);
        const textureBytes = estimateTextureBytes(root);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());

        if (this.autoFitEnabled) {
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const targetSize = 2.0;
          const scale = targetSize / maxDim;
          root.scale.setScalar(scale);
        }

        root.position.copy(this.spawnPositionInFrontOfCamera(4));
        this.scene.add(root);

        const finalBox = new THREE.Box3().setFromObject(root);
        this.engine.registerCollider(finalBox);
        root.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) this.engine.registerWallMesh(child as THREE.Mesh);
        });

        this.entries.push({ object: root, colliderBox: finalBox, isWallRegistered: true, kind: 'importedModel' });
        this.select(root);

        this.statusProxy.status =
          `Import OK: ${file.name} | ${triangles.toLocaleString('tr-TR')} üçgen | ` +
          `~${(textureBytes / (1024 * 1024)).toFixed(1)} MB doku | boyut ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}m`;
      },
      (err) => {
        this.statusProxy.status = `Model parse hatası: ${(err as Error).message ?? err}`;
      },
    );
  }

  // ---------------------------------------------------------- DOM/INPUT --

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.active) return;
    switch (e.key) {
      case '`': this.close(); break;
      case 'w': case 'W': this.transformControls?.setMode('translate'); break;
      case 'e': case 'E': this.transformControls?.setMode('rotate'); break;
      case 'r': case 'R': this.transformControls?.setMode('scale'); break;
      case 'Delete': case 'Backspace': this.deleteSelected(); break;
      case 'Escape': this.select(null); break;
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.button === 2) {
      this.isLooking = true;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      return;
    }
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.active) return;
    if (e.button === 2) { this.isLooking = false; return; }

    const movedDist = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
    const draggingGizmo = (this.transformControls as unknown as { dragging?: boolean } | null)?.dragging;
    if (movedDist > 5 || draggingGizmo) return; // sürükleme oldu, tıklama değil -> seçim yapma

    const rect = this.domElement.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this.selectableObjects(), true);
    if (hits.length > 0) {
      let obj: THREE.Object3D | null = hits[0].object;
      // İçe aktarılan modellerde tıklanan alt-mesh yerine, inspector'ın yönettiği
      // üst-grup (wrapper) seçilmeli - o yüzden yukarı doğru en yakın işaretli atayı bul.
      while (obj && !obj.userData.__inspectorManaged && obj.parent) obj = obj.parent;
      this.select(obj && obj.userData.__inspectorManaged ? obj : hits[0].object);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.active || !this.isLooking) return;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    const { yaw, pitch } = this.engine.getYawPitch();
    this.engine.setYawPitch(yaw - dx * LOOK_SENSITIVITY, pitch - dy * LOOK_SENSITIVITY);
  };

  private attachDomListeners() {
    window.addEventListener('keydown', this.onKeyDown);
    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.domElement.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('pointermove', this.onPointerMove);
  }

  private detachDomListeners() {
    window.removeEventListener('keydown', this.onKeyDown);
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('pointermove', this.onPointerMove);
  }

  // GUI proxy'yi (özellikle TransformControls gizmo'suyla canlı sürüklerken
  // değişen konum/rotasyon/ölçek) senkron tutan hafif bir döngü. Render
  // yapmaz (renderer.render bunu zaten engine'in kendi rAF'ı çağırıyor),
  // sadece sayısal alanları günceller - maliyeti ihmal edilebilir düzeydedir.
  private runSyncLoop = () => {
    if (!this.active) return;
    if (this.selected) this.syncTransformProxyFromObject(this.selected);
    this.syncRafId = requestAnimationFrame(this.runSyncLoop);
  };
}
