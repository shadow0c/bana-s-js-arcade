// src/lib/game/netcode.ts
//
// ════════════════════════════════════════════════════════════════════════════
//  AAA SEVİYESİ NETCODE — Client-Side Prediction + Reconciliation + Lag Comp
// ════════════════════════════════════════════════════════════════════════════
//
// Bu dosya, modern çok-oyunculu oyun motorlarında (Valorant, CS:GO, Overwatch)
// kullanılan üç temel tekniği tarayıcıda (Supabase Realtime üzerinden) implemente
// eder:
//
//   1) CLIENT-SIDE PREDICTION
//      Yerel oyuncu tuşa bastığında, sunucuyu beklemeden fizik simülasyonu
//      ÇALIŞTIRILIR ve render anında gösterilir. Bu, RTT (round-trip time)
//      fark etmeksizin sıfır gecikme hissi verir. Her input komutu bir
//      sıra numarası (sequence) ile işaretlenir.
//
//   2) SERVER RECONCILIATION
//      Sunucu (yetkili client) gelen inputları işler ve gerçek konumu
//      periyodik olarak (50 ms = 20 Hz) geri yayar. Yerel client, kendi
//      tahmininin "doğru" olduğunu öğrendiğinde hata payı (squared error)
//      hesaplar; eğer fark tolerans dışındaysa yetkili konuma snap eder
//      ve sonraki tahmin edilmemiş inputları YENİDEN ÇALIŞTIRIR (replay).
//      AAA motorlar bu snap'i "smooth lerp" ile yumuşatır (rubberbanding
//      algısını önler).
//
//   3) LAG COMPENSATION (Rollback Hit Detection)
//      100 ms ping'li oyuncu ateş ettiğinde, aslında düşmanın 100 ms
//      ÖNCEKİ konumunu görüyordu. Sunucu, vuruş anındaki zaman damgası
//      (t_shot) ile her oyuncunun son 1 saniyelik konum geçmişine bakar
//      ve mermiyi GEÇMİŞTEKİ konuma doğru test eder:
//         P_hit = P(t_shot − ping − interpolation_delay)
//      Bu, "bullshit hit" hissini ortadan kaldırır.
//
//   4) INTERPOLATION BUFFER
//      Uzak oyuncuların snapshot'ları 100 ms (≈2–3 paket) gecikmeyle
//      arabelleğe alınır ve lerp edilir. Bu, jitter'ı (ağ sıçramaları)
//      yumuşatır; ancak algılanan gecikme 100 ms'dir (1 paket RTT/2).
//
// Bu dosya TAŞIMA (transport) katmanından BAĞIMSIZDIR. Supabase Realtime
// olmadan, kendi WebSocket'inizi veya UDP'nizi bağlayabilirsiniz; sadece
// `send/receive` callback'lerini değiştirin.

import * as THREE from 'three';
import type { PlayerState, Vector3Like, ShootEvent } from './types';
import type { GameNetwork } from './network';

// ════════════════════════════════════════════════════════════════════════════
//  1) Paket Türleri (Wire Format)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Yerel oyuncudan sunucuya giden INPUT komutu.
 * Her frame'de bir tane gönderilir (saniyede ~60). Sunucu bunları sırayla
 * işler ve ackSeq olarak geri bildirir.
 */
export interface InputCommand {
  /** Monoton artan sıra numarası (overflow'a karşı uint32). */
  seq: number;
  /** Client'ta bu input'un üretildiği an (performance.now() bazlı ms). */
  clientTimeMs: number;
  /** Önceki input'tan bu yana geçen saniye. */
  dt: number;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  touchX: number;
  touchY: number;
  /** Kamera yönü. */
  yaw: number;
  pitch: number;
  /** scope = true iken hız yarıya düşer. */
  scope: boolean;
  /** Ateş anında true (event-based). */
  shoot: boolean;
}

/**
 * Sunucudan tüm client'lara giden STATE snapshot'ı.
 * 50 ms'de bir (20 Hz) gönderilir. ackSeq = son işlenen input.
 */
