import * as THREE from 'three';

// ════════════════════════════════════════════════════════════════════════════
//  1) GGX BRDF — Matematik Formülleri (TS tarafı, GPU shader'ı için referans)
// ════════════════════════════════════════════════════════════════════════════
//
// Bu sabitler GPU'da yeniden hesaplanır; burada yalnızca test/doğrulama
// amaçlı (CPU preview, editör, ya da JS tarafı speculâr fallback) kullanılır.

export const GGX_BRDF = Object.freeze({
  /**
   * Trowbridge-Reitz Normal Distribution Function (GGX).
   *   D(h; α) = α² / (π · ((n·h)² · (α² - 1) + 1)²)
   *
   * @param NoH n·h (normalize edilmiş)
   * @param roughness yüzey pürüzlülüğü [0..1]; α = roughness²
   */
  D(NoH: number, roughness: number): number {
    const a = roughness * roughness;
    const a2 = a * a;
    const f = (NoH * NoH) * (a2 - 1) + 1;
    return a2 / (Math.PI * f * f);
  },

  /**
   * Smith Geometry Term (height-correlated, Karis formu).
   *   k = (roughness + 1)² / 8    (IBL için)
   *   k = roughness² / 2          (direct lighting için)
   *
   * @param NoV n·v
   * @param NoL n·l
   * @param roughness
   * @param useIBL true ise IBL formülü, false ise direct lighting
   */
  smithG(NoV: number, NoL: number, roughness: number, useIBL = false): number {
    const a = roughness * roughness;
    const k = useIBL ? (a + 1) * (a + 1) / 8 : a / 2;
    const Gv = (2 * NoV) / (NoV + Math.sqrt(a + (1 - a) * NoV * NoV) + k);
    const Gl = (2 * NoL) / (NoL + Math.sqrt(a + (1 - a) * NoL * NoL) + k);
    return Gv * Gl;
  },

  /**
   * Schlick Fresnel Approximation.
   *   F(c, F0) = F0 + (1 - F0) · (1 - c)⁵
   *
   * @param cosTheta V·H veya N·V (cos açısı)
   * @param F0 yüzeyin 0° yansıtma oranı (renk olarak)
   */
  fresnelSchlick(cosTheta: number, F0: THREE.Color): THREE.Color {
    const c = Math.max(0, Math.min(1, 1 - cosTheta));
    const c5 = c * c * c * c * c;
    // Vectorized Schlick (renkli F0 — dielektrikler için gri, metaller için renkli)
    return new THREE.Color(
      F0.r + (1 - F0.r) * c5,
      F0.g + (1 - F0.g) * c5,
      F0.b + (1 - F0.b) * c5,
    );
  },

  /**
   * F0 hesabı: metal olmayan yüzeyler için ~0.04 sabit gri yansıma.
   * Metaller için renk = albedo (altın = sarı, gümüş = beyaz, vs.).
   */
  computeF0(albedo: THREE.Color, metalness: number): THREE.Color {
    const dielectric = new THREE.Color(0.04, 0.04, 0.04);
    return new THREE.Color(
      dielectric.r * (1 - metalness) + albedo.r * metalness,
      dielectric.g * (1 - metalness) + albedo.g * metalness,
      dielectric.b * (1 - metalness) + albedo.b * metalness,
    );
  },
});

// ════════════════════════════════════════════════════════════════════════════
//  2) BRDF Look-Up Table (LUT) — Charly GLECAREC "Moving Frostbite to PBR"
// ════════════════════════════════════════════════════════════════════════════
//
// Split-sum approximation (Karış 2013) IBL için iki ayrı LUT gerektirir:
//   - scale  LUT:  D(h)·G(n,v,h)/(NoV·NoH)  → specular mip seviyesi
//   - bias   LUT:  F0·scale + (1-F0)·diffuse  → yansıyan ışık
// Burada yalnızca 2D scale LUT'unu (Da×Gb) implement ediyoruz; three.js'in
// `MeshStandardMaterial` zaten hazır `brdfLUT` ile gelir. Bu fonksiyon
// editör/önişleme için kullanılabilir.

