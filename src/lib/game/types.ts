// src/lib/game/types.ts
import type * as THREE from 'three';

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
  mesh: THREE.Group;
  weaponMesh: THREE.Mesh;
  targetPosition: THREE.Vector3;
  targetRotation: { x: number; y: number };
  state: PlayerState;
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
