import { z } from "zod";
import { LemmaIdSchema } from "./lemma-id.ts";

/** Max size of a submitted proof file. */
export const MAX_PROOF_BYTES = 200_000;

/** Max number of checked proofs a submission may import (transitively). */
export const MAX_PROOF_DEPS = 64;

/**
 * An already-checked proof the submission imports as `Proofs.<L>`. The caller (the desk) is
 * trusted to send only lemmas with status "checked", with the exact source pinned when they were
 * checked, in dependency order (a dep appears after everything it imports).
 */
export const ProofDepSchema = z.object({
  lemmaId: LemmaIdSchema,
  source: z.string().min(1).max(MAX_PROOF_BYTES),
});
export type ProofDep = z.infer<typeof ProofDepSchema>;

export const JudgeRequestSchema = z.object({
  lemmaId: LemmaIdSchema,
  source: z.string().min(1).max(MAX_PROOF_BYTES),
  deps: z.array(ProofDepSchema).max(MAX_PROOF_DEPS).default([]),
});
export type JudgeRequestInput = z.input<typeof JudgeRequestSchema>;
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;

/** Why a submission was rejected. Every rejection carries at least one reason. */
export const RejectCodeSchema = z.enum([
  "too_large",
  "forbidden_token",
  "forbidden_import",
  "set_option_not_allowed",
  "missing_theorem",
  "compile_error",
  "timeout",
  "memory_limit",
  "output_too_large",
  "import_conflict",
  "statement_mismatch",
  "not_a_theorem",
  "forbidden_axiom",
  "unsafe_declaration",
  "namespace_violation",
  "replay_failed",
  "second_checker_failed",
  "dependency_error",
  "runner_error",
]);
export type RejectCode = z.infer<typeof RejectCodeSchema>;

export const JudgeReasonSchema = z.object({ code: RejectCodeSchema, message: z.string() });
export type JudgeReason = z.infer<typeof JudgeReasonSchema>;

export const JudgeStageSchema = z.enum(["static", "compile", "check", "done"]);

export const JudgeVerdictSchema = z.object({
  lemmaId: z.string(),
  leanName: z.string(),
  verdict: z.enum(["pass", "fail"]),
  /** The stage that produced the verdict ("done" when every stage ran). */
  stage: JudgeStageSchema,
  reasons: z.array(JudgeReasonSchema),
  /** Axioms the proof depends on, collected by the trusted checker (empty if not reached). */
  axioms: z.array(z.string()),
  /**
   * Result of each independent checker. A verdict is "pass" only if every checker passed.
   * judgecheck = our kernel replay + defeq + axiom walk; leanchecker = Lean's built-in lean4checker.
   */
  checkers: z.object({
    judgecheck: z.enum(["pass", "fail", "not_run"]),
    leanchecker: z.enum(["pass", "fail", "not_run"]),
  }),
  /** Lemma ids of the checked proofs that were supplied as dependencies. */
  deps: z.array(z.string()),
  /** Lean messages from compiling the submission (truncated). */
  compileLog: z.string(),
  durationMs: z.number().int().nonnegative(),
  runnerImage: z.string(),
  checkedAt: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/** The only axioms a checked proof may use. */
export const ALLOWED_AXIOMS = ["propext", "Classical.choice", "Quot.sound"] as const;
