/** Pixel creatures, 12 x 11, one per species (from design/reference.html). */
export const SPRITES: Record<string, string[]> = {
  blob: ["....####....", "..##....##..", ".#........#.", "#..........#", "#..........#", "#..........#", "#..........#", "#..........#", ".#........#.", "..########..", "..##....##.."],
  cat: [".#........#.", "#.#......#.#", "#..######..#", "#..........#", "#..........#", "#..........#", "#..........#", "#..........#", ".#........#.", "..########..", "..##....##.."],
  bug: ["...#....#...", "....#..#....", "..########..", ".#........#.", "#..........#", "#..........#", "#..........#", "#..........#", ".#........#.", "..########..", ".#..#..#..#."],
  ghost: [".....##.....", "....#..#....", "...#....#...", "..#......#..", ".#........#.", "#..........#", "#..........#", "#..........#", "#..........#", "#.##.##.##.#", ".#..#..#..#."],
};

export interface Mask {
  line: [number, number][];
  fill: [number, number][];
}

/** Outline pixels and interior (fill) pixels of each sprite. */
export const MASKS: Record<string, Mask> = Object.fromEntries(
  Object.entries(SPRITES).map(([k, sp]) => {
    const h = sp.length;
    const w = sp[0]!.length;
    const out = Array.from({ length: h }, () => Array<boolean>(w).fill(false));
    const q: [number, number][] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if ((y === 0 || x === 0 || y === h - 1 || x === w - 1) && sp[y]![x] === ".") {
          out[y]![x] = true;
          q.push([x, y]);
        }
    while (q.length) {
      const [x, y] = q.pop()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && !out[ny]![nx] && sp[ny]![nx] === ".") {
          out[ny]![nx] = true;
          q.push([nx, ny]);
        }
      }
    }
    const line: [number, number][] = [];
    const fill: [number, number][] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) (sp[y]![x] === "#" ? line : !out[y]![x] ? fill : null)?.push([x, y]);
    return [k, { line, fill }];
  }),
);

/** What a pet looks like this frame. */
export type Look = "working" | "idle" | "walk" | "sad" | "celebrate" | "talk" | "sleeping" | "hungry";

/**
 * Paint one creature. P = outline pixel, F = fill pixel (shell colour), E = pattern pixel for
 * external agents (a different shell pattern: dots), f = animation frame.
 */
export function paint(
  P: (x: number, y: number) => void,
  F: ((x: number, y: number) => void) | null,
  species: string,
  ox: number,
  oy: number,
  look: Look,
  f: number,
  external = false,
  E: ((x: number, y: number) => void) | null = null,
): void {
  const m = MASKS[species] ?? MASKS.blob!;
  if (F) for (const [x, y] of m.fill) F(ox + x, oy + y);
  if (external && E) for (const [x, y] of m.fill) if ((x + y) % 4 === 0 && y > 6) E(ox + x, oy + y);
  for (const [x, y] of m.line) P(ox + x, oy + y);
  const blink = (look === "working" || look === "idle") && f % 9 === 0;
  for (const [x, y] of [[ox + 3, oy + 5], [ox + 8, oy + 5]] as const) {
    if (look === "sleeping" || blink) { P(x - 1, y); P(x, y); P(x + 1, y); }
    else if (look === "celebrate") { P(x - 1, y); P(x, y - 1); P(x + 1, y); }
    else if (look === "sad") { P(x - 1, y - 1); P(x + 1, y - 1); P(x, y); P(x - 1, y + 1); P(x + 1, y + 1); }
    else P(x, y);
  }
  const mx = ox + 5;
  const my = oy + 7;
  if (look === "celebrate") { P(mx - 1, my - 1); P(mx, my); P(mx + 1, my); P(mx + 2, my - 1); }
  else if (look === "sad") { P(mx - 1, my); P(mx, my - 1); P(mx + 1, my - 1); P(mx + 2, my); }
  else if (look === "hungry" || (look === "talk" && f % 2)) { P(mx, my - 1); P(mx + 1, my - 1); P(mx, my); P(mx + 1, my); }
  else if (look !== "sleeping") { P(mx, my); P(mx + 1, my); }
  if (look === "sleeping") {
    const zx = ox + (f % 2 ? 10 : 9);
    const zy = oy - (f % 2 ? 3 : 2);
    P(zx, zy); P(zx + 1, zy); P(zx + 2, zy); P(zx + 1, zy + 1); P(zx, zy + 2); P(zx + 1, zy + 2); P(zx + 2, zy + 2);
  }
  if (look === "working") for (let i = 0; i < f % 4; i++) P(ox + i * 2, oy - 2);
  if (look === "celebrate")
    for (const [x, y] of [f % 2 ? [ox - 1, oy - 2] : [ox + 11, oy - 2], f % 2 ? [ox + 11, oy - 1] : [ox - 1, oy - 1]] as [number, number][]) {
      P(x, y); P(x - 1, y); P(x + 1, y); P(x, y - 1); P(x, y + 1);
    }
  if (look === "sad" && f % 2) P(ox + 2, oy + 7);
  if (look === "hungry") { P(ox + 12, oy - 3); P(ox + 12, oy - 2); P(ox + 12, oy); }
}
