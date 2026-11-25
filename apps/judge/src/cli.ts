/**
 * Judge CLI (same pipeline as the HTTP service; used by the GitHub Action in Phase 6).
 *   pnpm judge:check <lemma-id> <path/to/Proof.lean>
 * Prints the verdict as JSON. Exit code 0 = pass, 1 = fail, 2 = usage / runner problem.
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { judge } from "./judge.ts";

const [cmd, lemmaId, file] = process.argv.slice(2);
if (cmd !== "check" || !lemmaId || !file) {
  console.error("usage: cli check <lemma-id> <proof-file.lean>");
  process.exit(2);
}
try {
  const source = await readFile(file, "utf8");
  const verdict = await judge({ lemmaId, source }, loadConfig());
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.verdict === "pass" ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}
