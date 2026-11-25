/**
 * The judge pipeline:
 *   static checks -> container 1 `compile` (untrusted) -> container 2 `check` (trusted) -> policy.
 * Nothing counts as checked unless every stage passes.
 */
import { JudgeRequestSchema, lemmaIdToLeanName, type JudgeReason, type JudgeVerdict } from "@hatchery/shared";
import type { JudgeConfig } from "./config.ts";
import { dockerRunner, type ContainerRunner, type SandboxLimits } from "./docker.ts";
import { evaluateCheck, staticChecks, type CheckReport } from "./policy.ts";

const MAX_OLEAN_BYTES = 256 * 1024 * 1024;
const MAX_LOG = 20_000;

export interface JudgeOptions {
  runner?: ContainerRunner;
  /** TEST ONLY: skip the textual checks to prove the Lean-level checks catch the same thing. */
  skipStaticChecks?: boolean;
}

export async function judge(input: unknown, config: JudgeConfig, opts: JudgeOptions = {}): Promise<JudgeVerdict> {
  const started = Date.now();
  const req = JudgeRequestSchema.parse(input);
  const leanName = lemmaIdToLeanName(req.lemmaId);
  const run = opts.runner ?? dockerRunner;
  const limits: SandboxLimits = {
    timeoutMs: config.timeoutSeconds * 1000,
    memoryMb: config.memoryMb,
    cpus: config.cpus,
    maxStdoutBytes: MAX_OLEAN_BYTES,
  };
  const done = (
    stage: JudgeVerdict["stage"],
    reasons: JudgeReason[],
    extra: { axioms?: string[]; compileLog?: string } = {},
  ): JudgeVerdict => ({
    lemmaId: req.lemmaId,
    leanName,
    verdict: reasons.length === 0 ? "pass" : "fail",
    stage,
    reasons,
    axioms: extra.axioms ?? [],
    compileLog: (extra.compileLog ?? "").slice(0, MAX_LOG),
    durationMs: Date.now() - started,
    runnerImage: config.image,
    checkedAt: new Date().toISOString(),
  });

  // 1. Static checks.
  if (!opts.skipStaticChecks) {
    const reasons = staticChecks(req.source, leanName);
    if (reasons.length) return done("static", reasons);
  }

  // 2. Compile the untrusted source in a fresh sandbox.
  const c = await run(config.image, ["compile"], req.source, limits);
  const compileLog = c.stderr;
  if (c.timedOut) return done("compile", [{ code: "timeout", message: `compilation exceeded ${config.timeoutSeconds}s` }], { compileLog });
  if (c.oomKilled || c.exitCode === 137) {
    return done("compile", [{ code: "memory_limit", message: `compilation exceeded ${config.memoryMb} MB` }], { compileLog });
  }
  if (c.stdoutOverflow) return done("compile", [{ code: "output_too_large", message: "compiled output too large" }], { compileLog });
  if (c.exitCode === 1) return done("compile", [{ code: "compile_error", message: firstErrors(compileLog) }], { compileLog });
  if (c.exitCode !== 0 || c.stdout.length === 0) {
    return done("compile", [{ code: "runner_error", message: `compile container exited with ${c.exitCode}` }], { compileLog });
  }

  // 3. Check the compiled olean in a second, fresh sandbox (kernel replay, type, axioms).
  const k = await run(config.image, ["check", leanName], c.stdout, { ...limits, maxStdoutBytes: 4 * 1024 * 1024 });
  if (k.timedOut) return done("check", [{ code: "timeout", message: `checking exceeded ${config.timeoutSeconds}s` }], { compileLog });
  if (k.oomKilled || k.exitCode === 137) {
    return done("check", [{ code: "memory_limit", message: `checking exceeded ${config.memoryMb} MB` }], { compileLog });
  }
  const parsed = parseCheckOutput(k.stdout.toString("utf8"));
  if (k.exitCode !== 0 || !parsed) {
    return done("check", [{ code: "runner_error", message: `check container exited with ${k.exitCode}: ${k.stderr.slice(0, 500)}` }], { compileLog });
  }
  const reasons = evaluateCheck(parsed.report, parsed.typecheck, leanName);
  return done("done", reasons, { axioms: parsed.report.axioms, compileLog });
}

export function parseCheckOutput(out: string): { report: CheckReport; typecheck: { ok: boolean; log: string } } | null {
  let report: CheckReport | null = null;
  let tc: boolean | null = null;
  const log: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("HATCHERY_REPORT ")) {
      try {
        report = JSON.parse(line.slice("HATCHERY_REPORT ".length)) as CheckReport;
      } catch {
        return null;
      }
    } else if (line === "HATCHERY_TYPECHECK ok") tc = true;
    else if (line === "HATCHERY_TYPECHECK fail") tc = false;
    else if (line.startsWith("HATCHERY_TYPECHECK_LOG ")) log.push(line.slice("HATCHERY_TYPECHECK_LOG ".length));
  }
  if (!report || tc === null) return null;
  return { report, typecheck: { ok: tc, log: log.join("\n") } };
}

function firstErrors(log: string): string {
  const errs = log.split("\n").filter((l) => /: error/.test(l));
  return (errs.length ? errs.slice(0, 5).join("\n") : log.slice(0, 1000)) || "compilation failed";
}
