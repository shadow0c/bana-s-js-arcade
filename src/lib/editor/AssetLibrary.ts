// src/lib/editor/AssetLibrary.ts
//
// İçe aktarılan (import edilen) asset'leri tutar. "Derleme" burada şu anlama
// gelir: bir glTF/GLB dosyası parse edildikten sonra üçgen sayısı, doku
// belleği ve bounding-box gibi ölçümler çıkarılır ve rapor olarak saklanır —
// bu, seviyeye o asset'ten kaç tane yerleştirilirse yerleştirilsin TEK SEFERLİK
// yapılır (aynı asset iki kez yerleştirilirse ikinci sefer disk/network'ten
// tekrar yüklenmez, bellekteki THREE.Object3D `clone()`lanır).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Google'ın resmi, sürümlenmiş Draco decoder CDN'i (three.js örneklerinde standart).
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

export interface AssetCompileReport {
  triangles: number;
  materials: number;
  textureBytesEstimate: number;
  boundingSize: { x: number; y: number; z: number };
}

export interface AssetRecord {
  id: string;
  name: string;
  kind: 'model' | 'texture';
  /** Model için: orijinal, hiç sahneye eklenmemiş THREE.Group (her yerleştirmede clone'lanır). */
  root?: THREE.Group;
  texture?: THREE.Texture;
  report?: AssetCompileReport;
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

function countMaterialsAndTextureBytes(root: THREE.Object3D): { materials: number; textureBytes: number } {
  const seenMats = new Set<THREE.Material>();
  const seenTex = new Set<THREE.Texture>();
  let textureBytes = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      seenMats.add(mat);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const tex = (mat as unknown as Record<string, unknown>)[key];
        if (tex instanceof THREE.Texture && tex.image && !seenTex.has(tex)) {
          seenTex.add(tex);
          textureBytes += (tex.image.width ?? 0) * (tex.image.height ?? 0) * 4;
        }
      }
    }
  });
  return { materials: seenMats.size, textureBytes };
}

export class AssetLibrary {
  private records = new Map<string, AssetRecord>();
  private gltfLoader: GLTFLoader | null = null;

  private ensureLoader(): GLTFLoader {
    if (this.gltfLoader) return this.gltfLoader;
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODER_PATH);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    this.gltfLoader = loader;
    return loader;
  }

  list(): AssetRecord[] {
    return [...this.records.values()];
  }

  get(id: string): AssetRecord | undefined {
    return this.records.get(id);
  }

  async importModelFile(file: File): Promise<AssetRecord> {
    const buffer = await file.arrayBuffer();
    const loader = this.ensureLoader();

    const root = await new Promise<THREE.Group>((resolve, reject) => {
      loader.parse(
        buffer,
        '',
        (gltf) => {
          const wrapper = new THREE.Group();
          wrapper.add(gltf.scene);
          resolve(wrapper);
        },
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
      );
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const { materials, textureBytes } = countMaterialsAndTextureBytes(root);

    const record: AssetRecord = {
      id: crypto.randomUUID(),
      name: file.name,
      kind: 'model',
      root,
      report: {
        triangles: countTriangles(root),
        materials,
        textureBytesEstimate: textureBytes,
        boundingSize: { x: size.x, y: size.y, z: size.z },
      },
    };
    this.records.set(record.id, record);
    return record;
  }

  async importTextureFile(file: File): Promise<AssetRecord> {
    const url = URL.createObjectURL(file);
    try {
      const texture = await new THREE.TextureLoader().loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      const record: AssetRecord = { id: crypto.randomUUID(), name: file.name, kind: 'texture', texture };
      this.records.set(record.id, record);
      return record;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Sahneye eklenmeye hazır, BAĞIMSIZ bir kopya döner (orijinal kayıt asla sahneye eklenmez). */
  instantiateModel(assetId: string): THREE.Group | null {
    const record = this.records.get(assetId);
    if (!record?.root) return null;
    return record.root.clone(true);
  }

  dispose() {
    for (const record of this.records.values()) {
      record.root?.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
      });
      record.texture?.dispose();
    }
    this.records.clear();
  }
}
