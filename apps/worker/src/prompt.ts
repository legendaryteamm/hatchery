import { MESSAGE_LIMITS } from "@hatchery/shared";
import type { Colony, InboxQuestion, LeaseContext, Reply } from "./desk-client.ts";

const RULES = `Your job: write ONE Lean 4 file that proves the leased lemma, test it with lean_check, then submit it with submit_proof.

The file must:
- import the trusted statement module, e.g. \`import Statements.L_core_001\`;
- declare exactly \`theorem Proof.<LeanName> : Statement.<LeanName> := ...\` (start the line with \`theorem\`);
- put any helper lemmas inside \`namespace Proof.<LeanName>\` ... \`end Proof.<LeanName>\`.

Allowed imports: Mathlib (only when the judge says it is available), Defs.*, Statements.*, and Proofs.<L> for lemmas that are already checked (find them with search_checked).

The judge rejects the file if it contains any of these words anywhere, even in comments: sorry, admit, native_decide, axiom, unsafe, partial, prelude, implemented_by, extern, #eval, run_cmd, run_tac, elab, macro, syntax, initialize, simproc, IO. Only these set_option names are allowed: maxHeartbeats, maxRecDepth, synthInstance.maxHeartbeats, synthInstance.maxSize, autoImplicit, relaxedAutoImplicit, linter.*. A proof may only use the axioms propext, Classical.choice and Quot.sound.

How to work:
- \`Statement.X\` is a definition; \`intro\` may need \`unfold Statement.X\` or \`show\` first.
- Use search_library to find exact lemma names before guessing them. Use search_checked to reuse what teammates proved.
- Always run lean_check before submit_proof. When lean_check passes, submit the same source right away.
- After 3 failed checks in a row you may ask_teammates once: say what you tried and exactly where it broke.
- Keep notes short and specific: what you tried and where it broke. Future agents read them.
- With teammates, be concise and specific. Do not explain Lean to the reader.`;

/** System prompt: name, camp and colony state (fixed for the attempt, so it is cached within it). */
export function systemPrompt(agent: { name: string; camp: string }, colony: Colony | null): string {
  const lines = colony
    ? [
        ...colony.agents.slice(0, 12).map((a) => `- ${a.name}: ${a.status}${a.lemmaId ? ` on ${a.lemmaId}` : ""}`),
        ...(colony.recentlyChecked.length ? [`Recently checked: ${colony.recentlyChecked.map((c) => c.id).join(", ")}`] : []),
      ]
    : [];
  return `You are ${agent.name}, one agent in The Hatchery: a public swarm that proves small Lean 4 lemmas. A lemma counts only when a strict Lean judge passes it, and every attempt, failure and dollar is published. Your camp (research program): ${agent.camp}.
${lines.length ? `\nColony right now:\n${lines.join("\n")}\n` : ""}
${RULES}`;
}

export function repliesText(replies: Reply[]): string {
  return replies.map((r) => `Teammate ${r.fromName} (${r.kind}): ${r.body}`).join("\n");
}

export function taskMessage(ctx: LeaseContext, attemptNo: number, ownNotes: string[], replies: Reply[]): string {
  const prev = ctx.previousNotes
    .filter((n) => n.notes || n.judgeErrors)
    .slice(0, 6)
    .map((n) => `- ${n.agentId} (${n.result}): ${n.notes}${n.judgeErrors ? `\n  judge: ${n.judgeErrors.slice(0, 400)}` : ""}`)
    .join("\n");
  const checked = ctx.checkedLemmas.map((c) => `- Proofs.${c.leanName}: ${c.leanStatement}`).join("\n");
  return `Leased lemma ${ctx.lemmaId} (${ctx.title || "untitled"}), program ${ctx.program}. Lean name: ${ctx.leanName}.
This is attempt ${attemptNo} of ${ctx.maxAttemptsPerLemma} for you on this lemma.

Trusted statement file Statements/${ctx.leanName}.lean:
\`\`\`lean
${ctx.statementSource.trim()}
\`\`\`
${ctx.handoffNote ? `\nHandoff note from the previous agent${ctx.offeredToMe ? " (they offered this lemma to you)" : ""}:\n${ctx.handoffNote}\n` : ""}${prev ? `\nNotes from earlier failed attempts (any agent):\n${prev}\n` : ""}${ownNotes.length ? `\nYour own earlier attempts on this lemma:\n${ownNotes.map((n) => `- ${n}`).join("\n")}\n` : ""}${replies.length ? `\nAnswers from teammates to your question:\n${repliesText(replies)}\n` : ""}${checked ? `\nChecked lemmas you may import and reuse:\n${checked}\n` : ""}
Write the proof file, check it, and submit it.`;
}

export const REPLY_SYSTEM = `You are a member of The Hatchery, a swarm of agents proving Lean 4 lemmas. A teammate is stuck and asked you for help. Answer in at most ${MESSAGE_LIMITS.body} characters, with one concrete suggestion: a tactic, an exact lemma name, a checked lemma to reuse, or a way to split the goal. If you are not sure, say what you would try first.
Start your answer with "HINT: " if you suggest something to try, or "REPLY: " otherwise. The first sentence must work as an ${MESSAGE_LIMITS.short}-character speech-bubble summary.`;

export function replyPrompt(q: InboxQuestion): string {
  const mine = q.myCheckedProofs.map((p) => `--- ${p.lemmaId} (checked)\n${p.source.slice(0, 1500)}`).join("\n");
  return `${q.fromName} is working on ${q.lemmaId} (Lean name ${q.leanName}):
\`\`\`lean
${q.leanStatement}
\`\`\`
Their question:
${q.question}
${mine ? `\nProofs you got checked (for reference):\n${mine}\n` : ""}`;
}

/** Turn a reply model's text into a message (kind, body <= 500, short <= 80). */
export function parseReply(text: string): { kind: "reply" | "hint"; body: string; short: string } {
  const t = text.trim();
  const kind: "reply" | "hint" = /^HINT:/i.test(t) ? "hint" : "reply";
  const body = t.replace(/^(HINT|REPLY):\s*/i, "").slice(0, MESSAGE_LIMITS.body) || "(no suggestion)";
  const first = body.split(/(?<=[.!?])\s|\n/)[0] ?? body;
  const short = first.length <= MESSAGE_LIMITS.short ? first : `${first.slice(0, MESSAGE_LIMITS.short - 1)}…`;
  return { kind, body, short };
}

/** Handoff note composed from the agent's own record (no extra model call). */
export function handoffNote(ctx: LeaseContext, ownNotes: string[], lastErrors: string, bestPartial: string | null) {
  const approaches = ownNotes.map((n, i) => `${i + 1}. ${n}`).join("\n");
  const note = `Approaches tried by the previous agent:\n${approaches || "(none recorded)"}\n\nLast errors:\n${lastErrors.slice(0, 1500) || "(none)"}\n\nBest partial proof:\n${bestPartial ? bestPartial.slice(0, 3000) : "(none)"}`;
  const body = `Handing over ${ctx.lemmaId} after ${ownNotes.length} attempts. Tried: ${ownNotes.join(" | ")}`.slice(0, MESSAGE_LIMITS.body);
  const short = `Handing over ${ctx.lemmaId}`.slice(0, MESSAGE_LIMITS.short);
  return { body, short, note };
}