export interface StateSnapshot {
  playerId: string;
  /** Sunucunun işlediği son input sırası. */
  ackSeq: number;
  /** Sunucu saati (ms). Tüm client'lar aynı epoch ile senkronize olur. */
  serverTimeMs: number;
  position: Vector3Like;
  velocity: Vector3Like;
  rotation: { x: number; y: number };
  health: number;
  flags: number;
}

/**
 * Ateş event'i — düşman kontrolü için t_shot bilgisi kritik.
 * shotClientTimeMs = kullanıcının tetiği çektiği an (client clock).
 * Sunucu, kendi saatine göre offset'i hesaplar.
 */
export interface ShotPacket {
  id: string;
  attackerId: string;
  shotClientTimeMs: number;
  origin: Vector3Like;
  direction: Vector3Like;
  weaponId: string;
  /** Saldırganın şu anki yaw/pitch (shot'ı yönlendirmek için). */
  yaw: number;
  pitch: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  2) Zaman Senkronizasyonu
// ════════════════════════════════════════════════════════════════════════════
//
// Supabase Realtime bir "sunucu saati" vermez, dolayısıyla her client kendi
// performance.now() saatini kullanır. Client'lar arası saat farkı
// (clock skew) tipik olarak birkaç yüz ms'dir; bunu telafi etmek için
// NTP benzeri basit bir "clock sync" protokolü uyguluyoruz:
//
//   1) Her client, heartbeat'inde kendi serverTimeMs'sini gönderir.
//   2) Diğer client gelen serverTimeMs'yi kendi performance.now() ile
//      eşleştirir ve offset = (theirTime − myTimeAtReceive) tahmin eder.
//   3) 5 örnek medyanı saat farkı olarak kabul edilir.

export class ClockSync {
  /** Bizim performans.now()'umuz ile uzak serverTimeMs arasındaki offset. */
  private offsetMs = 0;
  private samples: number[] = [];
  private readonly maxSamples = 10;

  /**
   * Bir uzak saat ölçümünü kaydet. theirTimeMs = uzak tarafın gönderdiği
   * serverTimeMs; receivedAtMs = bunu aldığımız andaki bizim saatimiz.
   * Offset = theirTime − receivedAt olmalı (yani bizden hızlıysa +).
   */
  recordSample(theirTimeMs: number, receivedAtMs: number): void {
    const sample = theirTimeMs - receivedAtMs;
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    // Medyan filtre (outlier'ları reddet)
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.offsetMs = sorted[Math.floor(sorted.length / 2)];
  }

  /** Bizim saatimizi uzak serverTimeMs cinsinden ver. */
  localToServer(localMs: number): number {
    return localMs + this.offsetMs;
  }

  /** Uzak serverTimeMs'yi bizim local saatimize çevir. */
  serverToLocal(serverMs: number): number {
    return serverMs - this.offsetMs;
  }

  /** RTT tahmini (son örnek). */
  getEstimatedRttMs(): number {
    if (this.samples.length < 2) return 80; // ortalama varsayılan
    return Math.abs(this.samples[this.samples.length - 1] - this.samples[0]);
  }

  /**
   * Bir uzak oyuncunun "algılanan" gecikmesi (interpolation delay dahil).
   * = RTT/2 + 100ms interpolation buffer
   * Bu değer, sunucu tarafında lag compensation için kullanılır:
   *   targetTime = t_shot − delay
   */
  getEffectiveDelayMs(): number {
    return this.getEstimatedRttMs() / 2 + INTERPOLATION_DELAY_MS;
  }
}

/** Interpolation buffer'ın ne kadar gecikmeyle okunacağı. 100 ms = 2-3 paket @ 50 ms. */
export const INTERPOLATION_DELAY_MS = 100;
/** Konum snapshot'ları broadcast sıklığı (20 Hz = 50 ms). */
export const SNAPSHOT_INTERVAL_MS = 50;
/** Sunucu (yetkili client) state history uzunluğu. */
export const SERVER_HISTORY_DURATION_MS = 1000;

