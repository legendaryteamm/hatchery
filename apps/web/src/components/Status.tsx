import type { DefinitionStatus } from "../api";

/** A definition is shown as DRAFT unless it is approved for its current text (and all it uses is too). */
export function DefinitionBadge({ status, draft }: { status: DefinitionStatus; draft: boolean }) {
  if (!draft) return <span className="badge ok">Reviewed</span>;
  if (status === "changes_requested") return <span className="badge warn">Draft · changes requested</span>;
  return <span className="badge draft">Draft</span>;
}

export function StatementBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "ok" : status === "rejected" ? "bad" : "draft";
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Waiting for review";
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function DraftBanner({ reasons }: { reasons: string[] }) {
  return (
    <div className="banner draft" role="status">
      <strong>Draft definition.</strong> A math advisor has not reviewed this version yet. No statement that uses it can be
      approved, and nothing proved about it counts until it is reviewed.
      {reasons.length > 0 && (
        <ul>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LeanCode({ code, label }: { code: string; label?: string }) {
  return (
    <pre className="lean" aria-label={label ?? "Lean code"}>
      <code>{code}</code>
    </pre>
  );
}

export function when(ts: string) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
