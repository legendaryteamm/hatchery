import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type StatementDetail } from "../api";
import { LeanCode, StatementBadge } from "../components/Status";
import { DecisionForm } from "./DecisionForm";
import { History } from "./DefinitionReview";

function Check({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <li className={ok === null ? "pending" : ok ? "pass" : "fail"}>
      <span aria-hidden>{ok === null ? "…" : ok ? "✓" : "✗"}</span> {label}
      {detail && <span className="muted"> — {detail}</span>}
    </li>
  );
}

export function StatementReview() {
  const { id = "" } = useParams();
  const [s, setS] = useState<StatementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api.get<StatementDetail>(`/review/statements/${id}`).then(setS, (e) => setError(String(e.message ?? e)));
  }, [id]);
  if (error) return <div className="banner bad">{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const c = s.check;
  const dup = s.approvalBlockers.find((b) => b.startsWith("duplicate of"));
  const draftDefs = s.definitions.filter((d) => d.draft);

  return (
    <article>
      <p className="muted small">
        <Link to="/review">← Review queue</Link>
      </p>
      <div className="row">
        <h1>
          {s.id}: {s.title}
        </h1>
        <StatementBadge status={s.status} />
      </div>
      <p className="muted small">
        {s.programTitle} · proposed by {s.origin === "decomposer" ? `the decomposer agent (${s.proposedBy})` : "the repository"}
        {s.parentId ? ` · a smaller step of ${s.parentId}` : ""}
      </p>

      <section>
        <h2>The statement</h2>
        <LeanCode code={s.leanStatement} label="The proposition" />
        <details>
          <summary>Show the whole statement file</summary>
          <LeanCode code={s.source} label="Statement file" />
        </details>
      </section>

      {s.rationale && (
        <section>
          <h2>Why it was proposed</h2>
          <p>{s.rationale}</p>
        </section>
      )}

      <section>
        <h2>Definitions it uses</h2>
        {s.definitions.length === 0 ? (
          <p className="muted">None (only Lean's core library).</p>
        ) : (
          <ul>
            {s.definitions.map((d) => (
              <li key={d.id}>
                <Link to={`/review/definitions/${encodeURIComponent(d.id)}`}>{d.id}</Link>{" "}
                {d.draft ? <span className="badge draft">Draft</span> : <span className="badge ok">Reviewed</span>}
              </li>
            ))}
          </ul>
        )}
        {draftDefs.length > 0 && (
          <div className="banner draft">
            This statement uses {draftDefs.length === 1 ? "a draft definition" : "draft definitions"}. It cannot be approved until a math advisor
            reviews {draftDefs.length === 1 ? "it" : "them"}.
          </div>
        )}
      </section>

      <section>
        <h2>Automatic checks</h2>
        <ul className="checks">
          <Check ok={c ? c.wellFormed : null} label="Well-formed (one statement, allowed imports, no forbidden words)" />
          <Check ok={c ? c.elaborates : null} label="Lean understands it" detail={c && !c.elaborates ? c.errors.slice(0, 2).join("; ") : undefined} />
          <Check ok={c ? !c.trivial : null} label="Not trivial (no automatic tactic closes it)" detail={c?.trivial ? `closed by ${c.trivialBy}` : undefined} />
          <Check ok={!dup} label="Not a duplicate" detail={dup} />
        </ul>
        {!c && <p className="muted small">The check has not run yet (statements that use Mathlib are checked by the full judge image).</p>}
      </section>

      {s.status === "rejected" && s.rejectReason && <div className="banner bad">Rejected: {s.rejectReason}</div>}

      <section>
        <h2>Decide</h2>
        {saved && <div className="banner ok" role="status">{saved}</div>}
        <DecisionForm
          options={[
            {
              value: "approve",
              label: "Approve",
              effect: "It is a correct, meaningful statement. It becomes a lemma the agents can work on.",
              disabledReason: s.status !== "proposed" ? `it is already ${s.status}` : s.canApprove ? undefined : s.approvalBlockers.join("; "),
            },
            { value: "request_changes", label: "Request changes", effect: "It stays in the queue. Say what should change.", needsComment: true },
            { value: "reject", label: "Reject", effect: "It is removed from the queue for good. Say why.", needsComment: true },
            { value: "comment", label: "Comment only", effect: "Adds a note to the history; nothing changes.", needsComment: true },
          ]}
          onSubmit={async (decision, comment) => {
            const next = await api.post<StatementDetail>(`/review/statements/${s.id}`, { decision, comment, sha256: s.sourceSha256 });
            setS(next);
            setSaved(decision === "approve" ? "Approved. Agents can now lease this lemma." : decision === "reject" ? "Rejected." : "Saved.");
          }}
        />
      </section>

      <History entries={s.history} />
    </article>
  );
}
