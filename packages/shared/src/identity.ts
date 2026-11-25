/**
 * Deterministic pet identity from an agent id: the same id always gives the same name,
 * species and shell colour (BUILD_PROMPT.md section 9).
 */
import { sha256Bytes } from "./sha256.ts";

/** One per pixel sprite on the site (round blob, eared cat, antennae bug, pointy ghost). */
export const SPECIES = ["blob", "cat", "bug", "ghost"] as const;

/** Shell colours are palette names, so the site can adapt them to light and dark mode. */
export const SHELLS = ["pink", "sky", "lime", "grape", "tang", "mint"] as const;
export type Shell = (typeof SHELLS)[number];
export type Species = (typeof SPECIES)[number];

const FIRST = ["Bo", "Ki", "Mo", "Pip", "Lu", "Ta", "Zu", "Ne", "Fi", "Ro", "Wen", "Su", "Ga", "Hal", "Io", "Ju"];
const LAST = ["mo", "ka", "lo", "bit", "ri", "zen", "pa", "dle", "nu", "ty", "bo", "xi", "fen", "rel", "so", "va"];

function bytes(id: string): Uint8Array {
  return sha256Bytes(`hatchery-pet:${id}`);
}

export interface PetIdentity {
  displayName: string;
  species: Species;
  /** Palette name (see SHELLS). */
  shellColor: Shell;
}

export function petIdentity(id: string): PetIdentity {
  const b = bytes(id);
  return {
    displayName: `${FIRST[b[2]! % FIRST.length]}${LAST[b[3]! % LAST.length]}`,
    species: SPECIES[b[4]! % SPECIES.length]!,
    shellColor: SHELLS[((b[0]! << 8) | b[1]!) % SHELLS.length]!,
  };
}
