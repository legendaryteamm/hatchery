import { useEffect, useState } from "react";
import { api } from "./api";

/** GET a desk endpoint; refetch when `path` or `reloadKey` change, or every `refreshMs`. */
export function useApi<T>(path: string | null, refreshMs = 0, reloadKey: unknown = 0): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () => api.get<T>(path).then((d) => alive && (setData(d), setError(null)), (e) => alive && setError(String(e.message ?? e)));
    void load();
    const t = refreshMs ? setInterval(load, refreshMs) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [path, refreshMs, reloadKey]);
  return { data, error };
}

export const usd = (v: string | number | null | undefined, digits = 2) =>
  v === null || v === undefined ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** Days of food, readable: one decimal under 100, whole days up to a year, then "over a year". */
export const days = (d: number | null | undefined) => (d === null || d === undefined ? "—" : d >= 365 ? "over a year" : d >= 100 ? String(Math.round(d)) : d.toFixed(1));

export const hm = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const dayTime = (ts: string) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Read the CSS colour tokens (they change with light/dark mode). */
export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string) => cs.getPropertyValue(k).trim() || "#000";
  return {
    pix: v("--pix"),
    lcd: v("--lcd"),
    bowl: v("--tang"),
    scroll: "#FFFDF6",
    shells: { pink: v("--pink"), sky: v("--sky"), lime: v("--lime"), grape: v("--grape"), tang: v("--tang"), mint: v("--mint") } as Record<string, string>,
  };
}
