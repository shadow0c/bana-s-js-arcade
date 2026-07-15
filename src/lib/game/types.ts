import type { TransformNode, Mesh } from '@babylonjs/core';

export type Team = 't' | 'ct';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  id: string;
  name: string;
  team: Team;
  position: Vector3Like;
  rotation: { x: number; y: number };
  health: number;
  weaponId: string;
  ammo: number;
  maxAmmo: number;
  money: number;
  kills: number;
  deaths: number;
  isDead: boolean;
  isReloading: boolean;
  isScoped: boolean;
}

export interface RemotePlayer {
  id: string;
  name: string;
  team: Team;
  root: TransformNode;
  weaponGroup: TransformNode;
  targetPosition: Vector3Like;
  targetRotation: { x: number; y: number };
  state: PlayerState;
}

export interface WeaponDef {
  id: string;
  name: string;
  cost: number;
  damage: number;
  fireRate: number;
  clipSize: number;
  reloadTime: number;
  automatic: boolean;
  range: number;
  scope?: boolean;
  recoil: number;
  grenade?: 'flash' | 'he';
}

export interface MapBox {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface KillFeedEntry {
  id: string;
  killer: string;
  victim: string;
  weapon: string;
  timestamp: number;
}

export interface ShootEvent {
  id: string;
  origin: Vector3Like;
  direction: Vector3Like;
  weaponId: string;
}

export interface HitEvent {
  id: string;
  targetId: string;
  damage: number;
}

export interface DeathEvent {
  killerId: string;
  victimId: string;
  weaponId: string;
}

export interface BuyEvent {
  id: string;
  weaponId: string;
}

export interface RespawnEvent {
  id: string;
  position: Vector3Like;
}
