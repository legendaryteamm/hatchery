/**
 * Deterministic pet identity from an agent id: the same id always gives the same name,
 * species and shell colour (BUILD_PROMPT.md section 9).
 */
import { createHash } from "node:crypto";

export const SPECIES = ["blob", "sprout", "moth", "pebble", "newt", "puff", "beetle", "owl"] as const;
export type Species = (typeof SPECIES)[number];

const FIRST = ["Bo", "Ki", "Mo", "Pip", "Lu", "Ta", "Zu", "Ne", "Fi", "Ro", "Wen", "Su", "Ga", "Hal", "Io", "Ju"];
const LAST = ["mo", "ka", "lo", "bit", "ri", "zen", "pa", "dle", "nu", "ty", "bo", "xi", "fen", "rel", "so", "va"];

function bytes(id: string): Buffer {
  return createHash("sha256").update(`hatchery-pet:${id}`).digest();
}

export interface PetIdentity {
  displayName: string;
  species: Species;
  /** CSS hex colour, e.g. "#e58fb6". */
  shellColor: string;
}

export function petIdentity(id: string): PetIdentity {
  const b = bytes(id);
  const hue = ((b[0]! << 8) | b[1]!) % 360;
  return {
    displayName: `${FIRST[b[2]! % FIRST.length]}${LAST[b[3]! % LAST.length]}`,
    species: SPECIES[b[4]! % SPECIES.length]!,
    shellColor: hslToHex(hue, 62, 72),
  };
}

function hslToHex(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sl * Math.min(ll, 1 - ll);
  const f = (n: number) => ll - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}
