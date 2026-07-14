import type { WeaponDef, MapBox } from './types';

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: {
    id: 'pistol',
    name: 'Glock',
    cost: 0,
    damage: 28,
    fireRate: 350,
    clipSize: 20,
    reloadTime: 1400,
    automatic: false,
    range: 80,
    recoil: 0.02,
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
  sniper: {
    id: 'sniper',
    name: 'AWP',
    cost: 4750,
    damage: 100,
    fireRate: 1500,
    clipSize: 10,
    reloadTime: 2500,
    automatic: false,
    range: 500,
    scope: true,
    recoil: 0.08,
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

export const MAP_BOUNDS = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
export const MAP_WALLS: MapBox[] = [
  { x: -50, z: 0, w: 2, d: 100, h: 4 },
  { x: 50, z: 0, w: 2, d: 100, h: 4 },
  { x: 0, z: -50, w: 100, d: 2, h: 4 },
  { x: 0, z: 50, w: 100, d: 2, h: 4 },
  { x: -15, z: -15, w: 4, d: 20, h: 3 },
  { x: 15, z: 15, w: 4, d: 20, h: 3 },
  { x: -22, z: 26, w: 18, d: 4, h: 3 },
  { x: 22, z: -26, w: 18, d: 4, h: 3 },
  { x: 0, z: 0, w: 8, d: 8, h: 2.5 },
  { x: -30, z: -10, w: 10, d: 3, h: 2 },
  { x: 30, z: 10, w: 10, d: 3, h: 2 },
];

export const COLORS = {
  t: 0xd97706,
  ct: 0x2563eb,
  wall: 0x57534e,
  floor: 0x1c1917,
  grid: 0x44403c,
  bullet: 0xfef08a,
};
