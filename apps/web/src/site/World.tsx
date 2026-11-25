import { useEffect, useRef } from "react";
import type { Choreographer } from "../colony/choreographer";
import { CAMPS, JUDGE, WH, WW } from "../colony/layout";
import { drawFrame, drawStatic } from "../colony/render";
import { readPalette } from "../lib";

const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The LCD world inside the plastic device. Pets can be tapped to open their card. */
export function World({ chor, frame, bowlFill, onSelect, emptyText }: { chor: Choreographer | null; frame: number; bowlFill: number; onSelect: (id: string) => void; emptyText: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const scale = useRef({ S: 4, gap: 1, dirty: true });
  const pal = useRef(typeof document !== "undefined" ? readPalette() : null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const S = Math.max(2, Math.round((r.width * dpr) / WW));
      scale.current = { S, gap: S >= 4 ? 1 : 0, dirty: true };
      if (cv.current) { cv.current.width = WW * S; cv.current.height = WH * S; }
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(el);
    const repaint = () => { pal.current = readPalette(); scale.current.dirty = true; };
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", repaint);
    const mo = new MutationObserver(repaint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { ro?.disconnect(); mq?.removeEventListener?.("change", repaint); mo.disconnect(); };
  }, []);

  useEffect(() => {
    const canvas = cv.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || !chor || !pal.current) return;
    const { S, gap } = scale.current;
    if (scale.current.dirty || !bg.current) {
      bg.current = bg.current ?? document.createElement("canvas");
      bg.current.width = canvas.width;
      bg.current.height = canvas.height;
      const bctx = bg.current.getContext("2d");
      if (bctx) drawStatic(bctx, S, gap, pal.current);
      scale.current.dirty = false;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bg.current, 0, 0);
    drawFrame(ctx, chor, S, gap, pal.current, Math.floor(frame / 3), frame, reduce, bowlFill);
  }, [frame, chor, bowlFill]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chor) return;
    const r = e.currentTarget.getBoundingClientRect();
    const lx = ((e.clientX - r.left) / r.width) * WW;
    const ly = ((e.clientY - r.top) / r.height) * WH;
    let best: string | null = null;
    let bd = 1e9;
    for (const p of chor.pets.values()) {
      const d = Math.hypot(p.x - lx, p.y - 5 - ly);
      if (d < bd) { bd = d; best = p.id; }
    }
    if (best && bd < 11) onSelect(best);
  };

  return (
    <div className="device">
      <div className="world" ref={box} data-frame={frame} data-pets={chor?.pets.size ?? 0}>
        <canvas ref={cv} onClick={click} aria-label="The colony: provers in their camps, walking to the Lean judge, talking and napping. Every move is a real event." />
        {Object.entries(CAMPS).map(([slug, c]) => {
          const p = chor?.programs.get(slug);
          return (
            <div key={slug} className={`wl${c.top ? "" : " b"}`} style={{ left: `${(c.x / WW) * 100}%`, top: `${((c.labelY ?? (c.top ? 1.5 : 99)) / WH) * 100}%` }}>
              {c.label} {p ? `${p.checked}/${p.total}` : "0/0"}
            </div>
          );
        })}
        <div className="wl b" style={{ left: `${(JUDGE.x / WW) * 100}%`, top: `${(34.5 / WH) * 100}%` }}>Lean judge</div>
        <div className="wl" style={{ left: "50%", top: `${(1.5 / WH) * 100}%` }}>Nap corner</div>
        <div className="wl b" style={{ left: "50%", top: "99%" }}>Pantry</div>
        {chor?.bubbles.map((b) => {
          const p = chor.pets.get(b.petId);
          if (!p) return null;
          const left = (Math.max(20, Math.min(140, p.x)) / WW) * 100;
          const above = p.y - 14 > 18;
          return (
            <div key={`${b.cause}-${b.petId}`} className={`bubble${above ? "" : " below"}`} data-event-id={b.cause} data-message-id={b.messageId ?? undefined}
              style={{ left: `${left}%`, top: `${((above ? p.y - 14 : p.y + 3) / WH) * 100}%` }}>
              {b.text}
            </div>
          );
        })}
        {emptyText && <div className="empty-world">{emptyText}</div>}
      </div>
      <div className="devbtns" aria-hidden="true"><i /><i /><i /></div>
    </div>
  );
}
