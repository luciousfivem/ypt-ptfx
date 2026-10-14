import { joaat } from '@vfxforge/ypt';

/**
 * Convenience weapon-name presets per VFXForge weapon class. These are plain GTA weapon names;
 * the exporter only checks their SHAPE (WEAPON_[A-Z0-9_]+), it cannot know which names exist on
 * the user's server (custom/add-on weapons are common), so the README tells the user to verify.
 */
export const WEAPON_PRESET_NAMES: Record<string, string[]> = {
  pistol: ['WEAPON_PISTOL', 'WEAPON_COMBATPISTOL'],
  smg: ['WEAPON_MICROSMG', 'WEAPON_SMG'],
  rifle: ['WEAPON_CARBINERIFLE', 'WEAPON_ASSAULTRIFLE'],
  shotgun: ['WEAPON_PUMPSHOTGUN'],
  sniper: ['WEAPON_SNIPERRIFLE'],
};

export interface WeaponHash {
  name: string;
  hash: number;
  /** Signed 32-bit value as printed by most tools (GetHashKey returns this in Lua). */
  signed: number;
  hex: string;
}

export function weaponHash(name: string): WeaponHash {
  const hash = joaat(name);
  return { name, hash, signed: hash | 0, hex: '0x' + hash.toString(16).toUpperCase().padStart(8, '0') };
}

export function isWeaponName(name: string): boolean {
  return /^WEAPON_[A-Z0-9_]{1,48}$/.test(name);
}
