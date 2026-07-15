import type { WeaponDef, MapBox, Team } from './types';

export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    id: 'knife',
    name: 'Bıçak',
    cost: 0,
    damage: 55,
    fireRate: 500,
    clipSize: 1,
    reloadTime: 0,
    automatic: false,
    range: 2.5,
    recoil: 0,
  },
  pistol: {
    id: 'pistol',
    name: 'Glock-18',
    cost: 0,
    damage: 28,
    fireRate: 350,
    clipSize: 20,
    reloadTime: 1400,
    automatic: false,
    range: 80,
    recoil: 0.02,
  },
  deagle: {
    id: 'deagle',
    name: 'Desert Eagle',
    cost: 700,
    damage: 63,
    fireRate: 400,
    clipSize: 7,
    reloadTime: 2000,
    automatic: false,
    range: 120,
    recoil: 0.06,
  },
  rifle: {
    id: 'rifle',
    name: 'AK-47',
    cost: 2700,
    damage: 36,
    fireRate: 100,
    clipSize: 30,
    reloadTime: 2200,
    automatic: true,
    range: 200,
    recoil: 0.04,
  },
  m4: {
    id: 'm4',
    name: 'M4A4',
    cost: 3100,
    damage: 33,
    fireRate: 95,
    clipSize: 30,
    reloadTime: 2100,
    automatic: true,
    range: 200,
    recoil: 0.032,
  },
  sniper: {
    id: 'sniper',
    name: 'AWP',
    cost: 4750,
    damage: 115,
    fireRate: 1500,
    clipSize: 10,
    reloadTime: 2500,
    automatic: false,
    range: 500,
    scope: true,
    recoil: 0.08,
  },
  flash: {
    id: 'flash',
    name: 'Flashbang',
    cost: 200,
    damage: 0,
    fireRate: 1000,
    clipSize: 1,
    reloadTime: 0,
    automatic: false,
    range: 0,
    recoil: 0,
    grenade: 'flash',
  },
  he: {
    id: 'he',
    name: 'HE Granat',
    cost: 300,
    damage: 90,
    fireRate: 1000,
    clipSize: 1,
    reloadTime: 0,
    automatic: false,
    range: 0,
    recoil: 0,
    grenade: 'he',
  },
};

export const DEFAULT_WEAPON = 'pistol';
export const PLAYER_HEIGHT = 1.7;
export const PLAYER_RADIUS = 0.35;
export const PLAYER_SPEED = 6.5;
export const JUMP_FORCE = 6.5;
export const GRAVITY = -20;
export const MOUSE_SENSITIVITY = 0.0018;
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const MAX_HEALTH = 100;
export const RESPAWN_TIME = 3000;

export const MAP_BOUNDS = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };

/**
 * de_dust2 esintili detaylı harita.
 * T spawn = güney-batı, CT spawn = kuzey-doğu
 * A sitesi = doğu, B sitesi = batı
 */
