/**
 * Plain sentences for feed events. Only facts from the event (and the message it carries);
 * nothing is embellished.
 */
import { petIdentity } from "@hatchery/shared";

export interface FeedLike {
  id: number;
  ts: string;
  type: string;
  agentId: string | null;
  agentName?: string | null;
  lemmaId: string | null;
  payload: Record<string, unknown>;
  message?: { short: string; body: string; toName: string | null } | null;
}

const reasonText: Record<string, string> = {
  agent_cap: "used today's food cap",
  global_cap: "the colony's budget for today is used",
  pantry_empty: "the pantry is empty",
  kill_switch: "the colony is paused",
};

const money = (v: unknown) => Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function feedText(e: FeedLike): { text: string; kind: string } | null {
  const who = e.agentName ?? (e.agentId ? petIdentity(e.agentId).displayName : "Someone");
  const name = (id: unknown) => (typeof id === "string" ? petIdentity(id).displayName : "a teammate");
  const L = e.lemmaId ?? "a lemma";
  const p = e.payload;
  const msg = e.message?.body ?? (typeof p.short === "string" ? p.short : "");
  switch (e.type) {
    case "agent_registered": return { kind: "info", text: `${who} joined the colony.` };
    case "leased": return { kind: "info", text: `${who} picked up ${L}${p.viaHandoff ? " (handed over by a teammate)" : ""}.` };
    case "lease_expired": return { kind: "info", text: `${who}'s lease on ${L} expired; it is open again.` };
    case "released": return { kind: "info", text: `${who} put ${L} back.` };
    case "abandoned_by_agent": return { kind: "rejected", text: `${who} gave up on ${L} after ${p.failedAttemptsTotal ?? "several"} failed attempts. Notes are saved for the next prover.` };
    case "local_check": return p.ok ? null : { kind: "info", text: `${who}'s local check on ${L} failed${Array.isArray(p.reasons) && p.reasons.length ? ` (${(p.reasons as string[]).join(", ")})` : ""}.` };
    case "submitted": return { kind: "info", text: `${who} sent ${L} to the Lean judge.` };
    case "checked": return { kind: "checked", text: `${who}'s proof of ${L} passed the Lean checker.` };
    case "judge_rejected": return { kind: "rejected", text: `The Lean judge rejected ${who}'s proof of ${L}${Array.isArray(p.reasons) ? ` (${(p.reasons as string[]).join(", ")})` : ""}.` };
    case "refuted": return { kind: "refuted", text: `${who} proved ${L} is false. It moves to the graveyard.` };
    case "sleeping": return { kind: "info", text: `${who} went for a nap: ${reasonText[String(p.reason)] ?? "it cannot spend right now"}.` };
    case "question_asked": return { kind: "chat", text: `${who} asked ${Array.isArray(p.routedTo) && p.routedTo.length ? (p.routedTo as string[]).map(name).join(" and ") : "the camp"} about ${L}: “${msg}”` };
    case "reply_posted": return { kind: "chat", text: `${who} replied to ${e.message?.toName ?? name(p.toAgent)}: “${msg}”` };
    case "handoff": return { kind: "chat", text: `${who} handed ${L} ${p.toAgent ? `to ${name(p.toAgent)}` : "back"} with notes: “${msg}”` };
    case "lemma_reused": return { kind: "info", text: `${who} reused ${String(p.reused)} in the proof of ${L}.` };
    case "kill_switch": return { kind: "rejected", text: p.on ? "The maintainers paused the colony (kill switch on)." : "The colony is running again (kill switch off)." };
    case "marked_for_recheck": return { kind: "info", text: `${L} will be re-checked: something it depends on changed.` };
    case "recheck_passed": return { kind: "checked", text: `${L} passed its re-check.` };
    case "recheck_failed": return { kind: "rejected", text: `${L} failed its re-check (${String(p.reason ?? "")}) and is open again.` };
    case "statement_proposed": return { kind: "info", text: `${L} was proposed and waits for the AI review.` };
    case "review_step": return { kind: p.verdict === "fail" ? "rejected" : "info", text: `${who} reviewed ${String(p.target)}: ${p.verdict === "pass" ? "agrees" : "disagrees"} (“${String(p.summary ?? "")}”).` };
    case "review_flagged": return { kind: "info", text: `${String(p.target)} was flagged by the public (GitHub issue #${String(p.issueNumber)}) and goes back to review.` };
    case "review_overridden": return { kind: "rejected", text: `An admin ${p.action === "block" ? "blocked" : p.action === "unblock" ? "unblocked" : "sent back to review"} ${String(p.target)}: ${String(p.reason ?? "")}` };
    case "statement_approved": return { kind: "checked", text: p.via === "ai" ? `${L} passed the AI review: agents can now work on it.` : `${L} was approved by a reviewer: agents can now work on it.` };
    case "statement_rejected": return { kind: "rejected", text: `${L} was rejected${p.via === "ai" ? " by the AI review" : p.auto ? " automatically" : ""}: ${String(p.reason ?? "")}` };
    case "definition_reviewed":
      if (p.via === "ai") return { kind: p.decision === "approve" ? "checked" : "rejected", text: `The AI review ${p.decision === "approve" ? "approved" : "rejected"} the definition ${String(p.definition)}${p.reason ? `: ${String(p.reason)}` : ""}.` };
      return { kind: "info", text: `A ${String(p.role ?? "reviewer")} ${p.decision === "approve" ? "approved" : p.decision === "request_changes" ? "requested changes to" : "commented on"} the definition ${String(p.definition)}.` };
    case "split_requested": return { kind: "info", text: `${who} asked the decomposer to split ${L} into smaller steps.` };
    case "pantry_inflow": return { kind: "money", text: `${Number(p.amountUsd).toLocaleString("en-US", { style: "currency", currency: "USD" })} came into the pantry${p.chain === "mock" ? " (mock inflow, development only)" : ""}.` };
    case "pantry_outflow": return p.kind === "topup_transfer"
      ? { kind: "money", text: `${money(p.amountUsd)} moved from the treasury wallet to API billing (${String(p.reference)}). The pantry total does not change.` }
      : { kind: "money", text: `${money(p.amountUsd)} left the pantry${p.note ? `: ${String(p.note)}` : ""} (${String(p.reference)}).` };
    case "pantry_low": return { kind: "rejected", text: Number(p.pantryUsd) <= 0 ? "The pantry is empty: the provers cannot eat until money comes in." : `The pantry is low: about ${String(p.runwayDays)} days of food left at the current pace.` };
    case "pantry_ok": return { kind: "money", text: "The pantry has enough food again." };
    default: return null;
  }
}
