/**
 * Build judge requests from a repo checkout (the CLI and CI use this; the desk sends the
 * approved versions from its database instead).
 *   lean/Statements/<L>.lean   approved statements
 *   lean/Proofs/<L>.lean       checked proofs (may import each other)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lemmaIdToLeanName, leanNameToLemmaId, type JudgeRequestInput } from "@hatchery/shared";

const PROOF_IMPORT_RE = /^[ \t]*import[ \t]+Proofs\.(L_[A-Za-z0-9_]+)\s*$/gm;

export function statementSource(leanDir: string, leanName: string): string {
  const p = join(leanDir, "Statements", `${leanName}.lean`);
  if (!existsSync(p)) throw new Error(`no statement file ${p}`);
  return readFileSync(p, "utf8");
}

/** The request for `source` as a proof of `lemmaId`, with every imported checked proof (recursively). */
export function requestFromRepo(leanDir: string, lemmaId: string, source: string): JudgeRequestInput {
  const order: string[] = [];
  const visit = (src: string, path: string[]) => {
    for (const m of src.matchAll(PROOF_IMPORT_RE)) {
      const dep = m[1]!;
      if (path.includes(dep)) throw new Error(`circular proof import: ${[...path, dep].join(" -> ")}`);
      if (order.includes(dep)) continue;
      const p = join(leanDir, "Proofs", `${dep}.lean`);
      if (!existsSync(p)) throw new Error(`import Proofs.${dep}: no file ${p}`);
      visit(readFileSync(p, "utf8"), [...path, dep]);
      order.push(dep);
    }
  };
  const self = lemmaIdToLeanName(lemmaId);
  visit(source, [self]);
  return {
    lemmaId,
    source,
    deps: order.map((d) => ({ lemmaId: leanNameToLemmaId(d), source: readFileSync(join(leanDir, "Proofs", `${d}.lean`), "utf8") })),
    statements: [self, ...order].map((n) => ({ lemmaId: leanNameToLemmaId(n), source: statementSource(leanDir, n) })),
  };
}

/** Every proof file in lean/Proofs (judge test fixtures excluded). */
export function repoProofs(leanDir: string): string[] {
  const dir = join(leanDir, "Proofs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^L(_[a-z0-9]+)+\.lean$/.test(f) && !f.startsWith("L_fixture_"))
    .map((f) => f.replace(/\.lean$/, ""))
    .sort();
}

export function needsMathlib(leanDir: string, leanName: string): boolean {
  return /^\s*import\s+(Mathlib|Defs\.Mathlib)/m.test(statementSource(leanDir, leanName));
}
