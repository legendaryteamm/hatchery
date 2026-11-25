/**
 * The colony world: a 160 x 100 logical pixel grid (BUILD_PROMPT.md section 9).
 * Four research camps in the corners, the Lean judge in the centre, the nap corner at the top,
 * the pantry bowl at the bottom, and a small warm-up bench under the judge for the core
 * calibration lemmas (they are not a research program, so they are not one of the four camps).
 */
export const WW = 160;
export const WH = 100;

export interface Camp {
  /** Centre x of the camp. */
  x: number;
  /** Top row of the chalkboard. */
  board: number;
  /** Where the pets of this camp stand (feet). */
  py: number;
  /** Label at the top (true) or bottom (false) edge. */
  top: boolean;
  label: string;
  /** Board half-width. */
  half: number;
  /** Label row, when it is not at the world's edge. */
  labelY?: number;
}

export const CAMPS: Record<string, Camp> = {
  "circuit-lower-bounds": { x: 24, board: 8, py: 34, top: true, label: "Circuits", half: 11 },
  "monotone-circuits": { x: 136, board: 8, py: 34, top: true, label: "Monotone", half: 11 },
  "proof-complexity": { x: 24, board: 58, py: 84, top: false, label: "Proof cx", half: 11 },
  barriers: { x: 136, board: 58, py: 84, top: false, label: "Barriers", half: 11 },
  "core-warmup": { x: 80, board: 63, py: 84, top: true, label: "Warm-up", half: 8, labelY: 59 },
};

/** Where pets go when their camp is unknown (never leased yet). */
export const COMMONS = { x: 80, y: 84 };

export const JUDGE = { x: 80, y: 60 };

/** Nap corner slots (feet positions), filled left to right, then a row up. */
export function nestSlot(i: number): { x: number; y: number } {
  return { x: 63 + (i % 6) * 7, y: 21 - Math.floor(i / 6) * 5 };
}

/** Spots around the pantry bowl. */
export const BOWL_SPOTS = [59, 63, 97, 101].map((x) => ({ x, y: 96 }));

export function campOf(program: string | null | undefined): Camp | null {
  return program ? CAMPS[program] ?? null : null;
}

/**
 * Standing spots at each camp: a small grid (columns 8 px apart, rows 5 px apart, so a crowd overlaps
 * like a crowd). Front row first, centre columns first. A pet always gets the same spot at a camp
 * (no random wandering); a camp with more pets than spots reuses spots.
 */
const GRIDS: Record<string, { cols: number; rows: number[] }> = {
  "circuit-lower-bounds": { cols: 5, rows: [0, 5, 10] },
  "monotone-circuits": { cols: 5, rows: [0, 5, 10] },
  "proof-complexity": { cols: 5, rows: [0, 5, 10] },
  barriers: { cols: 5, rows: [0, 5, 10] },
  "core-warmup": { cols: 8, rows: [2, -2, -6] },
};
const COMMONS_GRID = { cols: 8, rows: [2, -2, -6] };

export function campSpot(program: string | null | undefined, petIndex: number): { x: number; y: number } {
  const c = campOf(program);
  const g = (program && GRIDS[program]) || COMMONS_GRID;
  const cx = c ? c.x : COMMONS.x;
  const by = c ? c.py : COMMONS.y;
  const slot = petIndex % (g.cols * g.rows.length);
  const row = Math.floor(slot / g.cols);
  const k = slot % g.cols;
  // centre-out column order: 0, +1, -1, +2, -2, ...
  const order = Array.from({ length: g.cols }, (_, i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2)).sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
  const col = order[k]! + (g.cols % 2 ? 0 : 0.5);
  return { x: Math.round(cx + col * 8), y: by + g.rows[row]! };
}
