/**
 * Contributor CI commands (see src/contrib.ts and .github/workflows/contrib-*.yml).
 *
 *   contrib files  --pr N --out files.json          (untrusted run) which files does the PR change?
 *                                                    writes ok / path / lemma_id / needs_mathlib to $GITHUB_OUTPUT
 *   contrib check  --pr N --head SHA --files files.json --proof proof.lean --out result.json
 *                                                    (untrusted run) judge the proof with the runner image
 *   contrib report --result result.json              (trusted run) verify, ask the desk, comment, merge
 *
 * Env: GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN; check: JUDGE_IMAGE (+ judge limits);
 *      report: HEAD_SHA, CHECK_CONCLUSION, PROOF_BOT_TOKEN, AUTO_MERGE, DESK_URL, DESK_CONTRIB_TOKEN, SITE_URL
 * Exit: 0 = done (a failing proof is a normal outcome), 2 = could not do the job.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { GitHub, report, resultFrom, validatePrFiles, type FilesCheck } from "../src/contrib.ts";
import { judge } from "../src/judge.ts";
import { needsMathlib, requestFromRepo } from "../src/repo.ts";

const leanDir = process.env.LEAN_DIR ?? fileURLToPath(new URL("../../../lean", import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  const v = i >= 0 ? rest[i + 1] : undefined;
  if (!v) throw new Error(`missing --${name}`);
  return v;
};
const write = (file: string, data: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
};
const output = (pairs: Record<string, string>) => {
  for (const [k, v] of Object.entries(pairs)) {
    console.log(`${k}=${v}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v.replace(/[\r\n]/g, " ")}\n`);
  }
};
const github = () => new GitHub(process.env.GITHUB_API_URL ?? "https://api.github.com", process.env.GITHUB_REPOSITORY ?? "", fetch);

try {
  if (cmd === "files") {
    const files = validatePrFiles(await github().files(Number(arg("pr")), process.env.GITHUB_TOKEN));
    write(arg("out"), files);
    const statementThere = files.ok && existsSync(`${leanDir}/Statements/${files.leanName}.lean`);
    output({
      ok: String(files.ok && statementThere),
      path: files.ok ? files.path : "",
      lemma_id: files.ok ? files.lemmaId : "",
      needs_mathlib: String(files.ok && statementThere && needsMathlib(leanDir, files.leanName)),
      reason: files.ok ? (statementThere ? "" : `no approved statement ${files.leanName} in the repository`) : files.reason,
    });
  } else if (cmd === "check") {
    const pr = Number(arg("pr"));
    const head = arg("head");
    let files = JSON.parse(readFileSync(arg("files"), "utf8")) as FilesCheck;
    let source: string | null = null;
    let verdict = null;
    if (files.ok && !existsSync(`${leanDir}/Statements/${files.leanName}.lean`)) files = { ok: false, reason: `no approved statement ${files.leanName} in the repository` };
    if (files.ok) {
      source = readFileSync(arg("proof"), "utf8");
      verdict = await judge(requestFromRepo(leanDir, files.lemmaId, source), loadConfig());
      if (verdict.verdict === "fail" && verdict.reasons.length && verdict.reasons.every((r) => r.code === "runner_error")) {
        throw new Error(`runner error, not a verdict: ${verdict.reasons[0]!.message.slice(0, 500)}`);
      }
      console.log(`${verdict.verdict.toUpperCase()} ${files.lemmaId}${verdict.verdict === "pass" ? "" : `: ${verdict.reasons.map((r) => r.code).join(", ")}`}`);
    } else {
      console.log(`not checked: ${files.reason}`);
    }
    write(arg("out"), resultFrom(pr, head, files, source, verdict));
  } else if (cmd === "report") {
    const file = arg("result");
    if (!existsSync(file)) throw new Error(`no check result at ${file}`);
    const env = process.env;
    await report(JSON.parse(readFileSync(file, "utf8")), {
      github: github(),
      headSha: env.HEAD_SHA ?? "",
      checkConclusion: env.CHECK_CONCLUSION ?? "",
      githubToken: env.GITHUB_TOKEN ?? "",
      botToken: env.PROOF_BOT_TOKEN || undefined,
      autoMerge: env.AUTO_MERGE === "true",
      deskUrl: env.DESK_URL || undefined,
      deskToken: env.DESK_CONTRIB_TOKEN || undefined,
      siteUrl: env.SITE_URL || undefined,
    });
  } else {
    console.error("usage: contrib files|check|report ... (see the header of apps/judge/scripts/contrib.ts)");
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
}
