// src/lib/game/decals.ts
//
// Eski `addBulletHole` (engine.ts): her atışta `new THREE.RingGeometry` +
// `new THREE.MeshBasicMaterial` + `new THREE.Mesh` allocate ediyordu, 120
// sınırını aşınca en eskisini dispose ediyordu. Bu, saniyede 10+ mermi atan
// bir otomatik silahla ciddi GC baskısı ve (MeshBasicMaterial kullanıldığı
// için) düz, ışıktan etkilenmeyen, derinliksiz bir delik görünümü demekti.
//
// YENİ SİSTEM:
//  1) GPU INSTANCING: `THREE.InstancedMesh` — TÜM mermi delikleri TEK bir
//     draw call'da çizilir (120 ayrı mesh yerine 1 instanced mesh).
//  2) OBJECT POOLING: Instance slotları önceden ayrılmış sabit bir dizi;
//     yeni delik "spawn" etmek `new`/`dispose` DEĞİL, sıradaki slotun
//     transform matrisini üzerine yazmaktır (ring buffer).
//  3) NORMAL MAPPING: Prosedürel (canvas tabanlı, harici asset GEREKTİRMEYEN)
//     bir crater normal map'i, MeshStandardMaterial.normalMap olarak
//     kullanılır -> düz bir quad olmasına rağmen ışık altında 3B bir çukur
//     varmış gibi gölgelenir.
//
// DÜRÜSTLÜK NOTU: Duvarın köşesini saran gerçek projeksiyon decal'i
// (THREE.DecalGeometry, three/examples/jsm) her decal için BENZERSİZ geometri
// üretir ve bu yüzden instance edilemez. Bu projedeki duvarlar/sandıklar düz
// kutu (BoxGeometry) yüzeyler olduğundan, düz-quad + normal-map yaklaşımı
// pratikte aynı görsel sonucu çok daha ucuza verir. Karmaşık/çok köşeli özel
// bir mesh üzerinde köşe sarma gerekirse `spawnProjected()` (bkz. alt) DecalGeometry
// kullanır ama o çağrı instance HAVUZUNU kullanmaz, ayrı ve daha pahalıdır —
// bu yüzden yalnızca nadir/özel çarpma anları için önerilir.

import * as THREE from 'three';

/** Prosedürel crater diffuse + normal map üretir (harici texture dosyası gerektirmez). */
function generateBulletHoleTextures(size = 128): { diffuse: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  // ---- Diffuse: koyu, kenarları yumuşak yanık izi ----
  const diffuseCanvas = document.createElement('canvas');
  diffuseCanvas.width = diffuseCanvas.height = size;
  const dctx = diffuseCanvas.getContext('2d')!;
  dctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  const grad = dctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  grad.addColorStop(0, 'rgba(8,8,8,0.95)');
  grad.addColorStop(0.35, 'rgba(20,18,15,0.85)');
  grad.addColorStop(0.7, 'rgba(35,30,25,0.4)');
  grad.addColorStop(1, 'rgba(35,30,25,0)');
  dctx.fillStyle = grad;
  dctx.beginPath();
  dctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  dctx.fill();

  // ---- Normal map: radyal bir "çukur" yükseklik fonksiyonundan türetilen normal ----
  // h(r) = -depth * (1 - smoothstep(r)), gradyanı sayısal olarak (finite difference) hesaplanır.
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  const nctx = normalCanvas.getContext('2d')!;
  const imgData = nctx.createImageData(size, size);
  const depth = 6.0;
  const radius = size / 2;

  const height = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy) / radius;
    if (r >= 1) return 0;
    // Kraterin ortası çukur (negatif), kenarında hafif kabarık kenar (pozitif) - gerçekçi mermi deliği profili
    const crater = -depth * (1 - r * r);
    const rim = r > 0.75 ? depth * 0.25 * (1 - (r - 0.75) / 0.25) : 0;
    return crater + rim;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height(x - 1, y);
      const hR = height(x + 1, y);
      const hD = height(x, y - 1);
      const hU = height(x, y + 1);

      // Merkezi fark ile gradyan (Sobel'in basitleştirilmiş hali) -> tangent-space normal
      const dx = (hR - hL) * 0.5;
      const dy = (hU - hD) * 0.5;
      const nx = -dx, ny = -dy, nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

      const idx = (y * size + x) * 4;
      imgData.data[idx + 0] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      imgData.data[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      imgData.data[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      imgData.data[idx + 3] = 255;
    }
  }
  nctx.putImageData(imgData, 0, 0);

  const diffuse = new THREE.CanvasTexture(diffuseCanvas);
  diffuse.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.CanvasTexture(normalCanvas);
  // Normal map'ler ASLA sRGB olmamalı (renk verisi değil, yön verisi) - yanlış
  // colorSpace burada sessiz ama yaygın bir görsel hata kaynağıdır.
  normal.colorSpace = THREE.NoColorSpace;

  return { diffuse, normal };
}