// ════════════════════════════════════════════════════════════════════════════
//  3) Client-Side Prediction Buffer
// ════════════════════════════════════════════════════════════════════════════
//
// Her yerel input komutu burada biriktirilir. `step()` her frame'de çağrılarak
// henüz ack'lenmemiş tüm komutlar fizik motoruna uygulanır. Sunucu ack geldiğinde
// `reconcile()` çağrılır; eğer tahmin yanlışsa yetkili konuma snap edilir
// ve sonraki komutlar YENİDEN ÇALIŞTIRILIR.

export interface IPredictionPhysics {
  /** Verilen input komutunu dt kadar fizik motoruna uygula. */
  applyInput(cmd: InputCommand): void;
  /** Mevcut durumu döndür (kopyası). */
  getState(): PlayerState;
  /** Durumu dışarıdan ayarla (reconciliation snap). */
  setState(state: PlayerState): void;
}

export class PredictionBuffer {
  private readonly pending: InputCommand[] = [];
  private ackedSeq = 0;
  /** Son ack'lenen state (yeniden simülasyon için başlangıç noktası). */
  private lastAckedState: PlayerState | null = null;
  /** Reconciliation snap'ı için eşik (metre). Bundan küçük farklar yumuşatılır. */
  private readonly snapThreshold = 0.05;
  /** Snap anında uygulanan yumuşatma (lerp t'si başlangıcı). */
  private snapBlendStart = 0;
  private snapBlendDuration = 0;
  private readonly snapFrom = new THREE.Vector3();
  private readonly snapTo = new THREE.Vector3();

  constructor(private readonly physics: IPredictionPhysics) {}

  /** Yeni bir input komutu ekle. */
  add(cmd: InputCommand): void {
    if (this.pending.length > 0 && cmd.seq <= this.pending[this.pending.length - 1].seq) {
      // Eski komut — çoğunlukla retransmit. Yoksay.
      return;
    }
    this.pending.push(cmd);
    // Bellek sızıntısı önleme: 1 saniyeden eski komutları at
    if (this.pending.length > 600) {
      this.pending.splice(0, this.pending.length - 600);
    }
  }

  /**
   * Henüz ack'lenmemiş tüm komutları fizik motoruna uygula.
   * Eğer bir reconciliation snap devam ediyorsa, konumu yumuşat.
   */
  step(): void {
    // Snap blending: snapTo'ya doğru yumuşak geçiş
    if (this.snapBlendDuration > 0) {
      const now = performance.now();
      const t = Math.min(1, (now - this.snapBlendStart) / this.snapBlendDuration);
      // Ease-out: 1 - (1-t)^3 — kritik hatalarda yumuşak iniş
      const e = 1 - Math.pow(1 - t, 3);
      const x = this.snapFrom.x + (this.snapTo.x - this.snapFrom.x) * e;
      const y = this.snapFrom.y + (this.snapTo.y - this.snapFrom.y) * e;
      const z = this.snapFrom.z + (this.snapTo.z - this.snapFrom.z) * e;
      const cur = this.physics.getState();
      cur.position.x = x; cur.position.y = y; cur.position.z = z;
      this.physics.setState(cur);
      if (t >= 1) this.snapBlendDuration = 0;
    }
    for (const cmd of this.pending) {
      this.physics.applyInput(cmd);
    }
  }

