import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type DefinitionDetail } from "../api";
import { DefinitionBadge, DraftBanner, LeanCode, StatementBadge, when } from "../components/Status";
import { DecisionForm } from "./DecisionForm";
import { useMe } from "./useMe";

export function DefinitionReview() {
  const { id = "" } = useParams();
  const me = useMe();
  const [d, setD] = useState<DefinitionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api.get<DefinitionDetail>(`/review/definitions/${encodeURIComponent(id)}`).then(setD, (e) => setError(String(e.message ?? e)));
  }, [id]);
  if (error) return <div className="banner bad">{error}</div>;
  if (!d || me === undefined) return <p className="muted">Loading…</p>;
  const isAdvisor = me?.role === "advisor";

  return (
    <article>
      <p className="muted small">
        <Link to="/review">← Review queue</Link>
      </p>
      <div className="row">
        <h1>{d.title}</h1>
        <DefinitionBadge status={d.status} draft={d.draft} />
      </div>
      <p className="muted small">
        {d.id} · {d.path}
        {d.requiresMathlib ? " · uses Mathlib (compiled only by the full judge image)" : ""}
      </p>
      {d.draft ? <DraftBanner reasons={d.draftReasons} /> : <div className="banner ok">Reviewed: this exact text was approved by a math advisor.</div>}

      <section>
        <h2>In plain words</h2>
        <p>{d.summary || <span className="muted">No summary was written for this definition.</span>}</p>
      </section>

      <section>
        <h2>What it defines</h2>
        <p className="muted">Each item below is one Lean declaration, with the explanation written next to it in the source.</p>
        {d.declarations.map((x) => (
          <div key={x.name} className="decl">
            <h3>
              <code>{x.name}</code> <span className="muted small">({x.kind})</span>
            </h3>
            {x.doc && <p>{x.doc}</p>}
            <LeanCode code={x.code} label={`Lean code of ${x.name}`} />
          </div>
        ))}
        <details>
          <summary>Show the whole file</summary>
          <LeanCode code={d.source} label="Whole file" />
        </details>
      </section>

      {d.imports.length > 0 && (
        <section>
          <h2>Builds on</h2>
          <ul>
            {d.imports.map((i) => (
              <li key={i.id}>
                <Link to={`/review/definitions/${encodeURIComponent(i.id)}`}>{i.id}</Link> {i.draft ? <span className="badge draft">Draft</span> : <span className="badge ok">Reviewed</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Statements that use it ({d.usedBy.length})</h2>
        {d.usedBy.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul>
            {d.usedBy.map((s) => (
              <li key={s.id}>
                <Link to={`/review/statements/${s.id}`}>
                  {s.id}: {s.title}
                </Link>{" "}
                <StatementBadge status={s.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Decide</h2>
        {saved && <div className="banner ok" role="status">{saved}</div>}
        <DecisionForm
          options={[
            {
              value: "approve",
              label: "Approve",
              effect: "This exact text matches the intended mathematical definition. Statements that use it can then be approved.",
              disabledReason: isAdvisor ? undefined : "only a math advisor can approve a definition",
            },
            { value: "request_changes", label: "Request changes", effect: "It stays a draft. Say what is wrong or missing.", needsComment: true },
            { value: "comment", label: "Comment only", effect: "Adds a note to the history; nothing changes.", needsComment: true },
          ]}
          onSubmit={async (decision, comment) => {
            const next = await api.post<DefinitionDetail>(`/review/definitions/${encodeURIComponent(id)}`, { decision, comment, sha256: d.sourceSha256 });
            setD(next);
            setSaved(decision === "approve" ? "Approved. This definition is no longer a draft." : decision === "request_changes" ? "Changes requested. It stays a draft." : "Comment saved.");
          }}
        />
      </section>

      <History entries={d.history} />
    </article>
  );
}

export function History({ entries }: { entries: DefinitionDetail["history"] }) {
  if (!entries.length) return null;
  const label = { approve: "approved", request_changes: "requested changes", reject: "rejected", comment: "commented" } as const;
  return (
    <section>
      <h2>History</h2>
      <ul className="history">
        {entries.map((h, i) => (
          <li key={i}>
            <strong>{h.reviewer}</strong> ({h.role}) {label[h.decision]} · <span className="muted">{when(h.ts)}</span>
            {h.comment && <blockquote>{h.comment}</blockquote>}
          </li>
        ))}
      </ul>
    </section>
  );
}