export class InstancedBulletHoles {
  private readonly mesh: THREE.InstancedMesh;
  private readonly maxCount: number;
  private nextIndex = 0;
  private activeCount = 0;

  private readonly _matrix = new THREE.Matrix4();
  private readonly _quaternion = new THREE.Quaternion();
  private readonly _worldNormal = new THREE.Vector3();
  private readonly _upAxis = new THREE.Vector3(0, 0, 1);
  private readonly _offsetPosition = new THREE.Vector3();
  private readonly _rollAxis = new THREE.Vector3();

  constructor(scene: THREE.Scene, maxCount = 120) {
    this.maxCount = maxCount;
    const { diffuse, normal } = generateBulletHoleTextures();

    const geometry = new THREE.PlaneGeometry(0.22, 0.22);
    const material = new THREE.MeshStandardMaterial({
      map: diffuse,
      normalMap: normal,
      normalScale: new THREE.Vector2(1.4, 1.4),
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      metalness: 0.0,
      roughness: 0.92,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // sık güncellenecek -> GPU'ya doğru ipucu
    this.mesh.frustumCulled = false; // instance'lar haritaya yayılı; tekil bounding-sphere yanlış culleyebilir
    this.mesh.count = 0; // aktif sayı arttıkça büyüyecek

    // Başlangıçta tüm slotları görünmez (sıfır ölçek) yap.
    const zeroScale = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < maxCount; i++) this.mesh.setMatrixAt(i, zeroScale);
    this.mesh.instanceMatrix.needsUpdate = true;

    scene.add(this.mesh);
  }

  /**
   * @param point çarpışma noktası (dünya uzayı)
   * @param localNormal yüzeyin YEREL uzaydaki normali (ör. raycast intersection.face.normal)
   * @param target çarpılan mesh (localNormal -> dünya uzayına çevirmek için matrixWorld kullanılır)
   */
  spawn(point: THREE.Vector3, localNormal: THREE.Vector3, target: THREE.Object3D) {
    this._worldNormal.copy(localNormal).transformDirection(target.matrixWorld).normalize();

    this._offsetPosition.copy(point).addScaledVector(this._worldNormal, 0.012);

    this._quaternion.setFromUnitVectors(this._upAxis, this._worldNormal);
    // Görsel çeşitlilik için normal ekseni etrafında rastgele bir "roll" (yuvarlanma) ekle
    this._rollAxis.copy(this._worldNormal);
    const rollQuat = new THREE.Quaternion().setFromAxisAngle(this._rollAxis, Math.random() * Math.PI * 2);
    this._quaternion.premultiply(rollQuat);

    this._matrix.compose(this._offsetPosition, this._quaternion, new THREE.Vector3(1, 1, 1));

    const index = this.nextIndex;
    this.mesh.setMatrixAt(index, this._matrix);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.nextIndex = (this.nextIndex + 1) % this.maxCount;
    this.activeCount = Math.min(this.activeCount + 1, this.maxCount);
    this.mesh.count = this.activeCount;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    const mat = this.mesh.material as THREE.MeshStandardMaterial;
    mat.map?.dispose();
    mat.normalMap?.dispose();
  }
      }