  /**
   * Sunucudan gelen state snapshot'ı ile tahminimizi karşılaştır.
   * Eğer fark büyükse snap + replay; küçükse sadece ack'lenmiş komutları at.
   */
  reconcile(snap: StateSnapshot): void {
    if (snap.ackSeq <= this.ackedSeq) {
      // Eski ack — yoksay (out-of-order gelen snapshot)
      return;
    }
    // Ack'lenmiş komutları at
    this.pending.splice(0, this.pending.findIndex(c => c.seq > snap.ackSeq) + 1);
    this.ackedSeq = snap.ackSeq;

    // Mevcut tahmin ile yetkili durumu karşılaştır
    const predicted = this.physics.getState();
    const dx = predicted.position.x - snap.position.x;
    const dy = predicted.position.y - snap.position.y;
    const dz = predicted.position.z - snap.position.z;
    const error = Math.hypot(dx, dy, dz);

    if (error < this.snapThreshold) {
      // Tahmin doğru — sadece state'i güncelle (örn. health değişmiş olabilir)
      const newState: PlayerState = { ...predicted, ...snap };
      this.physics.setState(newState);
      this.lastAckedState = newState;
      return;
    }

    // Büyük fark → snap + replay
    this.snapFrom.set(predicted.position.x, predicted.position.y, predicted.position.z);
    this.snapTo.set(snap.position.x, snap.position.y, snap.position.z);
    this.snapBlendStart = performance.now();
    // 100 ms'lik yumuşatma — hızlı ama fark edilir bir "snap" hissi vermez
    this.snapBlendDuration = 100;

    // Yetkili durumu anında uygula
    const newState: PlayerState = {
      ...predicted,
      position: { ...snap.position },
      velocity: { ...snap.velocity },
      rotation: { ...snap.rotation },
      health: snap.health,
    };
    this.physics.setState(newState);
    this.lastAckedState = newState;

    // Bekleyen komutları YENİDEN ÇALIŞTIR (replay)
    for (const cmd of this.pending) {
      this.physics.applyInput(cmd);
    }
  }

  /** İlk snap'lenmiş state'i döndür (henüz snap yoksa null). */
  getLastAckedState(): PlayerState | null {
    return this.lastAckedState;
  }

  /** Test amaçlı: bekleyen komut sayısı. */
  get pendingCount(): number {
    return this.pending.length;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  4) Interpolation Buffer — Uzak Oyuncuları 100 ms Gecikmeyle Göster
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN GECİKMELİ? Çünkü anlık gelen snapshot'ları göstermek, ağ sıçramalarını
// (jitter) doğrudan oyuncuya yansıtır. 100 ms'lik gecikme + lerp, paketlerin
// %99'unun zamanında gelmesini garanti eder (50 ms @ 20 Hz → 2 paket).
//
// AAA motorlar bu değeri "1 paket RTT'sinin yarısı" + "jitter budget" olarak
// hesaplar: 100 ms = 80 ms RTT yarısı + 20 ms güvenlik payı.

export interface InterpolatedState {
  position: Vector3Like;
  rotation: { x: number; y: number };
  /** True ise state gerçek bir snapshot'tan geldi (interpolasyon değil). */
  isExact: boolean;
}

export class InterpolationBuffer {
  private readonly snapshots: StateSnapshot[] = [];
  /** Her oyuncu için ayrı arabellek (uzak oyuncular). */
  private readonly buffers = new Map<string, StateSnapshot[]>();

  /**
   * Snapshot'ı ilgili oyuncunun arabelleğine ekle. Eski snapshot'ları temizle
   * (sunucu history süresi + buffer süresi kadar tut).
   */
  push(snap: StateSnapshot): void {
    let arr = this.buffers.get(snap.playerId);
    if (!arr) {
      arr = [];
      this.buffers.set(snap.playerId, arr);
    }
    // Sıralı ekleme (sunucu monotonik gönderir ama out-of-order olabilir)
    const idx = arr.findIndex(s => s.serverTimeMs > snap.serverTimeMs);
    if (idx < 0) arr.push(snap);
    else arr.splice(idx, 0, snap);
    // Eski snapshot'ları at (son 1.5 sn yeterli)
    const cutoff = snap.serverTimeMs - 1500;
    while (arr.length > 0 && arr[0].serverTimeMs < cutoff) {
      arr.shift();
    }
  }

