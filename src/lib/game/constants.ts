import type { WeaponDef, MapBox } from './types';

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
    range: 2,
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
export const MOUSE_SENSITIVITY = 0.0018;
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const MAX_HEALTH = 100;
export const RESPAWN_TIME = 3000;

// CDN textures (three.js official examples)
export const TEXTURES = {
  floor: 'https://threejs.org/examples/textures/hardwood2_diffuse.jpg',
  wall: 'https://threejs.org/examples/textures/brick_diffuse.jpg',
  crate: 'https://threejs.org/examples/textures/crate.gif',
  sky: 'https://threejs.org/examples/textures/lensflare/lensflare0.png',
};

export const MAP_BOUNDS = { minX: -55, maxX: 55, minZ: -55, maxZ: 55 };

// de_dust2 esintili yapı: A ve B siteleri, mid, uzun/kısa yollar
export const MAP_WALLS: MapBox[] = [
  // Dış duvarlar
  { x: -56, z: 0, w: 2, d: 112, h: 5 },
  { x: 56, z: 0, w: 2, d: 112, h: 5 },
  { x: 0, z: -56, w: 112, d: 2, h: 5 },
  { x: 0, z: 56, w: 112, d: 2, h: 5 },

  // A sitesi (sağ üst) — kutular ve rampa
  { x: 30, z: 35, w: 6, d: 6, h: 2.2 },
  { x: 40, z: 30, w: 4, d: 8, h: 3 },
  { x: 22, z: 40, w: 8, d: 3, h: 2 },
  { x: 45, z: 42, w: 3, d: 8, h: 3.5 },

  // B sitesi (sol alt) — tuneller
  { x: -30, z: -35, w: 6, d: 6, h: 2.2 },
  { x: -40, z: -28, w: 3, d: 10, h: 3 },
  { x: -22, z: -42, w: 10, d: 3, h: 2 },
  { x: -45, z: -42, w: 3, d: 8, h: 3.5 },

  // Mid
  { x: 0, z: 0, w: 10, d: 3, h: 2.5 },
  { x: -5, z: -8, w: 3, d: 6, h: 2 },
  { x: 5, z: 8, w: 3, d: 6, h: 2 },

  // Uzun A koridoru
  { x: 15, z: -20, w: 3, d: 24, h: 3 },
  { x: -15, z: 20, w: 3, d: 24, h: 3 },

  // Kısa duvarlar / kapaklar
  { x: 25, z: -5, w: 12, d: 2, h: 2.5 },
  { x: -25, z: 5, w: 12, d: 2, h: 2.5 },
  { x: 8, z: -35, w: 2, d: 10, h: 3 },
  { x: -8, z: 35, w: 2, d: 10, h: 3 },

  // Merkez kutular
  { x: -12, z: -12, w: 3, d: 3, h: 1.5 },
  { x: 12, z: 12, w: 3, d: 3, h: 1.5 },
];

export const COLORS = {
  t: 0xd97706,
  ct: 0x2563eb,
  wall: 0x8b7355,
  floor: 0xc4a574,
  grid: 0x6b5340,
  bullet: 0xfef08a,
  sky: 0xc7ccd1,
};
