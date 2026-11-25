import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Choreographer, FRAME_MS, type RawEvent } from "../colony/choreographer";
import type { FeedLike } from "../feedText";

export interface ColonyAgentData {
  id: string; name: string; species: string; shell: string; kind: "internal" | "external"; model: string; level: number;
  checkedTotal: number; active: boolean; lemmaId: string | null; program: string | null; heartbeatFresh: boolean; lastHeartbeat: string | null;
  sleeping: boolean; sleepReason: string | null; camp: string | null; spentTodayUsd: string; food: number;
}
export interface ColonyData {
  asOfEventId: number; serverTime: string;
  programs: { slug: string; title: string; idPrefix: string; checked: number; total: number }[];
  agents: ColonyAgentData[];
  pantry: { pantryUsd: string; runwayDays: number | null; hungry: boolean; perAgentCapUsd: string; killSwitch: boolean };
  totals: { checked: number; lemmas: number; awake: number };
}

/**
 * The live colony: one snapshot, then the event stream after it (in id order), a refresh of slow
 * facts every 30 s, and one animation loop at 10 frames per second.
 */
export function useColony(onFrame?: (c: Choreographer, frame: number) => void) {
  const [data, setData] = useState<ColonyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedLike[]>([]);
  const [frame, setFrame] = useState(0);
  const chor = useRef<Choreographer | null>(null);
  const frameCb = useRef(onFrame);
  frameCb.current = onFrame;

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let loop: ReturnType<typeof setInterval> | undefined;
    let refresh: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const snap = await api.get<ColonyData>("/colony");
        if (!alive) return;
        chor.current = new Choreographer(snap);
        setData(snap);
        const recent = await api.get<FeedLike[]>("/feed?limit=40");
        if (alive) setFeed(recent);
        es = new EventSource(`/api/events/stream?after=${snap.asOfEventId}`);
        es.onmessage = (m) => {
          const e = JSON.parse(m.data) as RawEvent & { ts: string };
          chor.current?.apply(e);
          setFeed((f) => (f.some((x) => x.id === e.id) ? f : [{ ...e, agentName: null, message: null }, ...f].slice(0, 80)));
        };
        let n = 0;
        loop = setInterval(() => {
          const c = chor.current;
          if (!c) return;
          c.step();
          n++;
          frameCb.current?.(c, n);
          setFrame(n);
        }, FRAME_MS);
        refresh = setInterval(async () => {
          try {
            const s = await api.get<ColonyData>("/colony");
            chor.current?.refresh(s);
            if (alive) setData(s);
          } catch {
            /* keep the last data; the next refresh retries */
          }
        }, 30_000);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      es?.close();
      if (loop) clearInterval(loop);
      if (refresh) clearInterval(refresh);
    };
  }, []);

  return { data, error, feed, frame, chor: chor.current };
}