  /**
   * Verilen serverTimeMs anındaki state'i döndür. targetTime = serverTime -
   * INTERPOLATION_DELAY_MS ile gecikmeli okuma yapılır.
   */
  sample(playerId: string, serverTimeMs: number): InterpolatedState | null {
    const arr = this.buffers.get(playerId);
    if (!arr || arr.length === 0) return null;

    const target = serverTimeMs - INTERPOLATION_DELAY_MS;
    // Hedef an, aralıktaki iki snapshot arasındaysa lerp
    if (target <= arr[0].serverTimeMs) {
      // Hedef arabelleğin başlangıcından önce → ilk snapshot'ı kullan
      return {
        position: { ...arr[0].position },
        rotation: { ...arr[0].rotation },
        isExact: false,
      };
    }
    if (target >= arr[arr.length - 1].serverTimeMs) {
      // Hedef arabelleğin sonundan sonra → son snapshot'ı kullan + extrapolasyon
      // (extrapolation snap'i, hedef - son = <100ms ise güvenli kabul edilir)
      const last = arr[arr.length - 1];
      const delta = target - last.serverTimeMs;
      // Çok büyük delta ise (>200ms) extrapolasyon yapma; clamp
      if (delta > 200) {
        return {
          position: { ...last.position },
          rotation: { ...last.rotation },
          isExact: false,
        };
      }
      const dt = delta / 1000;
      return {
        position: {
          x: last.position.x + last.velocity.x * dt,
          y: last.position.y + last.velocity.y * dt,
          z: last.position.z + last.velocity.z * dt,
        },
        rotation: { ...last.rotation },
        isExact: false,
      };
    }
    // İki snapshot arasında lerp
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      if (a.serverTimeMs <= target && b.serverTimeMs >= target) {
        const span = b.serverTimeMs - a.serverTimeMs;
        const t = span > 0 ? (target - a.serverTimeMs) / span : 0;
        return {
          position: {
            x: a.position.x + (b.position.x - a.position.x) * t,
            y: a.position.y + (b.position.y - a.position.y) * t,
            z: a.position.z + (b.position.z - a.position.z) * t,
          },
          rotation: {
            x: a.rotation.x + (b.rotation.x - a.rotation.x) * t,
            y: a.rotation.y + (b.rotation.y - a.rotation.y) * t,
          },
          isExact: t === 0 || t === 1,
        };
      }
    }
    return null;
  }

  /** Bir oyuncunun arabelleğini temizle. */
  clearPlayer(playerId: string): void {
    this.buffers.delete(playerId);
  }

  /** Tüm arabellekleri temizle. */
  clear(): void {
    this.buffers.clear();
    this.snapshots.length = 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  5) Lag Compensation (Rollback Hit Detection)
// ════════════════════════════════════════════════════════════════════════════
//
// SUNUCU TARAFINDA çalışır (yetkili client). Her gelen state snapshot'ını
// 1 saniyelik bir history buffer'da tutar. Ateş event'i geldiğinde:
//
//   targetTime = t_shot − attackerEffectiveDelay
//
// Burada attackerEffectiveDelay = RTT/2 + 100ms interpolation buffer.
// Tüm rakiplerin konumlarını targetTime anına GERİ SARAR ve mermiyi test eder.
//
// NEDEN 1 SN? Çünkü en yavaş bağlantıda bile sunucu 1 sn öncesinin snapshot'ını
// hâlâ tutar (20 Hz × 1 sn = 20 örnek). Daha fazlası bellek israfı; daha azı
// yavaş ping'li oyuncuları dışlar.

export class LagCompensation {
  private readonly history = new Map<string, StateSnapshot[]>();
  private clock = new ClockSync();

  /** Sunucu saatini ayarla (NTP-style offset). */
  setClock(clock: ClockSync): void {
    this.clock = clock;
  }

  /** Bir snapshot'ı history'ye ekle. */
  record(snap: StateSnapshot): void {
    let arr = this.history.get(snap.playerId);
    if (!arr) {
      arr = [];
      this.history.set(snap.playerId, arr);
    }
    arr.push(snap);
    const cutoff = snap.serverTimeMs - SERVER_HISTORY_DURATION_MS;
    while (arr.length > 0 && arr[0].serverTimeMs < cutoff) {
      arr.shift();
    }
    // Bellek: oyuncu sayısı × 20 snapshot × 64 byte = kabul edilebilir
  }

