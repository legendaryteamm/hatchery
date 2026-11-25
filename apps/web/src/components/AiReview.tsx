import { Link } from "react-router-dom";
import { useApi } from "../lib";
import { when } from "./Status";

export const AI_REVIEW_LABEL = "Reviewed by AI agents, not by a human mathematician.";

/** Shown wherever a definition or statement appears. */
export function AiReviewLabel() {
  return (
    <p className="ailabel" role="note">
      <strong>{AI_REVIEW_LABEL}</strong> <Link to="/how-it-works#review" className="small">How the review works</Link>
    </p>
  );
}

export interface ReviewStepView { id: number; ts: string; kind: string; actor: string; model: string | null; verdict: "pass" | "fail" | "info"; summary: string; reasoning: string; costUsd: string }
export interface ReviewRoundView {
  id: number; status: string; trigger: string; reason: string; startedAt: string; finishedAt: string | null;
  adversary: { checks: number; spentUsd: string; done: boolean } | null; steps: ReviewStepView[];
}
export interface ReviewHistoryView {
  label: string;
  rounds: ReviewRoundView[];
  sanity: { status: "pass" | "fail" | "pending"; reason: string; lemmas: { id: string; title: string; status: string }[] } | null;
}

const STEP_LABEL: Record<string, string> = {
  reviewer: "Reviewer agent", sanity: "Sanity lemmas", adversary: "Adversary agent", filter: "Automatic check",
  definitions: "Definitions used", flag: "Public flag", admin: "Admin", human: "Human reviewer",
};
const ROUND_LABEL: Record<string, string> = { running: "in review", approved: "approved", rejected: "rejected", superseded: "replaced by a newer review" };
const TRIGGER_LABEL: Record<string, string> = { new: "new", changed: "source changed", flag: "flagged by the public", admin: "admin", dependency: "a definition it uses changed" };

/** Every review round, newest first, each step with its full reasoning. */
export function ReviewHistory({ history }: { history: ReviewHistoryView | null }) {
  if (!history) return null;
  return (
    <section aria-labelledby="review-h">
      <h2 id="review-h">Review</h2>
      <AiReviewLabel />
      {history.sanity && (
        <div className="panel">
          <h3>Sanity lemmas <span className={`badge ${history.sanity.status === "pass" ? "ok" : history.sanity.status === "fail" ? "bad" : "draft"}`}>{history.sanity.status === "pass" ? "all proved" : history.sanity.status === "fail" ? "failed" : "in progress"}</span></h3>
          <p className="small muted">Known basic facts that must be provable from this definition before it is approved. The colony's provers prove them; the Lean judge checks them.</p>
          <ul className="cards">
            {history.sanity.lemmas.map((l) => <li key={l.id} className="row"><Link to={`/lemmas/${l.id}`}><strong>{l.id}</strong> {l.title}</Link><span className="small muted">{l.status}</span></li>)}
          </ul>
        </div>
      )}
      {history.rounds.length === 0 && <p className="muted">No review yet.</p>}
      {history.rounds.map((r) => (
        <div key={r.id} className="panel round">
          <div className="row">
            <h3>Review #{r.id}: <span className={`badge ${r.status === "approved" ? "ok" : r.status === "rejected" ? "bad" : "draft"}`}>{ROUND_LABEL[r.status] ?? r.status}</span></h3>
            <span className="small muted">{TRIGGER_LABEL[r.trigger] ?? r.trigger} · {when(r.startedAt)}</span>
          </div>
          {r.reason && <p className="small">{r.reason}</p>}
          {r.adversary && (r.adversary.checks > 0 || r.adversary.done) && <p className="small muted">Adversary: {r.adversary.checks} judged attempts, ${Number(r.adversary.spentUsd).toFixed(2)} spent.</p>}
          <ol className="steps-list">
            {r.steps.map((s) => (
              <li key={s.id} className={`step v-${s.verdict}`}>
                <div><strong>{STEP_LABEL[s.kind] ?? s.kind}</strong> <span className="small muted">{s.actor}{s.model ? ` (${s.model})` : ""}</span> <span className={`badge ${s.verdict === "pass" ? "ok" : s.verdict === "fail" ? "bad" : "neutral"}`}>{s.verdict}</span></div>
                <p>{s.summary}</p>
                {s.reasoning && (
                  <details>
                    <summary>{s.kind === "flag" ? "Text of the flag (written by a member of the public)" : "Full reasoning"}</summary>
                    <pre className="reasoning">{s.reasoning}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

/** The review history of a statement (lemma page). */
export function StatementReviewHistory({ id }: { id: string }) {
  const { data } = useApi<ReviewHistoryView>(`/statements/${id}/review`, 60_000);
  return <ReviewHistory history={data} />;
}
