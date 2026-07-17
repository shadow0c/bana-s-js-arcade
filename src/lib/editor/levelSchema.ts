// src/lib/editor/levelSchema.ts
//
// Editörün ürettiği "seviye" (level) verisinin formatı. Bu format OYUNDAN
// BAĞIMSIZDIR (genel amaçlı) — CS2 klonu için MAP_WALLS'a dönüştürülebilir,
// ama aynı JSON başka bir Three.js oyununda da (kendi entity sisteminle)
// okunabilir. Editör tarayıcıda çalışır, hiçbir zaman `/game` route'unun
// içine mount edilmez — bu iki dosya birbirini import ETMEZ.

export type EntityKind = 'box' | 'spawnPoint' | 'bombsite' | 'light' | 'model';
export type Team = 't' | 'ct';

export interface Vec3 { x: number; y: number; z: number; }

export interface BaseEntity {
  id: string;
  name: string;
  kind: EntityKind;
  position: Vec3;
  rotationY: number; // derece
  scale: Vec3;
}

export interface BoxEntity extends BaseEntity {
  kind: 'box';
  color: string;      // "#rrggbb"
  metalness: number;  // 0..1
  roughness: number;  // 0..1
  /** true ise oyuncu bu kutunun içinden geçemez (CS2 export'unda MAP_WALLS'a dahil edilir). */
  solid: boolean;
}

export interface SpawnPointEntity extends BaseEntity {
  kind: 'spawnPoint';
  team: Team;
}

export interface BombsiteEntity extends BaseEntity {
  kind: 'bombsite';
  label: string; // "A", "B" vb.
  radius: number;
}

export interface LightEntity extends BaseEntity {
  kind: 'light';
  color: string;
  intensity: number;
  distance: number;
}

export interface ModelEntity extends BaseEntity {
  kind: 'model';
  /** AssetLibrary'deki kaydın id'si - dosyanın kendisi değil, referansı saklanır. */
  assetId: string;
  assetName: string;
}

export type LevelEntity = BoxEntity | SpawnPointEntity | BombsiteEntity | LightEntity | ModelEntity;

export interface LevelData {
  formatVersion: 1;
  name: string;
  entities: LevelEntity[];
}

export function createEmptyLevel(name = 'Yeni Harita'): LevelData {
  return { formatVersion: 1, name, entities: [] };
}

export function generateEntityId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// CS2-KLONU İÇİN "DERLEME" ÇIKTISI: mevcut oyunun constants.ts'indeki
// `MAP_WALLS: WallBox[]` ile BİREBİR AYNI ŞEKİL. Bu, editörde tasarlanan bir
// haritayı gerçek oyuna bağlayan köprüdür — üretilen string'i kopyalayıp
// constants.ts içindeki MAP_WALLS dizisiyle değiştirmen yeterli.
// ---------------------------------------------------------------------------
export function exportMapWallsSource(level: LevelData): string {
  const boxes = level.entities.filter((e): e is BoxEntity => e.kind === 'box' && e.solid);
  const lines = boxes.map((b) => {
    const w = +(b.scale.x).toFixed(2);
    const h = +(b.scale.y).toFixed(2);
    const d = +(b.scale.z).toFixed(2);
    return `  { x: ${round(b.position.x)}, z: ${round(b.position.z)}, w: ${w}, h: ${h}, d: ${d} },`;
  });
  return `export const MAP_WALLS: WallBox[] = [\n${lines.join('\n')}\n];`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function exportLevelJSON(level: LevelData): string {
  return JSON.stringify(level, null, 2);
}

export function parseLevelJSON(json: string): LevelData {
  const data = JSON.parse(json) as LevelData;
  if (data.formatVersion !== 1) {
    throw new Error(`Desteklenmeyen seviye formatı: ${String((data as { formatVersion?: unknown }).formatVersion)}`);
  }
  return data;
}