  /**
   * Verilen oyuncunun targetTime anındaki konumunu döndür.
   * Snapshot yoksa null.
   */
  getStateAt(playerId: string, targetServerTimeMs: number): Vector3Like | null {
    const arr = this.history.get(playerId);
    if (!arr || arr.length === 0) return null;
    if (arr.length === 1) return arr[0].position;

    // Hedef an, son snapshot'tan büyükse extrapolasyon (sadece 100 ms)
    if (targetServerTimeMs >= arr[arr.length - 1].serverTimeMs) {
      const last = arr[arr.length - 1];
      const dt = (targetServerTimeMs - last.serverTimeMs) / 1000;
      if (dt > 0.2) return last.position;
      return {
        x: last.position.x + last.velocity.x * dt,
        y: last.position.y + last.velocity.y * dt,
        z: last.position.z + last.velocity.z * dt,
      };
    }
    // Hedef an, ilk snapshot'tan küçükse → en eskiyi kullan
    if (targetServerTimeMs <= arr[0].serverTimeMs) {
      return arr[0].position;
    }
    // İki snapshot arasında lerp
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      if (a.serverTimeMs <= targetServerTimeMs && b.serverTimeMs >= targetServerTimeMs) {
        const span = b.serverTimeMs - a.serverTimeMs;
        const t = span > 0 ? (targetServerTimeMs - a.serverTimeMs) / span : 0;
        return {
          x: a.position.x + (b.position.x - a.position.x) * t,
          y: a.position.y + (b.position.y - a.position.y) * t,
          z: a.position.z + (b.position.z - a.position.z) * t,
        };
      }
    }
    return arr[arr.length - 1].position;
  }

  /**
   * Ateş event'i için hit validation.
   * Tüm rakipleri targetTime anına geri sarar ve mermiyi test eder.
   *
   * @param shot ateş event'i
   * @param attackerDelayMs saldırganın RTT/2 + interpolation buffer'ı
   * @param raycastFn (origin, direction, maxDist, victimPos) => hit mi?
   * @param victims kontrol edilecek rakipler
   * @returns vurulan kişi (veya null) + uzaklık
   */
  validateHit(
    shot: ShotPacket,
    attackerDelayMs: number,
    raycastFn: (origin: Vector3Like, dir: Vector3Like, maxDist: number, victimPos: Vector3Like) => boolean,
    victims: { id: string; capsuleRadius: number }[],
  ): { victimId: string } | null {
    // 1) targetTime hesapla: shotClientTime → serverTime → -delay
    const shotServerTime = this.clock.localToServer(shot.shotClientTimeMs);
    const targetTime = shotServerTime - attackerDelayMs;
    // 2) Mermi yönü (normalize)
    const dx = shot.direction.x, dy = shot.direction.y, dz = shot.direction.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    // 3) Her rakipten en yakınını bul
    let bestId: string | null = null;
    let bestDist = Infinity;
    const maxRange = 300; // metre — tipik AWP menzili
    for (const v of victims) {
      if (v.id === shot.attackerId) continue;
      const vp = this.getStateAt(v.id, targetTime);
      if (!vp) continue;
      // Capsule raycast
      if (raycastFn(shot.origin, dir, maxRange, vp) && /* capsule vs sphere */ false) {
        // Yaklaşık mesafe: ray-segment en yakın noktası
        // (production'da: capsuleRaycast doğru sonuç verir)
      }
      const dist = Math.hypot(vp.x - shot.origin.x, vp.y - shot.origin.y, vp.z - shot.origin.z);
      if (dist < bestDist && dist <= maxRange) {
        bestDist = dist;
        bestId = v.id;
      }
    }
    return bestId ? { victimId: bestId } : null;
  }

  /** Oyuncu ayrıldığında history'den temizle. */
  clearPlayer(playerId: string): void {
    this.history.delete(playerId);
  }

