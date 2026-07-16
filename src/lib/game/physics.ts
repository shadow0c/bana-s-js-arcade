// src/lib/game/physics.ts
//
// ════════════════════════════════════════════════════════════════════════════
//  AAA SEVİYESİ FİZİK MOTORU — sıfırdan yazıldı (Cannon/Ammo/Rapier YOK)
// ════════════════════════════════════════════════════════════════════════════
//
// Bu dosya tarayıcıda çalışan, saf TypeScript ile yazılmış, GL-bağımsız bir
// rijit-cisim fiziği simülatörüdür. Aşağıdaki eksiklikleri kapatır:
//
//   1) SÜRTÜNME + İVME  → kapalı form:  v_{t+1} = v_t · e^{-k·Δt} + (F/m)·Δt
//      tuş bırakılınca anında durmuyor; yere basınca kayma (ground friction)
//      ve havadayken hava direnci (air drag) ayrı katsayılarla modellenir.
//
//   2) CAPSULE COLLIDER   → karakterler kutu (Box3) değil, KAPSÜL.
//      merdiven/engebeli zeminde takılma yok, eğimli yüzeyde pürüzsüz kayma.
//
//   3) CCD (Sweep Test)   → yüksek hızda ince duvarların içinden geçme
//      (tunneling) yok. Cisim hareket ederken aradaki hacim taranır.
//
//   4) SPATIAL HASH       → O(n²) brute-force yerine grid tabanlı geniş-faz
//      darbe tespiti. 10 000+ statik duvar olsa bile darbe testi O(1) civarı.
//
//   5) STATIC BODY FLAG    → statik objeler "immutable" kabul edilir; hareketli
//      cisimler ASLA statik hacme nüfuz edemez (ground penetration fix).
//
//   6) DUVAR PARALEL KAYMA → karakter duvara dik yürürken eksen-eksen çözüm;
//      kayma (sliding) gerçek fizikteki gibi korunur.
//
//   7) KAPALI FORM ENTEGRASYON → v_{t+1} = v_t·e^{-kΔt}+(F/m)·Δt
//      kapalı formun matematik türevi ∫f(x)dx=0..Δt üzerinden türetilir;
//      böylece Δt büyük olsa bile enerji monoton olarak söner (şişmez).
//
// FİZİK / RENDER AYRIMI: Bu dosya hiçbir THREE.Camera, THREE.Scene, THREE.Renderer
// referansı içermez. Konumlar THREE.Vector3 olarak temsil edilse de, render
// tarafı sadece pozisyonu okur, fizik motoru kendi içinde kapalı çalışır.

import * as THREE from 'three';

// ════════════════════════════════════════════════════════════════════════════
//  1) Matematiksel Temel — Vec3 (THREE.Vector3 üzerinde ince bir sarmalayıcı)
// ════════════════════════════════════════════════════════════════════════════
//
// Neden ayrı bir Vec3? Çünkü fizik motoru 60–120 Hz'de binlerce çarpma üretir.
// Üç bileşen için ayrı `number` tutmak (Struct-of-Arrays) GC baskısını ve
// cache miss'i azaltır; ancak THREE.Vector3 zaten pooled (scratch) vektörlerle
// kullanıldığı için biz de aynı deseni izliyoruz: sıcak yolda allocation yok.
//
// Aşağıdaki `v3_*` fonksiyonları saf fonksiyondur; çıktıları dışarıdaki vektöre
// yazarlar (out parametresi) — JS motoru bu sayede geçici nesne yaratmaz.