export const MAP_WALLS: MapBox[] = [
  // DIŞ DUVARLAR
  { x: -60, z: 0, w: 2, d: 122, h: 8 },
  { x: 60, z: 0, w: 2, d: 122, h: 8 },
  { x: 0, z: -60, w: 122, d: 2, h: 8 },
  { x: 0, z: 60, w: 122, d: 2, h: 8 },

  // T SPAWN (güney-batı)
  { x: -48, z: 48, w: 24, d: 2, h: 5 },
  { x: -48, z: 38, w: 2, d: 20, h: 5 },
  { x: -36, z: 30, w: 2, d: 8, h: 5 },

  // CT SPAWN (kuzey-doğu)
  { x: 48, z: -48, w: 24, d: 2, h: 5 },
  { x: 48, z: -38, w: 2, d: 20, h: 5 },
  { x: 36, z: -30, w: 2, d: 8, h: 5 },

  // B SİTESİ (batı)
  { x: -45, z: -15, w: 2, d: 30, h: 6 },
  { x: -45, z: -45, w: 2, d: 20, h: 6 },
  { x: -30, z: -45, w: 30, d: 2, h: 6 },
  { x: -38, z: -30, w: 6, d: 6, h: 2.2 },
  { x: -35, z: -38, w: 4, d: 8, h: 3 },
  { x: -42, z: -25, w: 3, d: 8, h: 3.5 },
  { x: -25, z: -20, w: 2, d: 20, h: 4 },
  { x: -25, z: -35, w: 10, d: 2, h: 4 },

  // A SİTESİ (doğu)
  { x: 45, z: 15, w: 2, d: 30, h: 6 },
  { x: 45, z: 45, w: 2, d: 20, h: 6 },
  { x: 30, z: 45, w: 30, d: 2, h: 6 },
  { x: 38, z: 30, w: 6, d: 6, h: 2.2 },
  { x: 35, z: 38, w: 4, d: 8, h: 3 },
  { x: 42, z: 25, w: 3, d: 8, h: 3.5 },
  { x: 25, z: 20, w: 2, d: 20, h: 4 },
  { x: 25, z: 35, w: 10, d: 2, h: 4 },

  // MID
  { x: 0, z: 0, w: 8, d: 3, h: 3 },
  { x: -4, z: -8, w: 3, d: 6, h: 2 },
  { x: 4, z: 8, w: 3, d: 6, h: 2 },
  { x: 0, z: -15, w: 12, d: 2, h: 4 },
  { x: 0, z: 15, w: 12, d: 2, h: 4 },

  // UZUN KORİDORLAR
  { x: 15, z: -20, w: 3, d: 24, h: 4 },
  { x: -15, z: 20, w: 3, d: 24, h: 4 },

  // KISA YOLLAR
  { x: 25, z: -5, w: 12, d: 2, h: 3 },
  { x: -25, z: 5, w: 12, d: 2, h: 3 },

  // MERKEZ KUTULARI
  { x: -12, z: -12, w: 3, d: 3, h: 1.5 },
  { x: 12, z: 12, w: 3, d: 3, h: 1.5 },
  { x: 8, z: -35, w: 2, d: 10, h: 4 },
  { x: -8, z: 35, w: 2, d: 10, h: 4 },

  // T KORİDORU
  { x: -20, z: 25, w: 2, d: 12, h: 4 },
  { x: -15, z: 15, w: 12, d: 2, h: 4 },

  // CT KORİDORU
  { x: 20, z: -25, w: 2, d: 12, h: 4 },
  { x: 15, z: -15, w: 12, d: 2, h: 4 },

  // EK KAPAKLAR
  { x: -30, z: 0, w: 2, d: 15, h: 2.5 },
  { x: 30, z: 0, w: 2, d: 15, h: 2.5 },
  { x: 0, z: -30, w: 15, d: 2, h: 2.5 },
  { x: 0, z: 30, w: 15, d: 2, h: 2.5 },

  // B SITE EK
  { x: -35, z: -20, w: 5, d: 2, h: 1.8 },
  { x: -32, z: -15, w: 2, d: 5, h: 1.8 },

  // A SITE EK
  { x: 35, z: 20, w: 5, d: 2, h: 1.8 },
  { x: 32, z: 15, w: 2, d: 5, h: 1.8 },
];

export const BOMBSITES = [
  { label: 'A' as const, x: 38, z: 32, color: 0xff4444 },
  { label: 'B' as const, x: -38, z: -32, color: 0x44ff44 },
];

export const SPAWN_POINTS: Record<Team, { x: number; z: number }[]> = {
  t: [
    { x: -50, z: 50 },
    { x: -46, z: 50 },
    { x: -42, z: 50 },
    { x: -50, z: 46 },
    { x: -46, z: 46 },
  ],
  ct: [
    { x: 50, z: -50 },
    { x: 46, z: -50 },
    { x: 42, z: -50 },
    { x: 50, z: -46 },
    { x: 46, z: -46 },
  ],
};

export const COLORS = {
  t: 0xd97706,
  ct: 0x2563eb,
  tDark: 0x7c4a1e,
  ctDark: 0x1a3a8a,
  wall: 0xc4a574,
  wallDark: 0x8b7355,
  floor: 0xd4b896,
  crate: 0x7a4a1e,
  sky: 0xc7ccd1,
  bullet: 0xfef08a,
  blood: 0xcc2222,
  metal: 0x2a2a2a,
  skin: 0xe0b088,
  helmetT: 0x552211,
  helmetCT: 0x1a2f5a,
  vest: 0x1a1a1a,
};
