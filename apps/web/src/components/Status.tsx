import type { DefinitionStatus } from "../api";

/** A definition is shown as DRAFT unless it is approved for its current text (and all it uses is too). */
export function DefinitionBadge({ status, draft }: { status: DefinitionStatus; draft: boolean }) {
  if (!draft) return <span className="badge ok">Approved by AI review</span>;
  if (status === "rejected") return <span className="badge bad">Rejected by AI review</span>;
  if (status === "blocked") return <span className="badge bad">Blocked by an admin</span>;
  if (status === "changes_requested") return <span className="badge warn">Draft · changes requested</span>;
  return <span className="badge draft">Draft · in AI review</span>;
}

export function StatementBadge({ status }: { status: string }) {
  const cls = status === "approved" ? "ok" : status === "rejected" ? "bad" : "draft";
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Waiting for review";
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function DraftBanner({ reasons }: { reasons: string[] }) {
  return (
    <div className="banner draft" role="status">
      <strong>Not approved.</strong> This version has not passed the automated review (AI reviewer agents, proved sanity
      lemmas, an adversary). No statement that uses it can be approved, and nothing proved about it counts until it passes.
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
