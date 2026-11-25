import { useState } from "react";
import { ApiError, type Decision } from "../api";

export interface DecisionOption {
  value: Decision;
  label: string;
  /** What happens if this is chosen, in plain words. */
  effect: string;
  /** Why it cannot be chosen right now (shown instead of enabling it). */
  disabledReason?: string;
  needsComment?: boolean;
}

/**
 * The reviewer picks a decision, optionally comments, and submits. The page's source hash is sent
 * along, so a decision always applies to exactly the text the reviewer read.
 */
export function DecisionForm({ options, onSubmit }: { options: DecisionOption[]; onSubmit: (d: Decision, comment: string) => Promise<void> }) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const chosen = options.find((o) => o.value === decision);
  const missingComment = !!chosen?.needsComment && !comment.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(decision, comment);
      setComment("");
      setDecision(null);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), stale: err instanceof ApiError && err.status === 409 && /changed since you opened/.test(err.message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="decision" onSubmit={submit} aria-label="Your decision">
      <fieldset>
        <legend>Your decision</legend>
        {options.map((o) => (
          <label key={o.value} className={o.disabledReason ? "disabled" : ""}>
            <input
              type="radio"
              name="decision"
              value={o.value}
              disabled={!!o.disabledReason || busy}
              checked={decision === o.value}
              onChange={() => setDecision(o.value)}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="effect">{o.disabledReason ? `Not possible right now: ${o.disabledReason}` : o.effect}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="comment">
        Comment {chosen?.needsComment ? "(required)" : "(optional)"}
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} maxLength={5000} />
      </label>
      {error && (
        <div className="banner bad" role="alert">
          {error.message}
          {error.stale && (
            <button type="button" onClick={() => window.location.reload()}>
              Reload this page
            </button>
          )}
        </div>
      )}
      <button type="submit" disabled={!decision || busy || missingComment}>
        {busy ? "Saving…" : "Submit decision"}
      </button>
    </form>
  );
}