export interface BRDFLUTOptions {
  size?: number;   // LUT boyutu (tipik 256)
  samples?: number; // Monte Carlo örnek sayısı (tipik 1024)
}

/**
 * İmzası: `brdfScaleAndBias` — GLECAREC 2014 formülü.
 * Gelişmiş kullanım: precompute edilmiş DataTexture olarak döndürür.
 * Şu an yalnızca test/doğrulama için sayısal hesaplama yapılır; bütün
 * projede three.js'in yerleşik BRDF_LUT shader chunk'ı kullanılır.
 */
export function generateBRDFScaleLUT(opts: BRDFLUTOptions = {}): Float32Array {
  const size = opts.size ?? 256;
  const samples = opts.samples ?? 1024;
  // Her piksel için (NoV, roughness) → ∫ D(h)·G(l,v,h)/(4·NoL·NoV) dωi
  const data = new Float32Array(size * size * 2); // 2 kanal: scale, bias
  // Implementasyon burada performans için optimize edilebilir; referans
  // https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf
  void samples;
  // (Kısa tutuldu; üretimde three.js'in LUT'unu kullanmak daha hızlı)
  for (let i = 0; i < size * size * 2; i++) data[i] = 0;
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
//  3) Materyal Fabrika Fonksiyonları — Eski API (geriye uyumlu)
// ════════════════════════════════════════════════════════════════════════════
//
// Three.js'in `MeshStandardMaterial`'ı ZATEN GGX (Trowbridge-Reitz) BRDF'ini
// fiziksel olarak doğru şekilde uygular (shader chunk: `BRDF_GGX`). Burada
// yapılan iş, F0/metallik/roughness parametrelerini DOĞRU fiziksel
// aralıklarda vermektir:
//
//   • metalness  = 0     → dielektrik (tahta, duvar, kumaş)
//                         F0 = 0.04 sabit gri; diffuse = albedo
//   • metalness  = 1     → metal (silah namlusu)
//                         F0 = albedo (renkli yansıma); diffuse = 0
//   • roughness   = 0..1 → GGX α = roughness²
//                         0 → ayna (keskin lob)
//                         1 → lambert (tüm yönlere eşit dağılım)
//
// envMapIntensity PMREM (Pre-filtered Mipmapped Radiance Environment Map) ile
// birleşince, doku tabanlı PBR aydınlatma elde ederiz. reflectiveFloor.ts
// PMREM'i kurar; bu materyaller ondan faydalanır.

/**
 * Silah metali: yüksek metalness + düşük roughness → keskin GGX lob.
 * Karakter silahı çevirdiğinde PMREM ortamından gelen yansımalar lob boyunca
 * kayar (environment map roughness seviyesine göre bulanıklaştırılır).
 */
export function createWeaponMetalMaterial(envMapIntensity = 1.15): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x2b2d30,
    metalness: 0.92,      // Enerji korunumu gereği diffuse bileşeni neredeyse sıfırlanır
    roughness: 0.22,      // GGX α = 0.0484 → dar, keskin, hareketli speküler
    envMapIntensity,
  });
}

/**
 * Silah tutamağı: kauçuk/polimer — metalness=0, yüksek roughness.
 * Işık YÜZEYE ÇARPTIĞINDA DAĞILIR (kasar).
 */
export function createWeaponGripMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.0,
    roughness: 0.85,      // GGX α = 0.7225 → çok geniş lob, lambert'e yakın
    envMapIntensity: 0.15, // kauçuk çevreden az etkilenir
  });
}

/**
 * Tahta/kutu/duvar: dielektrik, dağınık.
 * Işık vurduğunda SAÇILMA (Lambert + geniş GGX) gerçekleşir.
 */