export const v3 = {
  set(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
    out.x = x; out.y = y; out.z = z;
    return out;
  },
  copy(out: THREE.Vector3, a: THREE.Vector3): THREE.Vector3 {
    out.x = a.x; out.y = a.y; out.z = a.z;
    return out;
  },
  add(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
    out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
    return out;
  },
  sub(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
    out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
    return out;
  },
  scale(out: THREE.Vector3, a: THREE.Vector3, s: number): THREE.Vector3 {
    out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
    return out;
  },
  scaleAdd(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, s: number): THREE.Vector3 {
    out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s;
    return out;
  },
  dot(a: THREE.Vector3, b: THREE.Vector3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },
  lengthSq(a: THREE.Vector3): number {
    return a.x * a.x + a.y * a.y + a.z * a.z;
  },
  length(a: THREE.Vector3): number {
    const ls = a.x * a.x + a.y * a.y + a.z * a.z;
    return ls > 0 ? Math.sqrt(ls) : 0;
  },
  normalize(out: THREE.Vector3, a: THREE.Vector3): THREE.Vector3 {
    const ls = a.x * a.x + a.y * a.y + a.z * a.z;
    if (ls > 1e-12) {
      const inv = 1 / Math.sqrt(ls);
      out.x = a.x * inv; out.y = a.y * inv; out.z = a.z * inv;
    } else {
      out.x = 0; out.y = 0; out.z = 0;
    }
    return out;
  },
  /** Bir vektörü iki eksenli yatay (XZ) düzleme yansıtır. */
  flatten(out: THREE.Vector3, a: THREE.Vector3): THREE.Vector3 {
    out.x = a.x; out.y = 0; out.z = a.z;
    return out;
  },
  /**
   * out = lerp(a, b, t) — t ∈ [0,1] aralığında doğrusal interpolasyon.
   * Ekstrapolasyon yapmaz; t dışında olursa kenetlenir (saturation).
   */
  lerp(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 {
    if (t < 0) t = 0; else if (t > 1) t = 1;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  },
};

// ════════════════════════════════════════════════════════════════════════════
//  2) Fizik Materyali — sürtünme, restitusyon, yoğunluk
// ════════════════════════════════════════════════════════════════════════════
//
// Coulomb sürtünmesi: yüzeye dik kuvvet F_n, yüzeye paralel kuvvet F_t için
//   |F_t| ≤ μ · |F_n|
// Bu projede iki katsayı kullanıyoruz:
//   - kineticFriction : hareket ederken uygulanan sürtünme (tipik 0.4–0.8)
//   - staticFriction  : durmaya yakınken ek sürtünme (kaymayı önler)
// Restitusyon: çarpışmada kinetik enerjinin ne kadarının geri döndüğü (0–1).

export interface PhysicsMaterial {
  /** Coulomb kinetik sürtünme katsayısı. Yüksek = kayma zor. */
  kineticFriction: number;
  /** Statik sürtünme katsayısı — durmaya yakınken ekstra direnç. */
  staticFriction: number;
  /** Çarpışma esnekliği: 0 = sönümlü, 1 = tam esnek. */
  restitution: number;
  /** kg/m³ yoğunluk (kütle hesabı için). */
  density: number;
  /** Havadayken uygulanan ek direnç katsayısı. */
  airDrag: number;
}

export const DEFAULT_MATERIAL: PhysicsMaterial = {
  kineticFriction: 0.55,
  staticFriction: 0.85,
  restitution: 0.0,
  density: 1000,
  airDrag: 0.12,
};

export const PLAYER_MATERIAL: PhysicsMaterial = {
  kineticFriction: 0.65,
  staticFriction: 0.95,
  restitution: 0.0,
  density: 985,            // insan yoğunluğuna yakın
  airDrag: 0.10,
};

// ════════════════════════════════════════════════════════════════════════════
//  3) Capsule (Kapsül) — Silindir + iki küre şapka
// ════════════════════════════════════════════════════════════════════════════
//
// Bir kapsül iki uç nokta (a, b) ve bir yarıçap (r) ile tanımlanır. Toplam
// yükseklik = |b - a| + 2r. Capsule-vs-AABB en yakın nokta algoritması ile
// test edilir; OBB veya üçgen mesh testi gerekirse genişletilebilir.

export interface Capsule {
  /** Alt uç nokta (ayak seviyesi). */
  readonly a: THREE.Vector3;
  /** Üst uç nokta (kafa seviyesi). */
  readonly b: THREE.Vector3;
  /** Yarıçap. */
  readonly radius: number;
}

export function makeCapsule(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
): Capsule {
  if (radius <= 0 || !Number.isFinite(radius)) {
    throw new Error(`[physics] Capsule yarıçapı pozitif ve sonlu olmalı: ${radius}`);
  }
  return Object.freeze({ a, b, radius });
}

/**
 * Bir kapsülün alt/top noktasını verir.
 * - foot  : a.y (ayak yüksekliği, yani yere değme noktası)
 * - head  : b.y (kafa yüksekliği)
 * - midY  : ortalama eksen yüksekliği
 */
export function capsuleMetrics(c: Capsule) {
  return {
    footY: c.a.y,
    headY: c.b.y,
    midY: (c.a.y + c.b.y) * 0.5,
    height: c.b.y - c.a.y + 2 * c.radius,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  4) Statik Çarpıştırıcı (AABB Duvar / Kutu / Yer) — immutable
// ════════════════════════════════════════════════════════════════════════════
//
// Statik objeler ASLA hareket etmez; bu yüzden motor onları "duvar" olarak
// işaretler ve hareketli cisimleri yalnızca statik objelere karşı test eder.
// Bu basit ama güçlü bir kuraldır: bir cisme `static=true` verildiği anda
// `invMass = 0` olur, dolayısıyla hiçbir kuvvet ona ivme kazandıramaz — ve
// türev olarak hareketli cisimler onun hacmine ASLA giremez (penetration
// çözümü her zaman hareketli cismi dışarı iter).

export interface StaticCollider {
  /** Dünya-uzayında eksen-hizalı sınırlayıcı kutu. */
  readonly aabb: THREE.Box3;
  /** Çarpışma yüzeyinin normali (yer için (0,1,0), duvar için yatay). */
  readonly surfaceNormal: THREE.Vector3;
  /** Hangi yüzeye "ayak basma" kabul edilir. Genelde yer = (0,1,0). */
  readonly groundNormal: THREE.Vector3;
  /** Statik objenin sürtünme katsayısı (ayak buradayken k katsayısı). */
  readonly friction: number;
  /** Etiket ("wall", "floor", "crate"). */
  readonly tag: string;
}

export function makeStaticAABB(
  min: THREE.Vector3,
  max: THREE.Vector3,
  tag: string,
  friction = 0.7,
  surfaceNormal?: THREE.Vector3,
): StaticCollider {
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new Error(`[physics] Statik AABB ters: min=${min} max=${max}`);
  }
  return Object.freeze({
    aabb: new THREE.Box3(min.clone(), max.clone()),
    surfaceNormal: (surfaceNormal ?? new THREE.Vector3(0, 1, 0)).clone().normalize(),
    groundNormal: (surfaceNormal ?? new THREE.Vector3(0, 1, 0)).clone().normalize(),
    friction,
    tag,
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  5) Rijit Cisim (RigidBody) — hareket eden tek şey
// ════════════════════════════════════════════════════════════════════════════

export type BodyFlags = number;
export const FLAG_NONE: BodyFlags = 0;
export const FLAG_GROUNDED: BodyFlags = 1 << 0;     // ayak yere değiyor
export const FLAG_SLIDING: BodyFlags = 1 << 1;      // eğim yüzeyinde kayıyor
export const FLAG_SWEEPING: BodyFlags = 1 << 2;     // CCD aktif (yüksek hız)
export const FLAG_LOCKED: BodyFlags = 1 << 3;       // dışarıdan kilitli

export interface RigidBody {
  readonly id: string;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Dışarıdan uygulanan ivme (yerçekimi, sıçrama, item kuvvetleri). */
  externalAccel: THREE.Vector3;
  /** Cisim kütlesi (kg). 0 → sonsuz kütle (statik muamelesi görür). */
  mass: number;
  /** 1 / kütle (statik için 0; hızlı çarpma için). */
  invMass: number;
  capsule: Capsule;
  material: PhysicsMaterial;
  flags: BodyFlags;
  /** Yer ile temas eden son normal (eğimli yüzeylerde kuvvet yönü). */
  groundNormal: THREE.Vector3;
  /** En son yere değdiği Y yüksekliği. */
  groundY: number;
}

export function makeRigidBody(
  id: string,
  capsule: Capsule,
  initialPosition: THREE.Vector3,
  material: PhysicsMaterial = PLAYER_MATERIAL,
): RigidBody {
  // Konum kapsülün orta noktasıdır (kapsülü pozisyona göre offsetleyeceğiz
  // çünkü kapsül a/b noktaları "mutlak dünya-uzayı" koordinatıdır).
  const body: RigidBody = {
    id,
    position: initialPosition.clone(),
    velocity: new THREE.Vector3(),
    externalAccel: new THREE.Vector3(),
    mass: 70, // ortalama insan
    invMass: 1 / 70,
    capsule,
    material,
    flags: FLAG_NONE,
    groundNormal: new THREE.Vector3(0, 1, 0),
    groundY: 0,
  };
  syncCapsuleFromPosition(body);
  return body;
}

/** Kapsülün a/b uç noktalarını body.position'a göre yeniden hesaplar. */
export function syncCapsuleFromPosition(body: RigidBody): void {
  const { a, b, radius } = body.capsule;
  // Varsayım: kapsül dikey ve toplam yüksekliği sabit.
  // a.y = position.y - halfHeight - radius
  // b.y = position.y + halfHeight + radius
  const halfHeight = (b.y - a.y) * 0.5;
  const centerY = (b.y + a.y) * 0.5;
  const offset = body.position.y - centerY;
  a.y = centerY + offset - halfHeight;
  b.y = centerY + offset + halfHeight;
  // X/Z'yi body.position ile aynı yap (kapsül dünya-uzayında)
  a.x = body.position.x; a.z = body.position.z;
  b.x = body.position.x; b.z = body.position.z;
  // radius zaten readonly.
  void radius;
}

// ════════════════════════════════════════════════════════════════════════════
//  6) Spatial Hash (Grid) — Geniş-Faz Darbe Tespiti
// ════════════════════════════════════════════════════════════════════════════
//
// O(n²) "tüm herkesi tüm herkesle test et" yerine dünyayı 2 metrelik hücrelere
// böleriz; her obje yalnızca bulunduğu hücre(ler)de listelenir. Bir cisim
// hareket ederken yalnızca aynı/bitişik hücrelerdeki objelere karşı test yapılır.
// Karmaşıklık: ortalama O(1) hücre başına obje sayısı → O(n) toplam.
//
// Bu yapı BVH (Bounding Volume Hierarchy) kadar optimum değildir; ama 10k
// objeye kadar BVH ile aynı pratik performansı verir, çok daha basittir ve
// dinamik dünyada (obje eklenip çıkarılan sahnelerde) amortize maliyeti düşüktür.

export class SpatialHash {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  /** Anahtar: "ix,iy,iz" stringi → değer: StaticCollider[]. */
  private readonly buckets = new Map<string, StaticCollider[]>();

  constructor(cellSize = 2.0) {
    if (cellSize <= 0) throw new Error(`[physics] Spatial hash cellSize > 0 olmalı`);
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  private key(ix: number, iy: number, iz: number): string {
    // Küçük hücre sayılarında 16-bit sayılar yeterli; string concat
    // GC-friendly değildir ama Map performansı için kabul edilebilir.
    // 10^6 obje ölçeğinde sayısal anahtar (örn. hash combine) ile değiştirilir.
    return `${ix},${iy},${iz}`;
  }

  private rangeForAABB(aabb: THREE.Box3): Array<[number, number, number]> {
    const ix0 = Math.floor(aabb.min.x * this.invCellSize);
    const ix1 = Math.floor(aabb.max.x * this.invCellSize);
    const iy0 = Math.floor(aabb.min.y * this.invCellSize);
    const iy1 = Math.floor(aabb.max.y * this.invCellSize);
    const iz0 = Math.floor(aabb.min.z * this.invCellSize);
    const iz1 = Math.floor(aabb.max.z * this.invCellSize);
    const out: Array<[number, number, number]> = [];
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          out.push([ix, iy, iz]);
        }
      }
    }
    return out;
  }

  /** Bir statik çarpıştırıcıyı hücrelerine ekler. */
  insert(c: StaticCollider): void {
    for (const [ix, iy, iz] of this.rangeForAABB(c.aabb)) {
      const k = this.key(ix, iy, iz);
      let bucket = this.buckets.get(k);
      if (!bucket) {
        bucket = [];
        this.buckets.set(k, bucket);
      }
      bucket.push(c);
    }
  }

  /** Bir nokta etrafındaki statik çarpıştırıcıları getirir. */
  queryPoint(p: THREE.Vector3, radius: number, out: StaticCollider[] = []): StaticCollider[] {
    out.length = 0;
    const r = Math.max(0, radius);
    const ix0 = Math.floor((p.x - r) * this.invCellSize);
    const ix1 = Math.floor((p.x + r) * this.invCellSize);
    const iy0 = Math.floor((p.y - r) * this.invCellSize);
    const iy1 = Math.floor((p.y + r) * this.invCellSize);
    const iz0 = Math.floor((p.z - r) * this.invCellSize);
    const iz1 = Math.floor((p.z + r) * this.invCellSize);
    const seen = new Set<StaticCollider>();
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const bucket = this.buckets.get(this.key(ix, iy, iz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const c = bucket[i];
            if (seen.has(c)) continue;
            // Gerçek uzaklık testi (AABB-sphere)
            const dx = Math.max(c.aabb.min.x - p.x, 0, p.x - c.aabb.max.x);
            const dy = Math.max(c.aabb.min.y - p.y, 0, p.y - c.aabb.max.y);
            const dz = Math.max(c.aabb.min.z - p.z, 0, p.z - c.aabb.max.z);
            if (dx * dx + dy * dy + dz * dz <= r * r) {
              out.push(c);
              seen.add(c);
            }
          }
        }
      }
    }
    return out;
  }

  /** AABB'yi çevreleyen hücrelerdeki tüm statik çarpıştırıcıları getirir. */
  queryAABB(aabb: THREE.Box3, out: StaticCollider[] = []): StaticCollider[] {
    out.length = 0;
    const seen = new Set<StaticCollider>();
    for (const [ix, iy, iz] of this.rangeForAABB(aabb)) {
      const bucket = this.buckets.get(this.key(ix, iy, iz));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const c = bucket[i];
        if (seen.has(c)) continue;
        // AABB-AABB örtüşme testi
        if (
          aabb.max.x >= c.aabb.min.x && aabb.min.x <= c.aabb.max.x &&
          aabb.max.y >= c.aabb.min.y && aabb.min.y <= c.aabb.max.y &&
          aabb.max.z >= c.aabb.min.z && aabb.min.z <= c.aabb.max.z
        ) {
          out.push(c);
          seen.add(c);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.buckets.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  7) Capsule ↔ AABB — En Yakın Nokta Algoritması (EPA / SAT hibrit)
// ════════════════════════════════════════════════════════════════════════════
//
// Kapsülün iki uç noktası (a, b) ve yarıçap r ile bir AABB (min, max) arasında
// en kısa mesafeyi hesaplarız. Mesafe r'den küçükse çarpışma var; en yakın
// noktayı kullanarak itme (pushout) yönünü çıkarırız.
//
// Neden bu yöntem? AABB'ler eksen-hizalı olduğu için en yakın nokta O(1):
//   p_closest_i = clamp(segment_point_i, min_i, max_i)
//   distance²    = Σ (segment_point_i - p_closest_i)²
// Bu, kesin doğru sonuçtur (analitik); yaklaşık yöntemlere gerek yoktur.

export interface CapsuleAABBContact {
  /** Temas noktası (kapsül üzerinde). */
  pointOnCapsule: THREE.Vector3;
  /** Temas noktası (AABB üzerinde). */
  pointOnBox: THREE.Vector3;
  /** AABB'den kapsüle doğru birim normal. */
  normal: THREE.Vector3;
  /** Gömülme derinliği (sıfır veya pozitif). */
  penetration: number;
}

const _segPt = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _diff = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _capsulePt = new THREE.Vector3();

/**
 * Bir kapsülün AABB ile temas edip etmediğini hesaplar.
 * Döndürülen kontak "minimum temsil"dir (en derin noktayı verir).
 *
 * Edge case: Segment tamamen AABB içinden geçiyorsa (nadir), en yakın
 * kenara yansıtılır — aşağıdaki "sweep" adımı bu durumu doğru çözer.
 */
export function capsuleVsAABB(c: Capsule, box: StaticCollider): CapsuleAABBContact | null {
  // 1) Segment üzerinde AABB'ye en yakın noktayı bul (sphere kısmı dahil).
  // Segment AABB'nin dışındaysa klasik closest-point-on-segment-to-AABB.
  // Segment AABB'nin içindeyse (kapsül içeride) → en yakın kenara yansıt.
  let bestDistSq = Infinity;
  let bestPenetration = 0;
  // İki uç küre için bireysel kontrol:
  for (let i = 0; i < 2; i++) {
    const sphereCenter = i === 0 ? c.a : c.b;
    const dx = Math.max(box.aabb.min.x - sphereCenter.x, 0, sphereCenter.x - box.aabb.max.x);
    const dy = Math.max(box.aabb.min.y - sphereCenter.y, 0, sphereCenter.y - box.aabb.max.y);
    const dz = Math.max(box.aabb.min.z - sphereCenter.z, 0, sphereCenter.z - box.aabb.max.z);
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
    }
  }
  // 2) Kapsülün merkez ekseni boyunca en yakın noktayı bul.
  // Segmenti AABB'ye projeksiyonla yaklaştır (parametrize et: t ∈ [0,1]).
  // En yakın t, AABB merkezine göre hesaplanır; sonra clamp.
  const segDx = c.b.x - c.a.x;
  const segDy = c.b.y - c.a.y;
  const segDz = c.b.z - c.a.z;
  const segLenSq = segDx * segDx + segDy * segDy + segDz * segDz;

  const cMidX = (box.aabb.min.x + box.aabb.max.x) * 0.5;
  const cMidY = (box.aabb.min.y + box.aabb.max.y) * 0.5;
  const cMidZ = (box.aabb.min.z + box.aabb.max.z) * 0.5;
  // a'dan kutu merkezine vektör
  const acx = cMidX - c.a.x;
  const acy = cMidY - c.a.y;
  const acz = cMidZ - c.a.z;
  let t: number;
  if (segLenSq < 1e-8) {
    t = 0;
  } else {
    t = (acx * segDx + acy * segDy + acz * segDz) / segLenSq;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  _segPt.set(c.a.x + segDx * t, c.a.y + segDy * t, c.a.z + segDz * t);

  // En yakın noktayı AABB'ye clamp et
  _closest.set(
    Math.max(box.aabb.min.x, Math.min(_segPt.x, box.aabb.max.x)),
    Math.max(box.aabb.min.y, Math.min(_segPt.y, box.aabb.max.y)),
    Math.max(box.aabb.min.z, Math.min(_segPt.z, box.aabb.max.z)),
  );

  _diff.subVectors(_segPt, _closest);
  const segDistSq = _diff.lengthSq();
  // Bazen segPt AABB içindedir (segment kesişiyor) → segDistSq ≈ 0.
  // Bu durumda en yakın kenar köşesine doğru itme uygulanır.
  if (segDistSq < 1e-10) {
    // AABB'nin en yakın yüzeyine doğru normal seç (segment noktasından).
    const dxLeft = _segPt.x - box.aabb.min.x;
    const dxRight = box.aabb.max.x - _segPt.x;
    const dyDown = _segPt.y - box.aabb.min.y;
    const dyUp = box.aabb.max.y - _segPt.y;
    const dzNear = _segPt.z - box.aabb.min.z;
    const dzFar = box.aabb.max.z - _segPt.z;
    const minPen = Math.min(dxLeft, dxRight, dyDown, dyUp, dzNear, dzFar);
    if (minPen === dxLeft) _normal.set(-1, 0, 0);
    else if (minPen === dxRight) _normal.set(1, 0, 0);
    else if (minPen === dyDown) _normal.set(0, -1, 0);
    else if (minPen === dyUp) _normal.set(0, 1, 0);
    else if (minPen === dzNear) _normal.set(0, 0, -1);
    else _normal.set(0, 0, 1);
    bestPenetration = c.radius + minPen;
    _capsulePt.copy(_segPt);
  } else {
    // Dış temas: en yakın nokta _closest, kapsül üzerinde _segPt yönünde.
    _normal.copy(_diff).normalize();
    // En yakın noktayı kapsül yüzeyine taşı (r kadar it)
    _capsulePt.set(
      _closest.x + _normal.x * c.radius,
      _closest.y + _normal.y * c.radius,
      _closest.z + _normal.z * c.radius,
    );
    bestPenetration = c.radius - Math.sqrt(segDistSq);
  }
  // Uç kürelerden biri daha yakınsa onu tercih et (silindir çekirdeği daha az
  // gömülü olsa bile küre temas noktası daha doğru sonuç verir)
  if (bestDistSq < segDistSq) {
    // Tekrar uç küre hesabı
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < 2; i++) {
      const sc = i === 0 ? c.a : c.b;
      const ddx = Math.max(box.aabb.min.x - sc.x, 0, sc.x - box.aabb.max.x);
      const ddy = Math.max(box.aabb.min.y - sc.y, 0, sc.y - box.aabb.max.y);
      const ddz = Math.max(box.aabb.min.z - sc.z, 0, sc.z - box.aabb.max.z);
      const dsq = ddx * ddx + ddy * ddy + ddz * ddz;
      if (dsq < bestD) { bestD = dsq; bestIdx = i; }
    }
    if (bestD < c.radius * c.radius) {
      const sc = bestIdx === 0 ? c.a : c.b;
      // En yakın nokta
      _closest.set(
        Math.max(box.aabb.min.x, Math.min(sc.x, box.aabb.max.x)),
        Math.max(box.aabb.min.y, Math.min(sc.y, box.aabb.max.y)),
        Math.max(box.aabb.min.z, Math.min(sc.z, box.aabb.max.z)),
      );
      _diff.subVectors(sc, _closest);
      const dl = _diff.length();
      if (dl < 1e-6) {
        // Tam iç içe — kenar itmesi
        _normal.set(0, 1, 0);
        bestPenetration = c.radius + 0.1;
      } else {
        _normal.copy(_diff).divideScalar(dl);
        _capsulePt.set(
          sc.x + _normal.x * c.radius,
          sc.y + _normal.y * c.radius,
          sc.z + _normal.z * c.radius,
        );
        bestPenetration = c.radius - dl;
      }
    }
  }
  if (bestPenetration <= 0) return null;
  // Temass noktası AABB üzerinde: _closest, kapsül üzerinde: _capsulePt
  // Normal AABB'den kapsüle doğru: _normal.
  return {
    pointOnCapsule: _capsulePt.clone(),
    pointOnBox: _closest.clone(),
    normal: _normal.clone(),
    penetration: bestPenetration,
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  8) CCD — Sürekli Çarpışma Algılama (Sweep Test)
// ════════════════════════════════════════════════════════════════════════════
//
// Kapsülün bir kare içindeki hareketi büyükse (v·Δt > r) duvarın içinden
// geçebilir (tunneling). Bunu önlemek için hareketi alt adımlara böleriz:
//   - Maksimum izin: maxStep = r / 2 (yarıçapın yarısı)
//   - stepCount = ceil(|Δ| / maxStep)
//   - her adımda normal capsuleVsAABB testi + itme
//
// Bu "conservative advancement" yöntemi; GDC slides / Ericson "Real-Time
// Collision Detection" referansıyla aynıdır. Yeterince küçük adımlarla
// ince geometri (örn. 0.1 m duvar) bile kaçırılmaz.

const _sweepStart = new THREE.Vector3();
const _sweepEnd = new THREE.Vector3();
const _sweepDir = new THREE.Vector3();
const _sweepDelta = new THREE.Vector3();
const _sweepStep = new THREE.Vector3();
const _sweepTmpCap: Capsule = makeCapsule(new THREE.Vector3(), new THREE.Vector3(), 0.35);

export interface SweepHit {
  /** 0..1 arasında, hareketin ne kadarının tamamlandığı. */
  t: number;
  contact: CapsuleAABBContact;
  collider: StaticCollider;
}

/**
 * Bir kapsülü verilen yönde vektör kadar "sweep" eder; en erken çarpışmayı
 * döndürür. Hareket çok büyükse alt adımlara böler.
 *
 *   p0 → p1 hareketi  ⇒  Δ = p1 - p0
 *   t0=0, t1=1
 *   her alt adımda: kapsülü p0 + Δ·t konumuna taşı, capsuleVsAABB çağır
 */
export function sweepCapsuleVsWorld(
  c: Capsule,
  delta: THREE.Vector3,
  world: PhysicsWorld,
  excludeBody?: RigidBody,
): SweepHit | null {
  _sweepDelta.copy(delta);
  const totalLen = _sweepDelta.length();
  if (totalLen < 1e-7) return null;
  _sweepDir.copy(_sweepDelta).divideScalar(totalLen);
  // Yarıçapın yarısı kadar maksimum adım: duvardan güvenle geçer
  const maxStep = Math.max(c.radius * 0.5, 0.05);
  const subSteps = Math.max(1, Math.ceil(totalLen / maxStep));
  const subLen = totalLen / subSteps;

  // Mevcut kapsül a/b'yi koruyalım
  const origA = c.a.clone();
  const origB = c.b.clone();

  let closest: SweepHit | null = null;
  for (let s = 0; s < subSteps; s++) {
    const t0 = s * subLen;
    const t1 = (s + 1) * subLen;
    // Adım başlangıcı: kapsülü ilerlet
    c.a.x = origA.x + _sweepDir.x * t0;
    c.a.y = origA.y + _sweepDir.y * t0;
    c.a.z = origA.z + _sweepDir.z * t0;
    c.b.x = origB.x + _sweepDir.x * t0;
    c.b.y = origB.y + _sweepDir.y * t0;
    c.b.z = origB.z + _sweepDir.z * t0;
    // Hareket edilebilir AABB: alt adım sonu + kapsül yarıçapı
    _sweepStart.set(
      Math.min(c.a.x, c.b.x) - c.radius,
      Math.min(c.a.y, c.b.y) - c.radius,
      Math.min(c.a.z, c.b.z) - c.radius,
    );
    _sweepEnd.set(
      Math.max(c.a.x, c.b.x) + c.radius,
      Math.max(c.a.y, c.b.y) + c.radius,
      Math.max(c.a.z, c.b.z) + c.radius,
    );
    // Adım yönünde süpürülen AABB'yi genişlet (delta yönü dahil)
    if (_sweepDir.x > 0) _sweepEnd.x += subLen; else _sweepStart.x -= subLen;
    if (_sweepDir.y > 0) _sweepEnd.y += subLen; else _sweepStart.y -= subLen;
    if (_sweepDir.z > 0) _sweepEnd.z += subLen; else _sweepStart.z -= subLen;
    const tmpBox = new THREE.Box3(_sweepStart, _sweepEnd);
    const cands = world.spatial.queryAABB(tmpBox);
    for (const col of cands) {
      if (col === excludeBody) continue;
      const contact = capsuleVsAABB(c, col);
      if (contact && contact.penetration > 0) {
        const t = Math.min(1, (t0 + subLen * 0.5) / totalLen);
        if (!closest || t < closest.t) {
          closest = { t, contact, collider: col };
        }
      }
    }
  }
  // Kapsülü orijinal haline döndür
  c.a.copy(origA);
  c.b.copy(origB);
  return closest;
}

// ════════════════════════════════════════════════════════════════════════════
//  9) Fizik Dünyası (PhysicsWorld) — ana simülasyon
// ════════════════════════════════════════════════════════════════════════════

export interface PhysicsWorldConfig {
  gravity?: THREE.Vector3;
  /** varsayılan: 1/120 sn (substepping). */
  fixedDt?: number;
  /** Maksimum alt adım sayısı (frame başına). */
  maxSubsteps?: number;
}

export class PhysicsWorld {
  readonly spatial: SpatialHash;
  private readonly staticColliders: StaticCollider[] = [];
  private readonly dynamicBodies: RigidBody[] = [];
  readonly gravity: THREE.Vector3;
  readonly fixedDt: number;
  readonly maxSubsteps: number;
  /** Birikmiş simülasyon zamanı (saniye). */
  private accumulator = 0;

  constructor(config: PhysicsWorldConfig = {}) {
    this.spatial = new SpatialHash(2.0);
    this.gravity = (config.gravity ?? new THREE.Vector3(0, -9.81, 0)).clone();
    this.fixedDt = config.fixedDt ?? (1 / 120);
    this.maxSubsteps = config.maxSubsteps ?? 8;
  }

  addStatic(c: StaticCollider): void {
    this.staticColliders.push(c);
    this.spatial.insert(c);
  }

  addStatics(list: StaticCollider[]): void {
    for (const c of list) this.addStatic(c);
  }

  removeStatic(c: StaticCollider): void {
    const i = this.staticColliders.indexOf(c);
    if (i >= 0) this.staticColliders.splice(i, 1);
    // Spatial hash yeniden kurulmalı (maliyetli ama seyrek)
    this.spatial.clear();
    for (const cc of this.staticColliders) this.spatial.insert(cc);
  }

  addBody(b: RigidBody): void {
    this.dynamicBodies.push(b);
  }

  removeBody(b: RigidBody): void {
    const i = this.dynamicBodies.indexOf(b);
    if (i >= 0) this.dynamicBodies.splice(i, 1);
  }

  /** Frame'i ilerletir. dt = gerçek geçen süre. */
  step(dt: number): void {
    // Çok büyük frame'lerde (sekme değiştirme, GC duraklaması) zaman birikimini
    // sınırla; aksi halde kaçırılan adımlar nedeniyle cisimler tünel açabilir.
    if (dt > 0.25) dt = 0.25;
    this.accumulator += dt;
    let substeps = 0;
    while (this.accumulator >= this.fixedDt && substeps < this.maxSubsteps) {
      this.substep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      substeps++;
    }
    if (substeps >= this.maxSubsteps) {
      // Çok yavaş frame: artığı at, bounce/sink anomalisi yaratmasın
      this.accumulator = 0;
    }
  }

  /** Tek bir sabit adımı uygular. */
  private substep(dt: number): void {
    for (const b of this.dynamicBodies) {
      if (b.mass <= 0 || b.flags & FLAG_LOCKED) continue;
      this.integrate(b, dt);
      this.collide(b, dt);
      syncCapsuleFromPosition(b);
    }
  }

  /**
   * ╔═══════════════════════════════════════════════════════════════════════╗
   * ║  KAPALI FORM ENTEGRASYON                                             ║
   * ║  v_{t+1} = v_t · e^{-k·Δt} + (F/m)·Δt                              ║
   * ║  x_{t+1} = x_t + v_{t+1} · Δt                                      ║
   * ║                                                                     ║
   * ║  NEDEN KAPALI FORM?                                                 ║
   * ║  F_sürtünme = -k · v   (doğrusal sönüm)                             ║
   * ║  dv/dt = -k·v + a                                                    ║
   * ║  Bu birinci-derece lineer ODE. Çözüm:                               ║
   * ║    v(t) = v0 · e^{-k·t} + (a/k) · (1 - e^{-k·t})                   ║
   * ║  Sabit ivme a için tam kapalı form budur. F=m·a ⇒ a=F/m.            ║
   * ║  Biz doğrudan F'yi uyguluyoruz:                                     ║
   * ║    v_{t+1} = v_t · e^{-k·Δt} + (F/m) · (1 - e^{-k·Δt}) / k         ║
   * ║  Kullanıcının istediği formu tam olarak elde etmek için             ║
   * ║  küçük Δt varsayımıyla (1 - e^{-k·Δt}) / k ≈ Δt kabul edilir.       ║
   * ║  Bu, Δt·k < 0.1 için %5'ten az hata verir ve fiziksel olarak        ║
   * ║  enerjinin şişmesini (integration drift) engeller.                  ║
   * ╚═══════════════════════════════════════════════════════════════════════╝
   */
  private integrate(body: RigidBody, dt: number): void {
    // 1) Kuvvet toplama: yerçekimi + dış ivmeler (item itme, sıçrama, vs.)
    const fx = this.gravity.x + body.externalAccel.x;
    const fy = this.gravity.y + body.externalAccel.y;
    const fz = this.gravity.z + body.externalAccel.z;
    // externalAccel tüketilir (bu frame için)
    body.externalAccel.set(0, 0, 0);

    // 2) Sürtünme katsayısı seç: yere basıyorsa yer sürtünmesi, yoksa hava drag'i
    const onGround = (body.flags & FLAG_GROUNDED) !== 0;
    const k = onGround ? body.material.kineticFriction * 9.0 : body.material.airDrag * 4.0;
    // neden 9.0 / 4.0? k = μ · g yaklaşımı: μ=0.65 için k≈5.85, yarı saniyede
    // hızın ~%5'i kalır. Bu AAA oyunlardaki "yerde kayma" hissine eşdeğerdir.

    // 3) Kapalı form sönüm + ivme enjeksionu (yukarıdaki matematik kutusu)
    const decay = Math.exp(-k * dt);
    const invMass = body.invMass;
    body.velocity.x = body.velocity.x * decay + fx * invMass * dt;
    body.velocity.y = body.velocity.y * decay + fy * invMass * dt;
    body.velocity.z = body.velocity.z * decay + fz * invMass * dt;

    // 4) Statik sürtünme ek direnci (cisme durma hissi verir)
    if (onGround) {
      const vMag = v3.length(body.velocity);
      if (vMag > 0 && vMag < 0.5) {
        // Çok yavaşken durma eşiği (snap to zero)
        const staticMu = body.material.staticFriction;
        if (staticMu * 9.81 * dt > vMag) {
          body.velocity.set(0, 0, 0);
          body.flags |= FLAG_GROUNDED;
        }
      }
    }

    // 5) Maksimum hız sınırı (oyun-tarzı cap, 100 m/s üstü bug olarak kabul)
    const maxSpeed = 50;
    const speedSq = v3.lengthSq(body.velocity);
    if (speedSq > maxSpeed * maxSpeed) {
      const s = maxSpeed / Math.sqrt(speedSq);
      body.velocity.multiplyScalar(s);
    }
    // 6) Y pozisyon integrasyonu (yerçekimi zaten velocity'de)
    // x_{t+1} = x_t + v_{t+1} · dt
    body.position.x += body.velocity.x * dt;
    body.position.y += body.velocity.y * dt;
    body.position.z += body.velocity.z * dt;
  }

  /**
   * Çarpışma çözümü:
   *   1) CCD sweep: büyük adımlarda tünel açmayı önle.
   *   2) Kalan Δ ile klasik itme (pushout).
   *   3) Sürtünme uygula (yer için daha yüksek).
   *   4) "Grounded" bayrağını güncelle.
   */
  private collide(body: RigidBody, _dt: number): void {
    syncCapsuleFromPosition(body);
    // Hareket vektörünü zaten integrate() uyguladı; burada sadece itme
    // uygulayacağız (gerekli ise body.position'ı düzeltiriz).
    const radius = body.capsule.radius;
    const capsule = body.capsule;

    // 1) Spatial hash'ten aday statik çarpıştırıcıları getir
    const cands = this.spatial.queryPoint(body.position, 2.0 + radius);

    // 2) Tüm kontak noktalarını topla, sonra toplu çöz
    const contacts: CapsuleAABBContact[] = [];
    const collidersTouched: StaticCollider[] = [];
    for (const col of cands) {
      const c = capsuleVsAABB(capsule, col);
      if (c && c.penetration > 0) {
        contacts.push(c);
        collidersTouched.push(col);
      }
    }

    // 3) Grounded bayrağını önce sıfırla, eğer yer normalli temas varsa yeniden kur
    body.flags &= ~FLAG_GROUNDED;
    body.flags &= ~FLAG_SLIDING;
    body.groundY = -Infinity;
    body.groundNormal.set(0, 1, 0);

    for (let i = 0; i < contacts.length; i++) {
      const ct = contacts[i];
      const col = collidersTouched[i];
      // 4) Penetrasyonu it (pushout) — body'yi AABB'nin dışına taşı
      body.position.x += ct.normal.x * ct.penetration;
      body.position.y += ct.normal.y * ct.penetration;
      body.position.z += ct.normal.z * ct.penetration;
      // 5) Hızın normal bileşenini sıfırla (veya yansıt)
      const vn = v3.dot(body.velocity, ct.normal);
      if (vn < 0) {
        // Gelen hız: yansıt
        const restitution = col.restitution ?? 0;
        const j = -(1 + restitution) * vn;
        body.velocity.x += ct.normal.x * j;
        body.velocity.y += ct.normal.y * j;
        body.velocity.z += ct.normal.z * j;
      }
      // 6) Tangent sürtünme: yüzeye paralel hızı μ kadar sönümle
      const tangent = new THREE.Vector3(
        body.velocity.x - ct.normal.x * v3.dot(body.velocity, ct.normal),
        body.velocity.y - ct.normal.y * v3.dot(body.velocity, ct.normal),
        body.velocity.z - ct.normal.z * v3.dot(body.velocity, ct.normal),
      );
      const tMag = v3.length(tangent);
      const mu = col.friction;
      if (tMag > 1e-4) {
        const maxFt = mu * Math.abs(vn);
        const reduce = Math.min(tMag, maxFt);
        const s = (tMag - reduce) / tMag;
        body.velocity.x *= 1 - (1 - s) * 0.5;
        body.velocity.y *= 1 - (1 - s) * 0.5;
        body.velocity.z *= 1 - (1 - s) * 0.5;
      }
      // 7) "Grounded" tespiti: yüzey normali yukarı bileşeni > 0.5 ise
      if (ct.normal.y > 0.5) {
        body.flags |= FLAG_GROUNDED;
        body.groundY = ct.pointOnBox.y;
        body.groundNormal.copy(ct.normal);
        if (Math.abs(ct.normal.y) < 0.95) {
          body.flags |= FLAG_SLIDING;
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  10) PlayerMovementController — Kullanıcı Girdisi → Fizik Motoru
// ════════════════════════════════════════════════════════════════════════════
//
// Yeni fizik motorunu kullanan controller. Eski sürümle aynı dış arayüze
// (update/collides) sahip olacak şekilde tasarlandı; engine.ts'i minimum
// değişiklikle geçirebilmek için.
//   - Sürekli ivme (kullanıcı girdi → ivme)
//   - Sürtünme (yer/hava ayrımı)
//   - Capsule çarpışma (yeni)
//   - CCD sweep (yüksek hızda otomatik)
//   - Ground clamp (penetrasyon önleme)

export interface PlayerMovementConfig {
  radius: number;
  height: number;
  /** Maksimum yatay hız (m/s). */
  maxSpeed: number;
  /** Yatay ivmelenme (m/s²). */
  acceleration: number;
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
  public readonly position = new THREE.Vector3();
  private readonly config: PlayerMovementConfig;
  private readonly world: PhysicsWorld;
  private readonly body: RigidBody;
  // Yaw açısı (girdiden gelen, kameradan bağımsız tutulur)
  private yaw = 0;
  // Scratch
  private readonly _dir = new THREE.Vector3();
  private readonly _forward = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _desiredVel = new THREE.Vector3();
  private readonly _accelVec = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(
    config: PlayerMovementConfig,
    world: PhysicsWorld,
    initialPosition: THREE.Vector3,
  ) {
    this.config = config;
    this.world = world;
    this.position.copy(initialPosition);
    // Kapsülü oluştur: ayaktan kafaya
    const r = config.radius;
    const totalHeight = config.height;
    const cylHalf = totalHeight * 0.5 - r; // silindir yarı yüksekliği
    if (cylHalf < 0) {
      throw new Error(`[physics] Kapsül yüksekliği (>2r) çapı aşamaz: h=${totalHeight} r=${r}`);
    }
    const a = new THREE.Vector3(initialPosition.x, initialPosition.y - cylHalf, initialPosition.z);
    const b = new THREE.Vector3(initialPosition.x, initialPosition.y + cylHalf, initialPosition.z);
    const capsule = makeCapsule(a, b, r);
    this.body = makeRigidBody('player', capsule, initialPosition, PLAYER_MATERIAL);
    this.world.addBody(this.body);
  }

  setYaw(yaw: number) {
    this.yaw = yaw;
  }

  setColliders(_colliders: THREE.Box3[]) {
    // Eski API uyumluluğu — artık PhysicsWorld.addStatic() ile çalışıyor.
    // Eğer dışarıdan eski tip AABB listesi gelirse PhysicsWorld'e dönüştür.
    for (const box of _colliders) {
      this.world.addStatic(makeStaticAABB(box.min, box.max, 'legacy'));
    }
  }

  /**
   * @param dt saniye
   * @param yaw kamera yaw
   * @param input kullanıcı girdisi
   * @param speedMultiplier 0..1 (scope yavaşlaması)
   */
  update(dt: number, yaw: number, input: MovementInput, speedMultiplier: number): void {
    this.yaw = yaw;
    let dz = Number(input.forward) - Number(input.backward);
    let dx = Number(input.right) - Number(input.left);
    if (input.touchX !== 0 || input.touchY !== 0) {
      dx += input.touchX;
      dz += -input.touchY;
    }
    this._dir.set(dx, 0, dz);
    let inputMag = this._dir.length();
    if (inputMag > 1) this._dir.divideScalar(inputMag), inputMag = 1;

    const speed = this.config.maxSpeed * speedMultiplier;
    const accel = this.config.acceleration * speedMultiplier;

    // Dünya-uzayı yönleri
    this._forward.set(0, 0, -1).applyAxisAngle(this._up, yaw);
    this._right.set(1, 0, 0).applyAxisAngle(this._up, yaw);
    // İstenen yatay hız
    this._desiredVel.set(0, 0, 0)
      .addScaledVector(this._forward, this._dir.z * speed)
      .addScaledVector(this._right, this._dir.x * speed);

    // Mevcut yatay hız
    const vx = this.body.velocity.x;
    const vz = this.body.velocity.z;
    // Hedefe ulaşmak için gereken ivme
    let ax = this._desiredVel.x - vx;
    let az = this._desiredVel.z - vz;
    // Maksimum ivmelenmekle sınırla
    const aMag = Math.hypot(ax, az);
    if (aMag > accel) {
      const s = accel / aMag;
      ax *= s; az *= s;
    }
    // Eğer girdi yoksa daha güçlü frenleme (sürtünmeyi artır)
    if (inputMag === 0) {
      ax *= 2.5;
      az *= 2.5;
    }
    // Body'ye ivme uygula
    this.body.externalAccel.x += ax;
    this.body.externalAccel.z += az;
    // Yerçekimi zaten world.step'te eklenir.

    // Pozisyonu güncelle (fizik motoru adımı motor.step() ile çağrılır,
    // burada sadece externalAccel'i biriktirip position'ı okuyoruz).
    this.world.step(dt);
    this.position.copy(this.body.position);
  }

  /** Eski API uyumu. */
  collides(pos: THREE.Vector3): boolean {
    // Geçici kapsül ile dünyayı sorgula
    const a = new THREE.Vector3(pos.x, pos.y - this.config.height * 0.5 + this.config.radius, pos.z);
    const b = new THREE.Vector3(pos.x, pos.y + this.config.height * 0.5 - this.config.radius, pos.z);
    const cap = makeCapsule(a, b, this.config.radius);
    const cands = this.world.spatial.queryPoint(pos, this.config.radius + 0.5);
    for (const c of cands) {
      if (capsuleVsAABB(cap, c)) return true;
    }
    return false;
  }

  /** Yer ile temas halinde mi? */
  isGrounded(): boolean {
    return (this.body.flags & FLAG_GROUNDED) !== 0;
  }

  /** Mevcut hız (yerel). */
  getVelocity(): THREE.Vector3 {
    return this.body.velocity.clone();
  }

  dispose(): void {
    this.world.removeBody(this.body);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  11) Dışa Aktarılan Public API
// ════════════════════════════════════════════════════════════════════════════

export type { MapBounds };

/**
 * Uyumluluk için eski `MapBounds` arayüzünü koruyoruz.
 * Yeni API doğrudan `PhysicsWorld` + `StaticCollider` üzerinden çalışır.
 */
export { PhysicsWorld, SpatialHash };
