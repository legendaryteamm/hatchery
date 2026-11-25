import { MESSAGE_LIMITS, type JudgeVerdict } from "@hatchery/shared";
import { DeskHttpError, type DeskClient } from "./desk-client.ts";
import type { ToolDef } from "./provider.ts";

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: "lean_check",
    description: "Run the full Lean judge on a complete proof file (compile, kernel re-check, axiom check). Does not submit. Returns PASS or the errors.",
    inputSchema: obj({ source: { type: "string", description: "The complete Lean file." } }),
  },
  {
    name: "submit_proof",
    description: "Officially submit the final proof file to the judge. Ends this attempt whether it passes or not. Only call after lean_check passed.",
    inputSchema: obj({
      source: { type: "string", description: "The complete Lean file (same as the one that passed lean_check)." },
      notes: { type: "string", description: "One or two sentences for future agents: approach used, pitfalls." },
    }),
  },
  {
    name: "search_library",
    description: "Fixed-string search (not regex) in Lean's core library sources (Init, Std; plus Mathlib when available). Returns up to 60 matching lines with file:line. Example queries: 'theorem length_append', 'sum_append'.",
    inputSchema: obj({ query: { type: "string", description: "2-100 printable ASCII characters." } }),
  },
  {
    name: "search_checked",
    description: "Keyword search over lemmas the colony has already CHECKED. Reuse them with `import Proofs.<LeanName>` and `Proof.<LeanName>`.",
    inputSchema: obj({ query: { type: "string", description: "Keywords, e.g. 'length append'." } }),
  },
  {
    name: "read_file",
    description: "Read a trusted file: Defs/<...>.lean, Statements/<L>.lean, or Proofs/<L>.lean for a checked lemma.",
    inputSchema: obj({ path: { type: "string" } }),
  },
  {
    name: "ask_teammates",
    description: `Ask up to two teammates for help. Allowed once per lemma, only after 3 failed checks in a row. Say what you tried and exactly where it broke. Their answer appears in a later turn or your next attempt.`,
    inputSchema: obj({
      question: { type: "string", description: `What you tried and where it broke (max ${MESSAGE_LIMITS.body} characters).` },
      short: { type: "string", description: `A speech-bubble summary (max ${MESSAGE_LIMITS.short} characters).` },
    }),
  },
];

export function summarizeVerdict(v: JudgeVerdict): string {
  if (v.verdict === "pass") return `PASS (checkers: judgecheck=${v.checkers.judgecheck}, leanchecker=${v.checkers.leanchecker}; axioms: ${v.axioms.join(", ") || "none"})`;
  const reasons = v.reasons.map((r) => `- ${r.code}: ${r.message}`).join("\n");
  const log = v.compileLog.trim() ? `\nLean output:\n${v.compileLog.slice(0, 3000)}` : "";
  return `FAIL at stage ${v.stage}\n${reasons}${log}`;
}

export type ToolOutcome =
  | { kind: "result"; content: string; isError: boolean; checkedSource?: string; lastErrors?: string; asked?: boolean }
  | { kind: "submitted"; verdict: JudgeVerdict };

export async function runTool(desk: DeskClient, attemptId: number, name: string, input: unknown): Promise<ToolOutcome> {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  try {
    switch (name) {
      case "lean_check": {
        const v = await desk.check(attemptId, str("source"));
        const content = summarizeVerdict(v);
        return { kind: "result", content, isError: v.verdict !== "pass", checkedSource: str("source"), lastErrors: v.verdict === "pass" ? undefined : content };
      }
      case "submit_proof":
        return { kind: "submitted", verdict: await desk.submit(attemptId, str("source"), str("notes")) };
      case "search_library":
        return { kind: "result", content: await desk.search(str("query")), isError: false };
      case "search_checked": {
        const found = await desk.searchChecked(str("query"));
        return { kind: "result", content: found.length ? JSON.stringify(found, null, 1) : "(no checked lemma matches)", isError: false };
      }
      case "read_file":
        return { kind: "result", content: await desk.readFile(str("path")), isError: false };
      case "ask_teammates": {
        const q = await desk.ask(attemptId, str("question").slice(0, MESSAGE_LIMITS.body), (str("short") || str("question")).slice(0, MESSAGE_LIMITS.short));
        return {
          kind: "result",
          isError: false,
          asked: true,
          content: q.routedTo.length
            ? `Question sent to ${q.routedTo.length} teammate(s). Their answer will appear in a later turn or your next attempt. Keep working meanwhile.`
            : "No teammate is available right now. Keep working.",
        };
      }
      default:
        return { kind: "result", content: `unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    // 4xx from the desk is information for the model (bad import, bad path, limits); anything else is ours.
    if (err instanceof DeskHttpError && err.status >= 400 && err.status < 500 && err.status !== 409) {
      return { kind: "result", content: `error: ${err.message}`, isError: true };
    }
    if (err instanceof DeskHttpError && err.status === 503 && err.reason === "judge_unavailable" && name === "lean_check") {
      return { kind: "result", content: "The judge had an infrastructure error (not your proof). Run lean_check again.", isError: true };
    }
    throw err;
  }
}
