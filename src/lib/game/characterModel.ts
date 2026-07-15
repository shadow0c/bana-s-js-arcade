import { TransformNode, MeshBuilder, StandardMaterial, Mesh, Color3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import { COLORS } from './constants';
import type { Team } from './types';

interface CharacterParts {
  root: TransformNode;
  head: Mesh;
  body: Mesh;
  leftArm: Mesh;
  rightArm: Mesh;
  leftLeg: Mesh;
  rightLeg: Mesh;
  weaponGroup: TransformNode;
}

/**
 * CS2 tarzı prosedürel oyuncu modeli oluşturur.
 *
 * Silah tutuş pozisyonları (CS2 referansı):
 *  - rifle: sağ kol öne uzanmış, sol kol destek için öne eğilmiş, silah göğüs hizasında
 *  - pistol: sağ kol öne 45° uzanmış, sol yanlarda
 *  - sniper: iki kol öne uzanmış, dürbün göz hizasında
 *  - knife: iki kol öne hafif açık, bıçak bel hizasında
 */
export function createCharacterModel(
  scene: Scene,
  team: Team,
  playerId: string,
): CharacterParts {
  const root = new TransformNode(`player_${playerId}`, scene);
  root.rotation.y = Math.PI;

  const teamColor = team === 't' ? COLORS.t : COLORS.ct;
  const teamDark = team === 't' ? COLORS.tDark : COLORS.ctDark;
  const helmetColor = team === 't' ? COLORS.helmetT : COLORS.helmetCT;

  const uniformMat = new StandardMaterial(`uniform_${playerId}`, scene);
  uniformMat.diffuseColor = Color3.FromInts(
    (teamColor >> 16) & 0xff,
    (teamColor >> 8) & 0xff,
    teamColor & 0xff,
  );

  const darkMat = new StandardMaterial(`dark_${playerId}`, scene);
  darkMat.diffuseColor = Color3.FromInts(
    (teamDark >> 16) & 0xff,
    (teamDark >> 8) & 0xff,
    teamDark & 0xff,
  );

  const pantsMat = new StandardMaterial(`pants_${playerId}`, scene);
  pantsMat.diffuseColor = new Color3(0.16, 0.16, 0.16);

  const skinMat = new StandardMaterial(`skin_${playerId}`, scene);
  skinMat.diffuseColor = Color3.FromInts(
    (COLORS.skin >> 16) & 0xff,
    (COLORS.skin >> 8) & 0xff,
    COLORS.skin & 0xff,
  );

  const vestMat = new StandardMaterial(`vest_${playerId}`, scene);
  vestMat.diffuseColor = Color3.FromInts(
    (COLORS.vest >> 16) & 0xff,
    (COLORS.vest >> 8) & 0xff,
    COLORS.vest & 0xff,
  );

  const helmetMat = new StandardMaterial(`helmet_${playerId}`, scene);
  helmetMat.diffuseColor = Color3.FromInts(
    (helmetColor >> 16) & 0xff,
    (helmetColor >> 8) & 0xff,
    helmetColor & 0xff,
  );

  const metalMat = new StandardMaterial(`metal_${playerId}`, scene);
  metalMat.diffuseColor = Color3.FromInts(
    (COLORS.metal >> 16) & 0xff,
    (COLORS.metal >> 8) & 0xff,
    COLORS.metal & 0xff,
  );

  // Bacaklar (0.85 birim)
  const legGeo = { width: 0.22, height: 0.85, depth: 0.22 };
  const leftLeg = MeshBuilder.CreateBox(`lleg_${playerId}`, legGeo, scene);
  leftLeg.material = pantsMat;
  leftLeg.parent = root;
  leftLeg.position.set(-0.12, 0.425, 0);

  const rightLeg = MeshBuilder.CreateBox(`rleg_${playerId}`, legGeo, scene);
  rightLeg.material = pantsMat;
  rightLeg.parent = root;
  rightLeg.position.set(0.12, 0.425, 0);

  // Gövde (0.55 x 0.6 x 0.32)
  const body = MeshBuilder.CreateBox(`body_${playerId}`, { width: 0.5, height: 0.6, depth: 0.3 }, scene);
  body.material = uniformMat;
  body.parent = root;
  body.position.y = 1.15;

  // Yelek (CS2 tarzı taktik yelek)
  const vest = MeshBuilder.CreateBox(`vest_${playerId}`, { width: 0.54, height: 0.42, depth: 0.34 }, scene);
  vest.material = vestMat;
  vest.parent = root;
  vest.position.y = 1.18;

  // Kollar
  const armGeo = { width: 0.14, height: 0.55, depth: 0.14 };
  const leftArm = MeshBuilder.CreateBox(`larm_${playerId}`, armGeo, scene);
  leftArm.material = uniformMat;
  leftArm.parent = root;
  leftArm.position.set(-0.33, 1.15, 0);

  const rightArm = MeshBuilder.CreateBox(`rarm_${playerId}`, armGeo, scene);
  rightArm.material = uniformMat;
  rightArm.parent = root;
  rightArm.position.set(0.33, 1.15, 0);

  // Boyun + Kafa
  const neck = MeshBuilder.CreateBox(`neck_${playerId}`, { width: 0.14, height: 0.1, depth: 0.14 }, scene);
  neck.material = skinMat;
  neck.parent = root;
  neck.position.y = 1.5;

  const head = MeshBuilder.CreateBox(`head_${playerId}`, { width: 0.28, height: 0.3, depth: 0.28 }, scene);
  head.material = skinMat;
  head.parent = root;
  head.position.y = 1.72;

  // Kask
  const helmet = MeshBuilder.CreateBox(`helmet_${playerId}`, { width: 0.32, height: 0.16, depth: 0.32 }, scene);
  helmet.material = helmetMat;
  helmet.parent = root;
  helmet.position.y = 1.9;

  // Silah grubu (weapon hold)
  const weaponGroup = new TransformNode(`weapon_${playerId}`, scene);
  weaponGroup.parent = root;

  // Tüm mesh'leri pickable yap ve playerId işaretle
  const allMeshes = [leftLeg, rightLeg, body, vest, leftArm, rightArm, neck, head, helmet];
  for (const m of allMeshes) {
    m.metadata = { playerId };
  }

  return { root, head, body, leftArm, rightArm, leftLeg, rightLeg, weaponGroup };
}

/**
 * Silah tipine göre kol ve silah pozisyonlarını ayarlar (CS2 tarzı).
 */
export function setWeaponPose(parts: CharacterParts, weaponId: string, scene: Scene): void {
  // Eski silah mesh'ini temizle
  const existing = parts.weaponGroup.getChildMeshes();
  for (const m of existing) m.dispose();

  const metalMat = new StandardMaterial(`wpn_${parts.root.name}`, scene);
  metalMat.diffuseColor = Color3.FromInts(0x1a, 0x1a, 0x1a);
  metalMat.specularColor = new Color3(0.3, 0.3, 0.3);

  switch (weaponId) {
    case 'rifle':
    case 'm4': {
      // Tüfek: göğüs hizasında, sağ kol öne, sol kol destek
      parts.rightArm.rotation.x = -Math.PI / 2.2;
      parts.rightArm.position.set(0.33, 1.15, 0.25);
      parts.leftArm.rotation.x = -Math.PI / 2.5;
      parts.leftArm.position.set(-0.22, 1.15, 0.3);

      const rifle = MeshBuilder.CreateBox(`rifle_mesh_${parts.root.name}`, { width: 0.08, height: 0.1, depth: 0.7 }, scene);
      rifle.material = metalMat;
      rifle.parent = parts.weaponGroup;
      rifle.position.set(0.28, 1.2, 0.45);
      // Şarjör
      const mag = MeshBuilder.CreateBox(`mag_${parts.root.name}`, { width: 0.06, height: 0.2, depth: 0.1 }, scene);
      mag.material = metalMat;
      mag.parent = parts.weaponGroup;
      mag.position.set(0.28, 1.05, 0.4);
      break;
    }
    case 'sniper': {
      // AWP: iki kol öne uzanmış, dürbün göz hizasında
      parts.rightArm.rotation.x = -Math.PI / 2;
      parts.rightArm.position.set(0.33, 1.3, 0.3);
      parts.leftArm.rotation.x = -Math.PI / 2;
      parts.leftArm.position.set(-0.25, 1.3, 0.35);

      const sniper = MeshBuilder.CreateBox(`sniper_mesh_${parts.root.name}`, { width: 0.08, height: 0.12, depth: 0.9 }, scene);
      sniper.material = metalMat;
      sniper.parent = parts.weaponGroup;
      sniper.position.set(0.28, 1.35, 0.5);
      // Dürbün
      const scope = MeshBuilder.CreateCylinder(`scope_${parts.root.name}`, { height: 0.25, diameter: 0.06 }, scene);
      scope.material = metalMat;
      scope.parent = parts.weaponGroup;
      scope.position.set(0.28, 1.45, 0.5);
      scope.rotation.z = Math.PI / 2;
      break;
    }
    case 'pistol':
    case 'deagle': {
      // Tabanca: sağ kol öne 45°, sol yanlarda
      parts.rightArm.rotation.x = -Math.PI / 2.5;
      parts.rightArm.position.set(0.33, 1.15, 0.3);
      parts.leftArm.rotation.x = 0;
      parts.leftArm.position.set(-0.33, 1.15, 0);

      const pistol = MeshBuilder.CreateBox(`pistol_mesh_${parts.root.name}`, { width: 0.07, height: 0.12, depth: 0.25 }, scene);
      pistol.material = metalMat;
      pistol.parent = parts.weaponGroup;
      pistol.position.set(0.33, 1.15, 0.42);
      break;
    }
    case 'knife': {
      // Bıçak: iki kol öne hafif açık
      parts.rightArm.rotation.x = -Math.PI / 3;
      parts.rightArm.position.set(0.3, 1.1, 0.25);
      parts.leftArm.rotation.x = -Math.PI / 4;
      parts.leftArm.position.set(-0.3, 1.1, 0.2);

      const blade = MeshBuilder.CreateBox(`blade_${parts.root.name}`, { width: 0.03, height: 0.02, depth: 0.3 }, scene);
      blade.material = metalMat;
      blade.parent = parts.weaponGroup;
      blade.position.set(0.3, 1.1, 0.45);
      break;
    }
    default: {
      parts.rightArm.rotation.x = 0;
      parts.rightArm.position.set(0.33, 1.15, 0);
      parts.leftArm.rotation.x = 0;
      parts.leftArm.position.set(-0.33, 1.15, 0);
    }
  }
}