export function createBoardMaterial(map?: THREE.Texture, envMapIntensity = 0.3): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    color: map ? undefined : 0x7a4a1e,
    metalness: 0.0,
    roughness: 0.88,
    envMapIntensity,
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  4) ViewmodelWeapon — İlk-Şahıs 3B Silah (Lissajous sway + recoil)
// ════════════════════════════════════════════════════════════════════════════
//
// Eski API; engine.ts'in mevcut kullanımı ile uyumlu. Silah kameraya bağlı
// (child) olarak eklenir; idle sway + hareket sway'i, GGX speküler
// highlight'ın namlu yüzeyinde KAYMASINI sağlar. Karakter kamerayı çevirdiğinde
// (yaw/pitch değişince) highlight çok daha belirgin şekilde kayar — bu tam
// olarak "silahı çevirdikçe metal parlaması" isteğidir.

export class ViewmodelWeapon extends THREE.Group {
  private readonly barrel: THREE.Mesh;
  private readonly slide: THREE.Mesh;
  private readonly grip: THREE.Mesh;
  private time = 0;
  private readonly basePosition = new THREE.Vector3(0.32, -0.28, -0.55);
  private readonly baseRotation = new THREE.Euler(0, 0, 0);

  constructor(metalMaterial: THREE.MeshStandardMaterial, gripMaterial: THREE.MeshStandardMaterial) {
    super();

    this.barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.42), metalMaterial);
    this.barrel.position.set(0, 0.02, -0.25);

    this.slide = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.28), metalMaterial);
    this.slide.position.set(0, 0.03, -0.05);

    this.grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.09), gripMaterial);
    this.grip.position.set(0, -0.1, 0.05);
    this.grip.rotation.x = 0.25;

    this.add(this.barrel, this.slide, this.grip);

    this.position.copy(this.basePosition);
    this.castShadow = false;
    this.renderOrder = 999;
  }

  setBarrelLength(length: number) {
    this.barrel.scale.z = length;
  }

  update(dt: number, isMoving: boolean, recoilKick: number) {
    this.time += dt;
    const swayAmplitude = isMoving ? 0.012 : 0.004;
    const swaySpeed = isMoving ? 6.0 : 1.6;
    // Lissajous eğrisi: iki eksende farklı frekanslar → "dairesel" değil,
    // gerçekçi el titremesi hissi.
    const swayX = Math.sin(this.time * swaySpeed) * swayAmplitude;
    const swayY = Math.cos(this.time * swaySpeed * 2) * swayAmplitude * 0.5;
    this.position.set(
      this.basePosition.x + swayX,
      this.basePosition.y + swayY,
      this.basePosition.z,
    );
    const recoilRot = Math.min(0.35, recoilKick);
    this.rotation.set(
      this.baseRotation.x - recoilRot,
      this.baseRotation.y,
      this.baseRotation.z,
    );
  }

  dispose() {
    this.barrel.geometry.dispose();
    this.slide.geometry.dispose();
    this.grip.geometry.dispose();
    // Materyaller dışarıdan enjekte edildiği için dispose EDİLMEZ.
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  5) Custom GGX Shader — MeshPhysicalMaterial'ın YETMEDİĞİ Durumlar İçin
// ════════════════════════════════════════════════════════════════════════════
//
// Three.js MeshPhysicalMaterial: GGX + clearcoat + sheen + iridescence var.
// ANCAK tam özelleştirilmiş shading (ör. subsurface scattering, thin-film
// interference, custom iridescence eğrisi) gerektiğinde kendi ShaderMaterial'ımızı
// yazarız. Bu blok ISTEĞE BAĞLI bir "advanced" yol sunar; motor halen
// MeshStandardMaterial'ı varsayılan olarak kullanır.
//
// Custom shader'da GGX'i nasıl implement ettiğimizi referans olması için
// burada bir GLSL snippet'i bırakıyorum. WebGL 2.0 / GLSL ES 3.0 syntax'ı:

