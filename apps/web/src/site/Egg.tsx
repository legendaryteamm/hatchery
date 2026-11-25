import { useEffect, useRef } from "react";
import type { Look } from "../colony/sprites";
import { drawEgg } from "../colony/render";
import { readPalette } from "../lib";

/** A tamagotchi egg with a small LCD showing the pet. */
export function Egg({ species, shell, look, frame, external, offline, size = 128 }: { species: string; shell: string; look: Look; frame: number; external: boolean; offline?: boolean; size?: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = cv.current?.getContext?.("2d");
    if (!ctx) return;
    const pal = readPalette();
    drawEgg(ctx, size, species, pal.shells[shell] ?? pal.shells.pink!, pal, look, frame, false, external);
  }, [species, shell, look, frame, external, size]);
  return (
    <div className={`egg${external ? " external" : ""}${offline ? " offline" : ""}`} style={{ ["--shell" as string]: `var(--${shell})` }}>
      <div className="screen"><canvas ref={cv} width={size} height={(size * 15) / 16} aria-hidden="true" /></div>
      <div className="btns" aria-hidden="true"><i /><i /><i /></div>
    </div>
  );
}

export function FoodBar({ food }: { food: number }) {
  const cls = food <= 0 ? "food out" : food < 0.3 ? "food low" : "food";
  return (
    <div className={cls} role="meter" aria-label="Food left today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(food * 100)}>
      <span style={{ width: `${Math.round(food * 100)}%` }} />
    </div>
  );
}
