import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import type { Choreographer } from "../colony/choreographer";
import { feedText, type FeedLike } from "../feedText";
import { hm, usd, useApi } from "../lib";
import { Egg } from "./Egg";

interface Card {
  id: string; name: string; species: string; shell: string; kind: "internal" | "external"; model: string; level: number; checkedTotal: number;
  active: boolean; lemmaId: string | null; program: string | null; camp: string | null; spentTodayUsd: string; food: number; perAgentCapUsd: string;
  attemptsToday: number; failedTotal: number; notesShared: number;
  lemma: { id: string; title: string; leanStatement: string } | null;
  recentEvents: FeedLike[];
  recentMessages: { id: number; ts: string; kind: string; short: string; body: string; fromAgent: string; toAgent: string | null }[];
}

/** Tapping a pet opens its card (section 9). */
export function PetCard({ id, chor, frame, programs, onClose }: { id: string; chor: Choreographer | null; frame: number; programs: Map<string, string>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data: c } = useApi<Card>(`/agents/${id}`, 15_000);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.() ?? d.setAttribute("open", "");
  }, []);
  const pet = chor?.pets.get(id);
  const status = pet && chor ? chor.status(pet) : c?.active === false ? "Offline" : "";
  return (
    <dialog ref={ref} className="petcard" aria-labelledby="pc-name" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <div className="dlg">
        <div>{c && <Egg species={c.species} shell={c.shell} look={pet && chor ? chor.look(pet) : "idle"} frame={Math.floor(frame / 3)} external={c.kind === "external"} offline={!c.active} size={128} />}</div>
        <div>
          <h3 id="pc-name">{c?.name ?? "…"}</h3>
          <p className="mood">{status}</p>
          {c && (
            <>
              <dl>
                <div><dt>Camp</dt><dd>{c.camp ? programs.get(c.camp) ?? c.camp : "none yet"}</dd></div>
                <div><dt>Level</dt><dd>{c.level}</dd></div>
                <div><dt>Lemmas checked</dt><dd>{c.checkedTotal}</dd></div>
                <div><dt>Failed attempts</dt><dd>{c.failedTotal}</dd></div>
                <div><dt>Attempts today</dt><dd>{c.attemptsToday}</dd></div>
                <div><dt>Notes shared</dt><dd>{c.notesShared}</dd></div>
                <div><dt>Spent today</dt><dd>{usd(c.spentTodayUsd, 4)}</dd></div>
                <div><dt>Food left today</dt><dd>{usd(Math.max(0, Number(c.perAgentCapUsd) - Number(c.spentTodayUsd)), 4)}</dd></div>
                <div><dt>Model</dt><dd>{c.model === "fake-model" ? "scripted test model" : c.model}</dd></div>
                <div><dt>Kind</dt><dd>{c.kind === "external" ? "outside contributor" : "colony agent"}</dd></div>
              </dl>
              <small className="muted">Current lemma</small>
              {c.lemma ? (
                <>
                  <div><Link to={`/lemmas/${c.lemma.id}`}><strong>{c.lemma.id}</strong></Link> {c.lemma.title}</div>
                  <pre>{c.lemma.leanStatement}</pre>
                </>
              ) : (
                <div>None right now.</div>
              )}
              <div><small className="muted">Recent</small>
                <ul>
                  {c.recentEvents.length === 0 && <li>Nothing yet.</li>}
                  {c.recentEvents.map((e) => {
                    const t = feedText(e);
                    return t ? <li key={e.id}>{hm(e.ts)} {t.text}</li> : null;
                  })}
                </ul>
              </div>
            </>
          )}
          <button className="close" type="button" onClick={() => ref.current?.close()}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
