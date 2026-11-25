import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type DefinitionDetail, type DefinitionSummary } from "../api";
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
        Everything the project proves is stated in terms of these definitions. A definition marked <span className="badge draft">Draft</span> has
        not been reviewed by a math advisor yet: statements that use it cannot be approved, and nothing about it counts yet.
      </p>
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
  const [d, setD] = useState<DefinitionDetail | null>(null);
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
      {d.draft && <DraftBanner reasons={d.draftReasons} />}
      <p>{d.summary}</p>
      <LeanCode code={d.source} label="Lean source" />
    </article>
  );
}
