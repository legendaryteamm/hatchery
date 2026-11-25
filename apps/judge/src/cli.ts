/**
 * Judge CLI (same pipeline as the HTTP service).
 *   cli check <lemma-id> <proof.lean>     judge one file; statement and checked deps come from lean/
 *   cli check-repo                        re-judge every proof in lean/Proofs (CI); skips proofs that
 *                                         need Mathlib when the runner image is lite (the full job checks them)
 *   cli check-statements                  every statement in lean/Statements elaborates and (except the
 *                                         core warm-up, easy on purpose) is not trivial (CI); skips Mathlib
 *                                         statements on the lite image (the full job checks them)
 * Exit code 0 = pass, 1 = fail, 2 = usage / runner problem.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { leanNameToLemmaId } from "@hatchery/shared";
import { loadConfig } from "./config.ts";
import { runnerInfo } from "./info.ts";
import { judge } from "./judge.ts";
import { readdirSync } from "node:fs";
import { needsMathlib, repoProofs, requestFromRepo } from "./repo.ts";
import { statementCheck } from "./statement-check.ts";

const leanDir = process.env.LEAN_DIR ?? fileURLToPath(new URL("../../../lean", import.meta.url));
const [cmd, lemmaId, file] = process.argv.slice(2);
try {
  if (cmd === "check" && lemmaId && file) {
    const verdict = await judge(requestFromRepo(leanDir, lemmaId, await readFile(file, "utf8")), loadConfig());
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(verdict.verdict === "pass" ? 0 : 1);
  } else if (cmd === "check-repo") {
    const config = loadConfig();
    const flavor = (await runnerInfo(config.image)).flavor;
    let failed = 0;
    let checked = 0;
    for (const name of repoProofs(leanDir)) {
      if (needsMathlib(leanDir, name) && flavor !== "full") {
        console.log(`skip ${name}: needs Mathlib (checked by the full-image job)`);
        continue;
      }
      const id = leanNameToLemmaId(name);
      const v = await judge(requestFromRepo(leanDir, id, await readFile(`${leanDir}/Proofs/${name}.lean`, "utf8")), config);
      checked++;
      console.log(`${v.verdict === "pass" ? "PASS" : "FAIL"} ${id}${v.verdict === "pass" ? "" : `: ${v.reasons.map((r) => `${r.code}: ${r.message}`).join(" | ").slice(0, 600)}`}`);
      if (v.verdict !== "pass") failed++;
    }
    console.log(`${checked} proof(s) checked, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } else if (cmd === "check-statements") {
    const config = loadConfig();
    const flavor = (await runnerInfo(config.image)).flavor;
    let failed = 0;
    for (const f of readdirSync(`${leanDir}/Statements`).filter((x) => /^L(_[a-z0-9]+)+\.lean$/.test(x) && !x.startsWith("L_fixture_")).sort()) {
      const name = f.replace(/\.lean$/, "");
      if (needsMathlib(leanDir, name) && flavor !== "full") {
        console.log(`skip ${name}: needs Mathlib (checked by the full-image job)`);
        continue;
      }
      const source = await readFile(`${leanDir}/Statements/${f}`, "utf8");
      const r = await statementCheck({ lemmaId: leanNameToLemmaId(name), source }, config, { flavor });
      // Warm-up lemmas are easy on purpose (they calibrate the pipeline); every other statement must not be trivial.
      const warmup = /^--\s*program:\s*core-warmup\s*$/m.test(source);
      const ok = r.wellFormed && r.elaborates && (warmup || !r.trivial);
      console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : `: ${r.trivial ? `trivial (${r.trivialBy})` : r.errors.slice(0, 2).join(" | ")}`}`);
      if (!ok) failed++;
    }
    process.exit(failed ? 1 : 0);
  } else {
    console.error("usage: cli check <lemma-id> <proof-file.lean> | cli check-repo | cli check-statements");
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}