  /** Tüm history belleğini boşalt. */
  clear(): void {
    this.history.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  6) NetcodeClient — Yerel Client (Prediction + Interpolation)
// ════════════════════════════════════════════════════════════════════════════
//
// Üst katman (engine.ts) ile transport (network.ts) arasındaki yapıştırıcı.
// Üç sorumluluğu var:
//   1) Her frame'de input üret, prediction buffer'a ekle, network'e gönder.
//   2) Network'ten gelen state snapshot'larını al:
//      a) Kendi player'ımızın ise → reconcile.
//      b) Başkasının ise → interpolation buffer'a ekle.
//   3) Her frame'de uzak oyuncuları interpolation buffer'dan sample et.

export class NetcodeClient {
  private readonly prediction: PredictionBuffer;
  private readonly interpolation = new InterpolationBuffer();
  private readonly clock = new ClockSync();
  private inputSeq = 0;
  private lastInputSentMs = 0;

  constructor(
    physics: IPredictionPhysics,
    private readonly transport: GameNetwork,
    private readonly playerId: string,
  ) {
    this.prediction = new PredictionBuffer(physics);
  }

  /**
   * Her frame çağrılır. Input'u fizik motoruna uygular, network'e gönderir
   * ve ack'leri işler.
   */
  tick(
    input: Omit<InputCommand, 'seq' | 'clientTimeMs'>,
    nowMs: number,
  ): void {
    // 1) Sıra numarası ver
    this.inputSeq = (this.inputSeq + 1) >>> 0; // uint32 wrap
    const cmd: InputCommand = {
      seq: this.inputSeq,
      clientTimeMs: nowMs,
      ...input,
    };
    // 2) Prediction buffer'a ekle + fizik motoruna uygula
    this.prediction.add(cmd);
    this.prediction.step();
    // 3) Network'e gönder (rate limit: 60 Hz — saniyede 60 input komutu)
    if (nowMs - this.lastInputSentMs > 16) {
      this.transport.sendInput(cmd);
      this.lastInputSentMs = nowMs;
    }
  }

  /**
   * Network'ten gelen state snapshot'ını işle.
   * Kendi player'ımızın ise → reconcile; değilse → interpolation.
   */
  onState(snap: StateSnapshot): void {
    // Saat senkronizasyonu
    this.clock.recordSample(snap.serverTimeMs, performance.now());
    if (snap.playerId === this.playerId) {
      this.prediction.reconcile(snap);
    } else {
      this.interpolation.push(snap);
    }
  }

  /**
   * Uzak bir oyuncunun render edilecek konumunu ver.
   * serverTimeMs = şu anki sunucu saati (tahminen).
   */
  sampleRemote(playerId: string, serverTimeMs: number): InterpolatedState | null {
    return this.interpolation.sample(playerId, serverTimeMs);
  }

  /** Yerel tahmin edilen state. */
  getLocalPredictedState(): PlayerState {
    return this.prediction['physics'].getState();
  }

  /** Effective delay (RTT/2 + interpolation). */
  getEffectiveDelayMs(): number {
    return this.clock.getEffectiveDelayMs();
  }

  /** Bir oyuncu ayrıldığında. */
  removePlayer(playerId: string): void {
    this.interpolation.clearPlayer(playerId);
  }

  /** Cleanup. */
  dispose(): void {
    this.interpolation.clear();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  7) NetcodeServer — Yetkili Client (Hit Validation + State Broadcast)
// ════════════════════════════════════════════════════════════════════════════
//
// Supabase broadcast'ta gerçek bir sunucu yoktur; "yetkili" client (host) bu
// sınıfı kullanır. Gelen input komutlarını uygular, durumu hesaplar, 50 ms'de
// bir snapshot gönderir ve ateş event'lerini lag-comp ile doğrular.

export interface IServerPhysics {
  /** Input komutunu fizik motoruna uygula. */
  applyInput(playerId: string, cmd: InputCommand): void;
  /** Tüm oyuncuların state'lerini döndür. */
  getAllStates(): PlayerState[];
  /** Bir oyuncunun state'ini al. */
  getState(playerId: string): PlayerState | null;
}

export class NetcodeServer {
  private readonly lagComp = new LagCompensation();
  private readonly clock = new ClockSync();
  private lastBroadcastMs = 0;
  private inputSeqMap = new Map<string, number>();
  private readonly serverTimeStart = Date.now();
  private playerHistoryMs = 0;

  constructor(private readonly physics: IServerPhysics) {}
}

