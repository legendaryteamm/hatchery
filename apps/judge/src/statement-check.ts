/**
 * Checks a PROPOSED statement before it reaches the human review queue (section 7):
 *   1. static rules (imports, banned words, exactly one `def Statement.<L> : Prop`);
 *   2. it elaborates in Lean with `sorry` as the proof;
 *   3. it is not trivial: auto-reject if `trivial`, `decide`, `simp`, `omega` (and `aesop` in the
 *      full image) closes it within STATEMENT_TRIVIAL_SECONDS (default 10 s).
 * The proposal is untrusted (model-written), so both Lean runs use the same sandbox as proofs.
 */
import { lemmaIdToLeanName, StatementCheckRequestSchema, type StatementCheckResult } from "@hatchery/shared";
import type { JudgeConfig } from "./config.ts";
import { dockerRunner, type ContainerRunner } from "./docker.ts";
import { parseImports, statementFileChecks } from "./policy.ts";
import { tar } from "./tar.ts";

export const TRIVIAL_TACTICS = ["trivial", "decide", "simp", "omega"] as const;

/** Split a file into its leading import lines and the rest. */
function splitHeader(source: string): { imports: string[]; body: string } {
  const lines = source.split("\n");
  const imports: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith("import ")) imports.push(lines[i]!);
    else if (l === "" || l.startsWith("--")) continue;
    else break;
  }
  return { imports, body: lines.filter((l) => !imports.includes(l)).join("\n") };
}

export async function statementCheck(
  input: unknown,
  config: JudgeConfig,
  opts: { runner?: ContainerRunner; flavor: "full" | "lite" | "unknown"; trivialSeconds?: number },
): Promise<StatementCheckResult> {
  const req = StatementCheckRequestSchema.parse(input);
  const leanName = lemmaIdToLeanName(req.lemmaId);
  const run = opts.runner ?? dockerRunner;
  const imports = parseImports(req.source);
  const defImports = imports.filter((m) => m.startsWith("Defs."));
  const requiresMathlib = imports.some((m) => m === "Mathlib" || m.startsWith("Mathlib.") || m.startsWith("Defs.Mathlib."));
  const base: StatementCheckResult = {
    lemmaId: req.lemmaId, wellFormed: false, elaborates: false, trivial: false, trivialBy: null, errors: [], defImports, requiresMathlib,
  };
  const problems = statementFileChecks(req.source, leanName);
  if (problems.length) return { ...base, errors: problems };
  if (requiresMathlib && opts.flavor !== "full") {
    return { ...base, wellFormed: true, errors: ["needs Mathlib, but the judge runs the lite image: it can only be checked by the full image"] };
  }

  const compile = async (src: string, timeoutSeconds: number) =>
    run(config.image, ["compile"], tar([{ name: "Submission.lean", data: src }]), {
      timeoutMs: timeoutSeconds * 1000, memoryMb: config.memoryMb, cpus: config.cpus, maxStdoutBytes: 64 * 1024 * 1024,
    });

  // 2. Elaborates, with `sorry` as the proof (the sorry is ours, appended after the static checks).
  const elab = await compile(`${req.source.trimEnd()}\n\ntheorem Hatchery.statementCheck : Statement.${leanName} := sorry\n`, config.timeoutSeconds);
  if (elab.timedOut || elab.exitCode !== 0) {
    const errs = elab.timedOut ? ["elaboration timed out"] : elab.stderr.split("\n").filter((l) => /: error/.test(l)).slice(0, 10);
    return { ...base, wellFormed: true, errors: errs.length ? errs : [elab.stderr.slice(0, 1000) || `exit ${elab.exitCode}`] };
  }

  // 3. Triviality probe: each tactic on its own, so we can say which one closed it.
  const tactics = [...TRIVIAL_TACTICS, ...(opts.flavor === "full" ? (["aesop"] as const) : [])];
  const { imports: header, body } = splitHeader(req.source);
  for (const t of tactics) {
    const extra = t === "aesop" ? ["import Aesop"] : [];
    const probe = [...header, ...extra, body.trimEnd(), "", `set_option maxHeartbeats 400000 in`,
      `theorem Hatchery.trivialityProbe : Statement.${leanName} := by`, `  unfold Statement.${leanName}`, `  ${t === "simp" ? "simp; done" : t}`, ""].join("\n");
    const r = await compile(probe, opts.trivialSeconds ?? 10);
    if (!r.timedOut && r.exitCode === 0 && !/declaration uses `sorry`/.test(r.stderr)) {
      return { ...base, wellFormed: true, elaborates: true, trivial: true, trivialBy: t };
    }
  }
  return { ...base, wellFormed: true, elaborates: true };
}
