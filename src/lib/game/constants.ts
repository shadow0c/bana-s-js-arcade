// src/lib/game/constants.ts

export interface WeaponDef {
  id: string;
  name: string;
  cost: number;
  damage: number;
  /** ms between shots */
  fireRate: number;
  /** ms full reload */
  reloadTime: number;
  clipSize: number;
  /** radians of vertical recoil per shot (pre-buildup) */
  recoil: number;
  /** true if weapon has scope zoom (right-click) */
  scope?: boolean;
  /** grenade weapons cannot fire via primary trigger */
  grenade?: boolean;
  /** melee weapons cannot fire bullets */
  melee?: boolean;
}

export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    id: 'knife',
    name: 'Bıçak',
    cost: 0,
    damage: 50,
    fireRate: 500,
    reloadTime: 0,
    clipSize: 0,
    recoil: 0,
    melee: true,
  },
  pistol: {
    id: 'pistol',
    name: 'Glock-18',
    cost: 200,
    damage: 22,
    fireRate: 150,
    reloadTime: 1600,
    clipSize: 20,
    recoil: 0.012,
  },
  deagle: {
    id: 'deagle',
    name: 'Desert Eagle',
    cost: 700,
    damage: 55,
    fireRate: 260,
    reloadTime: 2100,
    clipSize: 7,
    recoil: 0.035,
  },
  rifle: {
    id: 'rifle',
    name: 'AK-47',
    cost: 2700,
    damage: 34,
    fireRate: 100,
    reloadTime: 2400,
    clipSize: 30,
    recoil: 0.022,
  },
  m4: {
    id: 'm4',
    name: 'M4A4',
    cost: 3100,
    damage: 30,
    fireRate: 90,
    reloadTime: 2300,
    clipSize: 30,
    recoil: 0.018,
  },
  sniper: {
    id: 'sniper',
    name: 'AWP',
    cost: 4750,
    damage: 115,
    fireRate: 1450,
    reloadTime: 3600,
    clipSize: 10,
    recoil: 0.06,
    scope: true,
  },
};

export const DEFAULT_WEAPON = 'pistol';

export const PLAYER_HEIGHT = 1.7;
export const PLAYER_RADIUS = 0.35;
export const PLAYER_SPEED = 5.2;
export const MOUSE_SENSITIVITY = 0.0022;

export const MAX_HEALTH = 100;
export const RESPAWN_TIME = 3000;
export const KILL_REWARD = 300;

export const COLORS = {
  sky: 0xbfa77a,
  t: 0xd9822b,
  ct: 0x2b6fd9,
  bullet: 0xffe28a,
} as const;

export const MAP_BOUNDS = {
  minX: -60,
  maxX: 60,
  minZ: -60,
  maxZ: 60,
} as const;

/** Basit AABB duvar/kutu listesi (Dust2 esintili). */
export interface WallBox {
  x: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export const MAP_WALLS: WallBox[] = [
  // Dış duvarlar
  { x: 0, z: -60, w: 120, h: 6, d: 1 },
  { x: 0, z: 60, w: 120, h: 6, d: 1 },
  { x: -60, z: 0, w: 1, h: 6, d: 120 },
  { x: 60, z: 0, w: 1, h: 6, d: 120 },

  // Mid koridoru (uzun duvar)
  { x: -8, z: 0, w: 1, h: 4, d: 30 },
  { x: 8, z: 0, w: 1, h: 4, d: 30 },

  // A sitesi çevresi
  { x: 30, z: 22, w: 20, h: 4, d: 1 },
  { x: 42, z: 30, w: 1, h: 4, d: 15 },
  { x: 22, z: 40, w: 16, h: 3.5, d: 1 },

  // B sitesi çevresi
  { x: -30, z: -22, w: 20, h: 4, d: 1 },
  { x: -42, z: -30, w: 1, h: 4, d: 15 },
  { x: -22, z: -40, w: 16, h: 3.5, d: 1 },

  // Ahşap kasalar (küçük — crate dokusu kullanır)
  { x: 12, z: 20, w: 2, h: 2, d: 2 },
  { x: 14, z: 20, w: 2, h: 2, d: 2 },
  { x: 12, z: 22, w: 2, h: 2, d: 2 },
  { x: -12, z: -20, w: 2, h: 2, d: 2 },
  { x: -14, z: -20, w: 2, h: 2, d: 2 },
  { x: -12, z: -22, w: 2, h: 2, d: 2 },
  { x: 0, z: 18, w: 2, h: 2, d: 2 },
  { x: 0, z: -18, w: 2, h: 2, d: 2 },
  { x: 25, z: -10, w: 2, h: 2, d: 2 },
  { x: -25, z: 10, w: 2, h: 2, d: 2 },

  // Tunnels engelleri
  { x: -45, z: 15, w: 8, h: 4, d: 1 },
  { x: 45, z: -15, w: 8, h: 4, d: 1 },
];
