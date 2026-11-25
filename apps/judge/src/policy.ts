/**
 * Judge policy: what a submission may contain and what the trusted checker must report.
 *
 * Two layers:
 *  1. `staticChecks(source)` - cheap textual checks before any Lean runs. Deliberately strict
 *     (a banned word is rejected even inside a comment). Defence in depth only.
 *  2. `evaluateCheck(...)`   - decisions on the report produced by the trusted `judgecheck`
 *     tool after kernel replay. This is the layer the guarantee rests on.
 */
import { ALLOWED_AXIOMS, type JudgeReason } from "@hatchery/shared";

interface Banned {
  re: RegExp;
  why: string;
}

/** Identifier-ish boundary for Lean source (letters, digits, `_`, `'`, `!`, `?`, `.`). */
const word = (w: string) => new RegExp(`(?<![A-Za-z0-9_'!?.])${w}(?![A-Za-z0-9_'!?])`);

export const BANNED: Banned[] = [
  // From the spec (section 5).
  { re: /sorry/, why: "`sorry` (any occurrence, including sorryAx)" },
  { re: word("admit"), why: "`admit`" },
  { re: /native_decide/, why: "`native_decide`" },
  { re: word("axiom"), why: "`axiom` declarations" },
  { re: /unsafe/, why: "`unsafe` (any occurrence, including unsafeIO / unsafeBaseIO)" },
  { re: /implemented_by/, why: "`@[implemented_by]`" },
  { re: word("extern"), why: "`@[extern]`" },
  { re: /set_option\s+debug\./, why: "`set_option debug.*`" },
  // Changing the foundations or the module system.
  { re: word("prelude"), why: "`prelude` (replaces the core library)" },
  { re: /^\s*module\b/m, why: "`module` header (the module system is not supported by the judge)" },
  { re: word("partial"), why: "`partial def` (not replayable by the kernel)" },
  // Code that would run inside the judge at elaboration time.
  { re: /#eval/, why: "`#eval`" },
  { re: /\brun_(cmd|tac|elab|meta)\b/, why: "`run_cmd` / `run_tac` / `run_elab` / `run_meta`" },
  { re: word("by_elab"), why: "`by_elab`" },
  { re: /(?<![A-Za-z0-9_'!?.])elab(_rules)?(?![A-Za-z0-9_'!?])/, why: "`elab` / `elab_rules`" },
  { re: /(?<![A-Za-z0-9_'!?.])macro(_rules)?(?![A-Za-z0-9_'!?])/, why: "`macro` / `macro_rules`" },
  { re: /(?<![A-Za-z0-9_'!?.])syntax(?![A-Za-z0-9_'!?])|declare_syntax_cat/, why: "`syntax` declarations" },
  { re: /initialize/, why: "`initialize` / `builtin_initialize`" },
  { re: /simproc/, why: "`simproc` / `dsimproc`" },
  {
    re: /@\[[^\]]*\b(tactic|command_elab|term_elab|macro|init|builtin_init|env_linter|delab|app_unexpander|code_action|widget_module|server_rpc_method)\b/,
    why: "attributes that register code to run in the judge",
  },
  { re: /(?<![A-Za-z0-9_'!?])(IO|EIO|BaseIO|CoreM|MetaM|TermElabM|TacticM|CommandElabM|MacroM)(?![A-Za-z0-9_'!?])/, why: "meta-programming / IO monads" },
  { re: /\bLean\.(Elab|Meta|Parser|Compiler|IR)\b/, why: "Lean compiler internals" },
];

/** `set_option` names a proof may use. Everything else is rejected. */
export const ALLOWED_OPTIONS = new Set([
  "maxHeartbeats",
  "maxRecDepth",
  "synthInstance.maxHeartbeats",
  "synthInstance.maxSize",
  "autoImplicit",
  "relaxedAutoImplicit",
]);
const ALLOWED_OPTION_PREFIXES = ["linter."];

/**
 * Import allowlist: Mathlib, our trusted Defs / Statements, and `Proofs.<L>` only for checked
 * proofs supplied as dependencies (`allowedProofs`, Lean names).
 */
export function importAllowed(mod: string, allowedProofs: ReadonlySet<string> = new Set()): boolean {
  if (mod === "Init" || mod === "Mathlib") return true;
  const proof = /^Proofs\.(L_[A-Za-z0-9_]+)$/.exec(mod);
  if (proof) return allowedProofs.has(proof[1] ?? "");
  return /^(Mathlib|Defs|Statements)\.[A-Za-z0-9_.']+$/.test(mod) && !mod.includes("..");
}

/** Every `import` line in the file, split into module names. */
export function parseImports(source: string): string[] {
  const mods: string[] = [];
  for (const m of source.matchAll(/^[ \t]*import[ \t]+([^\n]*)/gm)) {
    const rest = (m[1] ?? "").replace(/--.*$/, "").trim();
    for (const tok of rest.split(/\s+/)) if (tok) mods.push(tok);
  }
  return mods;
}

/** Imports a statement file may use: Init, Mathlib, and the reviewed definitions. */
export function statementImportAllowed(mod: string): boolean {
  return mod === "Init" || mod === "Mathlib" || /^(Mathlib|Defs)\.[A-Za-z0-9_.']+$/.test(mod);
}

/**
 * A statement file holds imports, comments, optional `open` lines, and exactly one
 * `def Statement.<L> : Prop := ...`. Returns a list of problems (empty = fine).
 */
export function statementFileChecks(source: string, leanName: string): string[] {
  const problems: string[] = [];
  for (const b of BANNED) if (b.re.test(source)) problems.push(`forbidden: ${b.why}`);
  for (const m of source.matchAll(/set_option\s+([A-Za-z0-9_.]+)/g)) problems.push(`set_option ${m[1]} is not allowed in a statement`);
  for (const mod of parseImports(source)) if (!statementImportAllowed(mod)) problems.push(`import ${mod} is not allowed in a statement (Mathlib, Defs.* only)`);
  // Count declarations outside comments (banned words above are matched on the raw text, comments included).
  const code = source.replace(/\/-[\s\S]*?-\//g, " ").replace(/--.*$/gm, "");
  const defs = [...code.matchAll(/(?<![A-Za-z0-9_'.])(def|theorem|lemma|abbrev|instance|structure|inductive|class|opaque|example|noncomputable)(?![A-Za-z0-9_'])/g)];
  const own = new RegExp(`(^|\\n)\\s*def\\s+Statement\\.${leanName}\\s*:\\s*Prop\\s*:=`);
  if (!own.test(source)) problems.push(`must declare \`def Statement.${leanName} : Prop := ...\``);
  if (defs.length !== 1) problems.push(`must contain exactly one declaration (found ${defs.length})`);
  return problems;
}

export function staticChecks(source: string, leanName: string, allowedProofs: ReadonlySet<string> = new Set()): JudgeReason[] {
  const reasons: JudgeReason[] = [];
  for (const b of BANNED) {
    if (b.re.test(source)) reasons.push({ code: "forbidden_token", message: `forbidden: ${b.why}` });
  }
  for (const m of source.matchAll(/set_option\s+([A-Za-z0-9_.]+)/g)) {
    const opt = m[1] ?? "";
    if (!ALLOWED_OPTIONS.has(opt) && !ALLOWED_OPTION_PREFIXES.some((p) => opt.startsWith(p))) {
      reasons.push({ code: "set_option_not_allowed", message: `set_option ${opt} is not allowed` });
    }
  }
  for (const mod of parseImports(source)) {
    if (!importAllowed(mod, allowedProofs)) {
      reasons.push({
        code: "forbidden_import",
        message: mod.startsWith("Proofs.")
          ? `import ${mod} is not allowed: only checked proofs can be imported`
          : `import ${mod} is not allowed (Mathlib, Defs.*, Statements.*, checked Proofs.* only)`,
      });
    }
  }
  const decl = new RegExp(`(^|\\n)\\s*theorem\\s+Proof\\.${leanName}(?![A-Za-z0-9_'!?.])`);
  if (!decl.test(source)) {
    reasons.push({ code: "missing_theorem", message: `the file must declare \`theorem Proof.${leanName} : Statement.${leanName} := ...\`` });
  }
  return dedupe(reasons);
}

/** What the trusted `judgecheck` tool prints (see lean/Judge/Main.lean). */
export interface CheckReport {
  imports: string[];
  isModule: boolean;
  constants: string[];
  unsafeOrPartial: string[];
  replay: string;
  theoremFound: boolean;
  theoremKind: string;
  typeDefEq: string;
  axioms: string[];
  missing: string[];
  error: string;
}

/** Is `name` inside the submission's own namespace `Proof.<leanName>`? */
export function inOwnNamespace(name: string, leanName: string): boolean {
  const user = name.replace(/^_private\.Submission\.\d+\./, "");
  const root = `Proof.${leanName}`;
  return user === root || user.startsWith(`${root}.`);
}

export function evaluateCheck(
  report: CheckReport,
  typecheck: { ok: boolean; log: string },
  leanName: string,
  allowedProofs: ReadonlySet<string> = new Set(),
  leanchecker: { ok: boolean; log: string } = { ok: true, log: "" },
): JudgeReason[] {
  const r: JudgeReason[] = [];
  const thm = `Proof.${leanName}`;
  if (report.error) {
    r.push({ code: "runner_error", message: `checker error: ${report.error.slice(0, 500)}` });
    return r;
  }
  if (report.isModule) r.push({ code: "forbidden_token", message: "module-system files are not supported" });
  for (const mod of report.imports) {
    if (!importAllowed(mod, allowedProofs)) r.push({ code: "forbidden_import", message: `compiled file imports ${mod}` });
  }
  if (report.unsafeOrPartial.length) {
    r.push({ code: "unsafe_declaration", message: `unsafe/partial declarations: ${report.unsafeOrPartial.join(", ")}` });
  }
  const outside = report.constants.filter((c) => !inOwnNamespace(c, leanName));
  if (outside.length) {
    r.push({ code: "namespace_violation", message: `declarations outside namespace ${thm}: ${outside.slice(0, 10).join(", ")}` });
  }
  if (!leanchecker.ok) {
    r.push({ code: "second_checker_failed", message: `leanchecker rejected the module: ${leanchecker.log.slice(0, 1000)}` });
  }
  if (report.replay !== "ok") {
    const conflict = /already (been )?declared|already contains/i.test(report.replay);
    r.push({
      code: conflict ? "import_conflict" : "replay_failed",
      message: `kernel replay ${report.replay.slice(0, 500)}`,
    });
    return dedupe(r);
  }
  if (!report.theoremFound) {
    r.push({ code: "missing_theorem", message: `${thm} was not found after kernel replay` });
    return dedupe(r);
  }
  if (report.theoremKind !== "theorem") {
    r.push({ code: "not_a_theorem", message: `${thm} is a ${report.theoremKind}, not a theorem` });
  }
  if (report.typeDefEq !== "yes" || !typecheck.ok) {
    const conflict = /already (been )?declared|already contains|import failed/i.test(typecheck.log);
    r.push({
      code: conflict ? "import_conflict" : "statement_mismatch",
      message: conflict
        ? `the submission clashes with the trusted statement: ${typecheck.log.slice(0, 500)}`
        : `the type of ${thm} is not definitionally Statement.${leanName} (kernel: ${report.typeDefEq})${typecheck.log ? `\n${typecheck.log.slice(0, 1500)}` : ""}`,
    });
  }
  const extra = report.axioms.filter((a) => !(ALLOWED_AXIOMS as readonly string[]).includes(a));
  if (extra.length) {
    r.push({ code: "forbidden_axiom", message: `depends on axioms beyond ${ALLOWED_AXIOMS.join(", ")}: ${extra.join(", ")}` });
  }
  if (report.missing.length) {
    r.push({ code: "replay_failed", message: `unresolved constants: ${report.missing.slice(0, 10).join(", ")}` });
  }
  return dedupe(r);
}

function dedupe(reasons: JudgeReason[]): JudgeReason[] {
  const seen = new Set<string>();
  return reasons.filter((x) => {
    const k = `${x.code}|${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
