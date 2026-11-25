/**
 * Draws the colony world on a canvas: one static layer (boards, judge gate, nap corner, bowl) and a
 * dynamic layer per frame (board progress, bowl fill, gate flash, pets). Pixel-snapped.
 */
import { CAMPS, WH, WW } from "./layout";
import { paint } from "./sprites";
import type { Choreographer } from "./choreographer";

/** The subset of CanvasRenderingContext2D the renderer uses (so it can be benchmarked without a browser). */
export interface Ctx2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage?(img: CanvasImageSource, x: number, y: number): void;
}

export interface Palette {
  pix: string;
  lcd: string;
  shells: Record<string, string>;
  bowl: string;
  scroll: string;
}

const BOWL: [number, number][] = [];
for (let x = 71; x <= 89; x++) BOWL.push([x, 90]);
for (let x = 70; x <= 90; x++) BOWL.push([x, 89]);

export function drawStatic(ctx: Ctx2D, S: number, gap: number, pal: Palette) {
  ctx.clearRect(0, 0, WW * S, WH * S);
  const P = (x: number, y: number) => ctx.fillRect(x * S, y * S, S - gap, S - gap);
  ctx.fillStyle = pal.pix;
  if (gap) {
    ctx.globalAlpha = 0.06;
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) P(x, y);
    ctx.globalAlpha = 1;
  }
  Object.values(CAMPS).forEach((c, i) => {
    const t = c.board;
    for (let x = c.x - c.half; x <= c.x + c.half; x++) { P(x, t); P(x, t + 10); }
    for (let y = t; y <= t + 10; y++) { P(c.x - c.half, y); P(c.x + c.half, y); }
    for (let y = t + 11; y <= t + 13; y++) { P(c.x - c.half + 3, y); P(c.x + c.half - 3, y); }
    for (const row of [t + 3, t + 5]) for (let x = c.x - c.half + 3; x <= c.x + c.half - 3; x++) if ((x * 7 + row * 3 + i) % 5 < 3) P(x, row);
  });
  // judge gate
  for (let x = 69; x <= 91; x++) { P(x, 38); P(x, 39); }
  for (let x = 79; x <= 81; x++) { P(x, 36); P(x, 37); }
  for (let y = 40; y <= 57; y++) { P(71, y); P(72, y); P(88, y); P(89, y); }
  // nap corner (a mat)
  for (let x = 57; x <= 103; x++) { P(x, 22); P(x, 24); }
  P(57, 23); P(103, 23); P(58, 25); P(102, 25);
  // pantry bowl
  for (let x = 68; x <= 92; x++) P(x, 88);
  P(69, 89); P(91, 89); P(70, 90); P(90, 90);
  for (let x = 71; x <= 89; x++) P(x, 91);
}

/**
 * One frame. `animFrame` drives blinks/dots (slower), `walkFrame` drives steps. `reduce` = prefers-reduced-motion.
 * `bowlFill` is 0..1.
 */
export function drawFrame(ctx: Ctx2D, c: Choreographer, S: number, gap: number, pal: Palette, animFrame: number, walkFrame: number, reduce: boolean, bowlFill: number) {
  const P = (x: number, y: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < WW && y < WH) ctx.fillRect(x * S, y * S, S - gap, S - gap);
  };
  // board progress: checked / total of each program (from the data)
  ctx.fillStyle = pal.pix;
  for (const [slug, camp] of Object.entries(CAMPS)) {
    const p = c.programs.get(slug);
    if (!p || !p.total) continue;
    const width = (camp.half - 2) * 2;
    const n = Math.round((width * p.checked) / p.total);
    for (let x = 0; x < n; x++) P(camp.x - camp.half + 2 + x, camp.board + 8);
  }
  // bowl fill
  ctx.fillStyle = pal.bowl;
  const nb = Math.round(BOWL.length * Math.max(0, Math.min(1, bowlFill)));
  for (let i = 0; i < nb; i++) P(BOWL[i]![0], BOWL[i]![1]);
  // gate flash
  ctx.fillStyle = pal.pix;
  if (c.gate.type && (c.gate.frames % 2 || reduce)) {
    if (c.gate.type === "pass") {
      for (const [x, y] of [[77, 49], [78, 50], [79, 51], [80, 50], [81, 49], [82, 48], [83, 47]] as const) P(x, y);
      for (const [x, y] of [[66, 34], [67, 35], [94, 34], [93, 35], [66, 46], [94, 46], [80, 31], [80, 32]] as const) P(x, y);
    } else {
      for (const [x, y] of [[77, 46], [78, 47], [79, 48], [80, 49], [81, 50], [82, 51], [83, 52], [83, 46], [82, 47], [81, 48], [79, 50], [78, 51], [77, 52]] as const) P(x, y);
    }
  }
  // pets, back to front
  const list = [...c.pets.values()].sort((a, b) => a.y - b.y);
  for (const p of list) {
    const look = c.look(p);
    let b = 0;
    if (!reduce) {
      if (look === "walk") b = -(walkFrame % 2);
      else if (look === "celebrate") b = -(Math.floor(walkFrame / 2) % 2) * 2;
      else if (look === "working") b = animFrame % 2; // the small bounce: only with a fresh heartbeat
    }
    const ox = Math.round(p.x) - 6;
    const oy = Math.round(p.y) - 11 + b;
    const shell = pal.shells[p.shell] ?? pal.shells.pink!;
    paint(
      (x, y) => { ctx.fillStyle = pal.pix; P(x, y); },
      (x, y) => { ctx.fillStyle = shell; P(x, y); },
      p.species, ox, oy, look, animFrame + p.index, p.external,
      (x, y) => { ctx.fillStyle = pal.pix; ctx.globalAlpha = 0.35; P(x, y); ctx.globalAlpha = 1; },
    );
    if (p.carry) {
      ctx.fillStyle = pal.scroll;
      P(ox + 12, oy + 5); P(ox + 13, oy + 5); P(ox + 12, oy + 6); P(ox + 13, oy + 6);
      ctx.fillStyle = pal.pix;
      P(ox + 14, oy + 5); P(ox + 14, oy + 6); P(ox + 12, oy + 7); P(ox + 13, oy + 7); P(ox + 14, oy + 7);
    }
  }
}

/** Egg screen (roster and card): 16 x 15 LCD with the same creature. */
export function drawEgg(ctx: Ctx2D, size: number, species: string, shellColor: string, pal: Palette, look: Parameters<typeof paint>[5], frame: number, reduce: boolean, external: boolean) {
  const s = size / 16;
  ctx.clearRect(0, 0, size, (size * 15) / 16);
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = pal.pix;
  for (let y = 0; y < 15; y++) for (let x = 0; x < 16; x++) ctx.fillRect(x * s + 0.5, y * s + 0.5, s - 1, s - 1);
  ctx.globalAlpha = 1;
  const P = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < 16 && y < 15) ctx.fillRect(x * s, y * s, s, s); };
  let b = 0;
  if (!reduce) {
    if (look === "working") b = frame % 2;
    else if (look === "celebrate") b = -(frame % 2);
    else if (look === "sad") b = 1;
  }
  paint(
    (x, y) => { ctx.fillStyle = pal.pix; P(x, y); },
    (x, y) => { ctx.fillStyle = shellColor; P(x, y); },
    species, 2, 3 + b, look === "walk" ? "idle" : look, frame, external,
    (x, y) => { ctx.fillStyle = pal.pix; ctx.globalAlpha = 0.35; P(x, y); ctx.globalAlpha = 1; },
  );
}
