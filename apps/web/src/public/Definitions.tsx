import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type DefinitionDetail, type DefinitionSummary } from "../api";
import { AiReviewLabel, ReviewHistory, type ReviewHistoryView } from "../components/AiReview";
import { DefinitionBadge, DraftBanner, LeanCode } from "../components/Status";

/** Public list: every definition, with drafts clearly marked as drafts. */
export function PublicDefinitions() {
  const [defs, setDefs] = useState<DefinitionSummary[] | null>(null);
  useEffect(() => {
    api.get<DefinitionSummary[]>("/definitions").then(setDefs, () => setDefs([]));
  }, []);
  if (!defs) return <p className="muted">Loading…</p>;
  return (
    <div>
      <h1>Definitions</h1>
      <p className="lead">
        Everything the project proves is stated in terms of these definitions. A definition is approved only when independent AI reviewer
        agents agree it matches the textbook definition, its sanity lemmas (known basic facts) are proved in Lean, and an adversary agent
        fails to derive a contradiction from it. Until then, statements that use it cannot be approved, and nothing about it counts.
      </p>
      <AiReviewLabel />
      <ul className="cards">
        {defs.map((d) => (
          <li key={d.id} className="card">
            <div className="row">
              <Link to={`/definitions/${encodeURIComponent(d.id)}`}>
                <strong>{d.title}</strong>
              </Link>
              <DefinitionBadge status={d.status} draft={d.draft} />
            </div>
            <p>{d.summary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PublicDefinition() {
  const { id = "" } = useParams();
  const [d, setD] = useState<(DefinitionDetail & { aiReview?: ReviewHistoryView }) | null>(null);
  useEffect(() => {
    api.get<DefinitionDetail>(`/definitions/${encodeURIComponent(id)}`).then(setD, () => setD(null));
  }, [id]);
  if (!d) return <p className="muted">Loading…</p>;
  return (
    <article>
      <div className="row">
        <h1>{d.title}</h1>
        <DefinitionBadge status={d.status} draft={d.draft} />
      </div>
      <AiReviewLabel />
      {d.draft && <DraftBanner reasons={d.draftReasons} />}
      <p>{d.summary}</p>
      <LeanCode code={d.source} label="Lean source" />
      <ReviewHistory history={d.aiReview ?? null} />
    </article>
  );
}
