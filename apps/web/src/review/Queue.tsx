import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Queue as QueueData } from "../api";
import { DefinitionBadge } from "../components/Status";

export function Queue() {
  const [q, setQ] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<QueueData>("/review/queue").then(setQ, (e) => setError(String(e.message ?? e)));
  }, []);
  if (error) return <div className="banner bad">{error}</div>;
  if (!q) return <p className="muted">Loading…</p>;
  const drafts = q.definitions.filter((d) => d.draft);
  return (
    <div>
      <h1>Review queue</h1>
      <p className="lead">
        Agents may only work on statements a person approved. A statement can only be approved when every definition it uses has been
        reviewed by a math advisor. Start with the definitions.
      </p>

      <h2>
        Definitions <span className="muted">({drafts.length} of {q.definitions.length} still drafts)</span>
      </h2>
      <ul className="cards">
        {q.definitions.map((d) => (
          <li key={d.id} className="card">
            <div className="row">
              <Link to={`/review/definitions/${encodeURIComponent(d.id)}`}>
                <strong>{d.title}</strong>
              </Link>
              <DefinitionBadge status={d.status} draft={d.draft} />
            </div>
            <p>{d.summary}</p>
            <p className="muted small">
              {d.id}
              {d.requiresMathlib ? " · uses Mathlib" : ""}
            </p>
          </li>
        ))}
      </ul>

      <h2>
        Proposed statements <span className="muted">({q.statements.length})</span>
      </h2>
      {q.statements.length === 0 && <p className="muted">Nothing is waiting.</p>}
      <ul className="cards">
        {q.statements.map((s) => (
          <li key={s.id} className="card">
            <div className="row">
              <Link to={`/review/statements/${s.id}`}>
                <strong>
                  {s.id}: {s.title}
                </strong>
              </Link>
              <span className={`badge ${s.canApprove ? "ok" : "draft"}`}>{s.canApprove ? "Ready to decide" : "Blocked"}</span>
            </div>
            <p className="muted small">
              {s.program} · proposed by {s.origin === "decomposer" ? "the decomposer agent" : "the repository"}
            </p>
            {!s.canApprove && (
              <ul className="blockers">
                {s.approvalBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
