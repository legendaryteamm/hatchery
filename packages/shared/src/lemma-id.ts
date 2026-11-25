import { z } from "zod";

/** Lemma / statement ids look like `L-circ-014`: lowercase letters and digits joined by hyphens. */
export const LEMMA_ID_RE = /^L(?:-[a-z0-9]+)+$/;
/** The matching Lean identifier: `L_circ_014` (used in `Statement.L_circ_014`, `Proof.L_circ_014`). */
export const LEAN_NAME_RE = /^L(?:_[a-z0-9]+)+$/;

export const LemmaIdSchema = z.string().max(64).regex(LEMMA_ID_RE, "lemma id must look like L-circ-014");

export function lemmaIdToLeanName(id: string): string {
  if (!LEMMA_ID_RE.test(id)) throw new Error(`invalid lemma id: ${id}`);
  return id.replaceAll("-", "_");
}

export function leanNameToLemmaId(name: string): string {
  if (!LEAN_NAME_RE.test(name)) throw new Error(`invalid lean name: ${name}`);
  return name.replaceAll("_", "-");
}