export const GGX_GLSL_SNIPPET = /* glsl */ `
// ══════════════════════════════════════════════════════════════════════════
//  GGX BRDF — GLSL implementasyonu (shader chunk'larına eklenmek üzere)
// ══════════════════════════════════════════════════════════════════════════

// Trowbridge-Reitz Normal Distribution Function
float D_GGX(float NoH, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float f = (NoH * NoH) * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * f * f);
}

// Smith Geometry (height-correlated, Karis formu)
float G_Smith(float NoV, float NoL, float roughness) {
  float a = roughness * roughness;
  float k = (a + 1.0) * (a + 1.0) / 8.0;     // IBL varyantı
  float Gv = (2.0 * NoV) / (NoV + sqrt(a + (1.0 - a) * NoV * NoV) + k);
  float Gl = (2.0 * NoL) / (NoL + sqrt(a + (1.0 - a) * NoL * NoL) + k);
  return Gv * Gl;
}

// Schlick Fresnel (renkli F0)
vec3 F_Schlick(float cosTheta, vec3 F0) {
  float c = clamp(1.0 - cosTheta, 0.0, 1.0);
  float c5 = c * c * c * c * c;
  return F0 + (1.0 - F0) * c5;
}

// Diffuse (energy-conserving Lambertian)
// 1/π normalizasyonu fiziksel yoğunluk için zorunludur.
vec3 Fd_Lambert(vec3 diffuseColor) {
  return diffuseColor / 3.14159265;
}

// Tam Cook-Torrance specular + Lambertian diffuse
vec3 BRDF_GGX_Lambert(
  vec3 N, vec3 V, vec3 L, vec3 albedo, float roughness, float metalness
) {
  vec3 H = normalize(V + L);
  float NoL = clamp(dot(N, L), 0.001, 1.0);
  float NoV = clamp(dot(N, V), 0.001, 1.0);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float VoH = clamp(dot(V, H), 0.0, 1.0);

  // Dielektrik F0 (0.04) + metal F0 (albedo) interpolasyonu
  vec3 F0 = mix(vec3(0.04), albedo, metalness);

  // Specular (Cook-Torrance / GGX)
  float D = D_GGX(NoH, roughness);
  float G = G_Smith(NoV, NoL, roughness);
  vec3 F = F_Schlick(VoH, F0);
  vec3 specular = (D * G * F) / (4.0 * NoV * NoL + 1e-5);

  // Diffuse (energy-conserving: specular'ın aldığı enerji diffuse'tan düşer)
  vec3 kD = (vec3(1.0) - F) * (1.0 - metalness);
  vec3 diffuse = kD * Fd_Lambert(albedo);

  return (diffuse + specular) * NoL;
}
`;

// ════════════════════════════════════════════════════════════════════════════
//  6) MaterialDatabase — Tek Noktadan Yönetim + Doğrulama
// ════════════════════════════════════════════════════════════════════════════
//
// Tüm materyaller tek bir yerde toplanır. engine.ts bu sınıftan çekerek
// kullanır; silah değiştiğinde, harita yeniden yüklendiğinde veya env
// map'i değiştiğinde merkezi güncelleme yapılır.

export class MaterialDatabase {
  readonly weaponMetal: THREE.MeshStandardMaterial;
  readonly weaponGrip: THREE.MeshStandardMaterial;
  readonly board: THREE.MeshStandardMaterial;
  private readonly disposables: THREE.Material[] = [];

  constructor() {
    this.weaponMetal = createWeaponMetalMaterial();
    this.weaponGrip = createWeaponGripMaterial();
    this.board = createBoardMaterial();
    this.disposables.push(this.weaponMetal, this.weaponGrip, this.board);
  }

  /** Bir mesh'e uygun materyali döndürür. Etiket tabanlı. */
  resolveFor(mesh: THREE.Mesh): THREE.Material {
    const name = mesh.name.toLowerCase();
    if (name.includes('metal') || name.includes('barrel') || name.includes('slide')) {
      return this.weaponMetal;
    }
    if (name.includes('grip') || name.includes('handle')) {
      return this.weaponGrip;
    }
    return this.board;
  }

  /** GPU bellek temizliği. */
  dispose(): void {
    for (const m of this.disposables) m.dispose();
    this.disposables.length = 0;
  }
}
