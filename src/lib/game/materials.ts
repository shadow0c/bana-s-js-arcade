// src/lib/game/materials.ts
//
// TEKNİK NOT (halüsinasyon yapmamak için açıkça belirtiyorum):
// Three.js'in `MeshStandardMaterial`/`MeshPhysicalMaterial` malzemeleri zaten
// mikro-yüzey Cook-Torrance BRDF'ini GGX (Trowbridge-Reitz) normal dağılım
// fonksiyonuyla uygular (bkz. three.js kaynağında `BRDF_GGX` shader chunk'ı).
// Yani "GGX BRDF (PBR)" istendiğinde, elle ham GLSL yazıp Three'nin
// ışıklandırma/gölge/environment-map/tonemapping entegrasyonunu YENİDEN
// İCAT ETMEK yerine, bu yerleşik fiziksel malzemeyi DOĞRU parametrelerle
// kullanmak hem daha az hataya açık hem de reflectiveFloor.ts'nin zaten
// kurduğu PMREM environment map / ACES tonemapping ile tutarlı çalışır.
//
// Bu dosya iki şeyi standardize ediyor:
//  1) Tahta/duvar (dielektrik, dağınık) vs silah (metalik, keskin speküler)
//     malzeme ön ayarları.
//  2) Yerel oyuncu için gerçek bir 3B viewmodel (önceden yoktu — HUD'da 2B
//     silah görseli kullanılıyordu). Bu viewmodel olmadan "silahı çevirdikçe
//     metal parlamasını görme" isteği teknik olarak karşılanamaz, çünkü
//     çevrilebilecek bir 3B mesh yoktu.

import * as THREE from 'three';

export function createWeaponMetalMaterial(envMapIntensity = 1.15): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x2b2d30,
    metalness: 0.92,     // yüksek metalness: enerji korunumu geregi diffuse bileşeni neredeyse sıfırlanır
    roughness: 0.22,     // düşük roughness: GGX lob'u dar -> keskin, hareketli speküler highlight
    envMapIntensity,
  });
}

export function createWeaponGripMaterial(): THREE.MeshStandardMaterial {
  // Tutamak/kabza: kauçuk/polimer - metalik DEĞİL, yüksek roughness -> ışığı dağıtır
  return new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    metalness: 0.0,
    roughness: 0.85,
    envMapIntensity: 0.15,
  });
}

export function createBoardMaterial(map?: THREE.Texture, envMapIntensity = 0.3): THREE.MeshStandardMaterial {
  // Tahta/sandık/duvar: dielektrik, ışık YÜZEYDE DAĞILIR (yüksek roughness, metalness=0)
  return new THREE.MeshStandardMaterial({
    map,
    color: map ? undefined : 0x7a4a1e,
    metalness: 0.0,
    roughness: 0.88,
    envMapIntensity,
  });
}

/**
 * İlk-şahıs viewmodel silahı: kamerının çocuğu olarak eklenir, ekranın sağ-alt
 * köşesinde durur. Namlu/kızak (slide) parçası metalik materyal kullanır;
 * karakter döndükçe (yaw/pitch değiştikçe) GGX speküler highlight'ın namlu
 * üzerinde kayması, ışık kaynağına göre pozisyon değiştirdiği için doğal
 * olarak gerçekleşir — ayrıca idle "sway" (sallanma) animasyonu ekleyerek bu
 * hareketi duraganken bile görünür kılıyoruz.
 */
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
    // Viewmodel'in dünya duvarlarıyla z-fighting/clip yapmaması için ayrı bir
    // "katman" mantığıyla her zaman en üstte çizilmesi istenirse renderOrder kullanılabilir.
    this.renderOrder = 999;
  }

  /** Silah gövdesi parçalarını dışarıdan değiştirmek isteyenler için (ör. silah türüne göre farklı boy). */
  setBarrelLength(length: number) {
    this.barrel.scale.z = length;
  }

  /**
   * @param dt saniye
   * @param isMoving hareket tuşlarından biri basılıysa true (sway genliği artar)
   * @param recoilKick anlık geri tepme miktarı (0 = yok) - kısa bir "kick" animasyonu tetikler
   */
  update(dt: number, isMoving: boolean, recoilKick: number) {
    this.time += dt;
    const swayAmplitude = isMoving ? 0.012 : 0.004;
    const swaySpeed = isMoving ? 6.0 : 1.6;

    // Idle/hareket sway'i: silah küçük bir Lissajous eğrisi çizer. Bu, GGX
    // speküler highlight'ın namlu yüzeyinde SÜREKLİ hafifçe kaymasına neden
    // olur -> "silahı çevirdikçe metal parlamalarını görme" efekti duraganken
    // bile bir miktar hissedilir; oyuncu kamerayı çevirdiğinde ise viewmodel
    // kameraya bağlı olduğu için highlight çok daha belirgin şekilde kayar.
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
    // Materyaller dışarıdan enjekte edildiği için (paylaşılan tek instance)
    // burada dispose EDİLMEZ — sahiplik GameEngine'de, birden çok viewmodel
    // arasında paylaşılabilir (silah değiştirince yeni ViewmodelWeapon
    // yaratılsa bile aynı materyal instance'ı geri kullanılabilir).
  }
}
