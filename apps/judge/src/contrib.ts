/**
 * Contributor pull requests (BUILD_PROMPT.md section 10), the logic behind two workflows:
 *
 *   contrib-check.yml  (pull_request: untrusted PR, no secrets, read-only token)
 *     files  - the PR must add exactly one new file lean/Proofs/L_*.lean and change nothing else
 *     check  - judge that file with the SAME runner image as the colony, using the BASE commit's
 *              judge code and statements (the PR's own code never runs), and write result.json
 *   contrib-merge.yml  (workflow_run: trusted, default branch, secrets)
 *     report - treat result.json as data; re-check everything that matters against the GitHub API
 *              (head commit, file list, proof content), ask the desk to judge it again, comment,
 *              and merge with the proof bot only if everything passed and auto-merge is on
 *
 * The GitHub API base comes from GITHUB_API_URL, so the whole flow runs locally against a stand-in.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { leanNameToLemmaId, type JudgeVerdict } from "@hatchery/shared";

export const PROOF_PATH_RE = /^lean\/Proofs\/(L(?:_[a-z0-9]+)+)\.lean$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface PrFile {
  filename: string;
  status: string; // added | modified | removed | renamed | ...
}

export type FilesCheck = { ok: true; path: string; leanName: string; lemmaId: string } | { ok: false; reason: string };

/** Exactly one new proof file, and nothing else. */
export function validatePrFiles(files: PrFile[]): FilesCheck {
  if (files.length !== 1) {
    return { ok: false, reason: `the pull request must add exactly one file (lean/Proofs/<lemma>.lean); it changes ${files.length}: ${files.slice(0, 10).map((f) => f.filename).join(", ")}` };
  }
  const f = files[0]!;
  const m = PROOF_PATH_RE.exec(f.filename);
  if (!m || m[1]!.startsWith("L_fixture_")) return { ok: false, reason: `only a new file lean/Proofs/L_<program>_<n>.lean is accepted, not ${f.filename}` };
  if (f.status !== "added") return { ok: false, reason: `${f.filename} must be a new file (status: ${f.status}); checked proofs are never replaced by pull request` };
  return { ok: true, path: f.filename, leanName: m[1]!, lemmaId: leanNameToLemmaId(m[1]!) };
}

export const ResultSchema = z.object({
  version: z.literal(1),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.union([z.object({ ok: z.literal(true), path: z.string(), leanName: z.string(), lemmaId: z.string() }), z.object({ ok: z.literal(false), reason: z.string().max(2000) })]),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  verdict: z
    .object({
      verdict: z.enum(["pass", "fail"]),
      reasons: z.array(z.object({ code: z.string().max(100), message: z.string().max(4000) })).max(50),
      runnerImage: z.string().max(300),
      axioms: z.array(z.string().max(200)).max(50),
    })
    .nullable(),
});
export type CheckResult = z.infer<typeof ResultSchema>;

export function resultFrom(prNumber: number, headSha: string, files: FilesCheck, source: string | null, verdict: JudgeVerdict | null): CheckResult {
  return {
    version: 1,
    prNumber,
    headSha,
    files,
    sourceSha256: source === null ? null : sha256(source),
    verdict: verdict && {
      verdict: verdict.verdict,
      reasons: verdict.reasons.slice(0, 50).map((r) => ({ code: r.code.slice(0, 100), message: r.message.slice(0, 4000) })),
      runnerImage: verdict.runnerImage.slice(0, 300),
      axioms: verdict.axioms.slice(0, 50),
    },
  };
}

// ------------------------------------------------------------------ the trusted report

export interface DeskAnswer {
  result: "pass" | "fail" | "refused";
  reason: string;
}

export interface Outcome {
  ciPass: boolean;
  desk: DeskAnswer | null;
  merge: boolean;
  /** Why it was not merged (or "merged"). */
  why: string;
}

export function decide(i: { files: FilesCheck; ciPass: boolean; desk: DeskAnswer | null; deskConfigured: boolean; autoMerge: boolean; botToken: boolean }): Outcome {
  const base = { ciPass: i.ciPass, desk: i.desk };
  if (!i.files.ok) return { ...base, merge: false, why: i.files.reason };
  if (!i.ciPass) return { ...base, merge: false, why: "the Lean judge did not accept the proof" };
  if (!i.deskConfigured) return { ...base, merge: false, why: "the desk is not connected to this repository yet (DESK_URL), so the proof cannot be recorded; a maintainer will merge by hand" };
  if (!i.desk || i.desk.result !== "pass") return { ...base, merge: false, why: i.desk ? `the desk did not accept it: ${i.desk.reason}` : "the desk did not answer" };
  if (!i.autoMerge) return { ...base, merge: false, why: "auto-merge is off (CONTRIB_AUTO_MERGE); a maintainer will merge" };
  if (!i.botToken) return { ...base, merge: false, why: "the proof bot has no token (PROOF_BOT_TOKEN); a maintainer will merge" };
  return { ...base, merge: true, why: "merged" };
}

/** Text from the judge contains PR content: show it only inside a code block it cannot close. */
export function codeBlock(s: string, max = 3000): string {
  const t = s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
  return `\`\`\`text\n${t.replaceAll("```", "ʼʼʼ")}\n\`\`\``;
}

export function commentBody(r: { login: string; files: FilesCheck; result: CheckResult | null; outcome: Outcome; siteUrl: string | null }): string {
  const lines = ["### Lean judge"];
  const L = r.files.ok ? `\`${r.files.lemmaId}\`` : "this pull request";
  if (!r.files.ok) lines.push("", `Not checked: ${r.files.reason}`);
  else if (!r.result?.verdict) lines.push("", `The judge did not run on ${L} (CI error). A maintainer will look at the workflow logs.`);
  else if (r.result.verdict.verdict === "pass") lines.push("", `✅ ${L}: the proof passed the Lean judge (\`${r.result.verdict.runnerImage}\`). Axioms: ${r.result.verdict.axioms.join(", ") || "none"}.`);
  else {
    lines.push("", `❌ ${L}: the Lean judge rejected the proof.`, "");
    lines.push(codeBlock(r.result.verdict.reasons.map((x) => `${x.code}: ${x.message}`).join("\n")));
    lines.push("", "Push a fix to this pull request to try again.");
  }
  if (r.outcome.desk) lines.push("", `Desk (second check with the colony's own judge): **${r.outcome.desk.result}**${r.outcome.desk.result === "pass" ? "" : ` (${r.outcome.desk.reason.split("\n")[0]!.slice(0, 300)})`}`);
  lines.push("", r.outcome.merge ? `Merged by the proof bot. Thank you, @${r.login}.` : `Not merged: ${r.outcome.why}.`);
  if (r.siteUrl) lines.push("", `Rules for contributors: ${r.siteUrl.replace(/\/$/, "")}/join.txt`);
  lines.push("", "<sub>Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.</sub>");
  return lines.join("\n");
}

// ------------------------------------------------------------------ GitHub API

export class GitHub {
  constructor(
    private api: string,
    private repo: string,
    private fetchFn: typeof fetch = fetch,
  ) {}
  private async call<T>(path: string, token: string | undefined, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
    const r = await this.fetchFn(`${this.api}${path}`, {
      ...init,
      headers: {
        accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "user-agent": "hatchery-contrib-ci",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (init.raw ? await r.text() : await r.json()) as T;
  }
  pr(n: number, token?: string) {
    return this.call<{ number: number; state: string; user: { login: string }; head: { sha: string; repo: { full_name: string } | null }; base: { ref: string; repo: { default_branch: string } } }>(`/repos/${this.repo}/pulls/${n}`, token);
  }
  async files(n: number, token?: string): Promise<PrFile[]> {
    const out: PrFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.call<PrFile[]>(`/repos/${this.repo}/pulls/${n}/files?per_page=100&page=${page}`, token);
      out.push(...batch.map((f) => ({ filename: f.filename, status: f.status })));
      if (batch.length < 100) break;
    }
    return out;
  }
  content(fullName: string, path: string, ref: string, token?: string) {
    return this.call<string>(`/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`, token, { raw: true });
  }
  comment(n: number, body: string, token: string) {
    return this.call<{ id: number }>(`/repos/${this.repo}/issues/${n}/comments`, token, { method: "POST", body: JSON.stringify({ body }) });
  }
  merge(n: number, sha: string, title: string, token: string) {
    return this.call<{ sha: string; merged: boolean }>(`/repos/${this.repo}/pulls/${n}/merge`, token, { method: "PUT", body: JSON.stringify({ sha, merge_method: "squash", commit_title: title }) });
  }
}

export interface ReportEnv {
  github: GitHub;
  /** workflow_run.head_sha: the commit the check ran on (trusted, from GitHub). */
  headSha: string;
  /** workflow_run.conclusion */
  checkConclusion: string;
  githubToken: string;
  botToken?: string;
  autoMerge: boolean;
  deskUrl?: string;
  deskToken?: string;
  siteUrl?: string;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

/** The trusted half: nothing from the artifact is believed without checking it against GitHub. */
export async function report(rawResult: unknown, env: ReportEnv): Promise<{ outcome: Outcome; commented: boolean; mergedCommit: string | null }> {
  const log = env.log ?? console.log;
  const parsed = ResultSchema.safeParse(rawResult);
  if (!parsed.success) throw new Error("the check result is missing or malformed; nothing to report");
  const result = parsed.data;
  if (result.headSha !== env.headSha) throw new Error(`the check result is for ${result.headSha}, but the workflow ran on ${env.headSha}`);
  const pr = await env.github.pr(result.prNumber, env.githubToken);
  if (pr.head.sha !== env.headSha) throw new Error(`pull request #${pr.number} has moved on to ${pr.head.sha}; its new check will report`);
  if (pr.state !== "open") throw new Error(`pull request #${pr.number} is ${pr.state}`);
  if (pr.base.ref !== pr.base.repo.default_branch) throw new Error(`pull request #${pr.number} targets ${pr.base.ref}, not ${pr.base.repo.default_branch}`);

  // Re-derive the facts from GitHub itself (the artifact is data from an untrusted run).
  const files = validatePrFiles(await env.github.files(pr.number, env.githubToken));
  let source: string | null = null;
  if (files.ok) {
    source = await env.github.content(pr.head.repo?.full_name ?? "", files.path, env.headSha, env.githubToken);
    if (result.sourceSha256 !== sha256(source)) throw new Error("the checked file is not the file in the pull request");
  }
  const ciPass = env.checkConclusion === "success" && files.ok && result.files.ok && result.verdict?.verdict === "pass";

  let desk: DeskAnswer | null = null;
  const deskConfigured = Boolean(env.deskUrl && env.deskToken);
  if (ciPass && files.ok && source !== null && deskConfigured) {
    const r = await (env.fetchFn ?? fetch)(`${env.deskUrl!.replace(/\/$/, "")}/contrib/submissions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.deskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ login: pr.user.login, prNumber: pr.number, headSha: env.headSha, lemmaId: files.lemmaId, source }),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!r.ok) throw new Error(`desk answered ${r.status}: ${(await r.text()).slice(0, 300)} (re-run this workflow to retry)`);
    desk = (await r.json()) as DeskAnswer;
  }
  const outcome = decide({ files, ciPass, desk, deskConfigured, autoMerge: env.autoMerge, botToken: Boolean(env.botToken) });

  let mergedCommit: string | null = null;
  if (outcome.merge && files.ok) {
    try {
      const m = await env.github.merge(pr.number, env.headSha, `proof: ${files.leanName} (#${pr.number}, @${pr.user.login})`, env.botToken!);
      mergedCommit = m.sha;
      await (env.fetchFn ?? fetch)(`${env.deskUrl!.replace(/\/$/, "")}/contrib/merged`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.deskToken}`, "content-type": "application/json" },
        body: JSON.stringify({ prNumber: pr.number, headSha: env.headSha, commit: m.sha }),
        signal: AbortSignal.timeout(60_000),
      }).then((r) => r.ok || log(`desk /contrib/merged answered ${r.status}`));
    } catch (err) {
      outcome.merge = false;
      outcome.why = `the merge failed (${(err as Error).message.slice(0, 200)}); a maintainer will look`;
    }
  }
  await env.github.comment(pr.number, commentBody({ login: pr.user.login, files, result, outcome, siteUrl: env.siteUrl ?? null }), env.githubToken);
  log(`PR #${pr.number}: ci=${ciPass ? "pass" : "fail"} desk=${desk?.result ?? "-"} ${outcome.merge ? "merged" : `not merged: ${outcome.why}`}`);
  return { outcome, commented: true, mergedCommit };
}

// ------------------------------------------------------------------ public review flags (GitHub issues)

export const FLAG_TARGET_RE = /^(Defs(?:\.[A-Za-z0-9_]+)+|L(?:-[a-z0-9]+)+)$/;

/**
 * Read the review-flag issue form (.github/ISSUE_TEMPLATE/review-flag.yml): the first section is
 * the target (a definition module like Defs.Core.Circuit, or a statement id like L-circ-014), the
 * second the reason. The body is untrusted text: only the id is parsed out; the reason is passed on
 * as data, cut to 4000 characters.
 */
export function parseFlagIssue(body: string): { targetId: string; reason: string } | { error: string } {
  const sections = body.split(/^###\s+/m).slice(1).map((s) => s.split("\n").slice(1).join("\n").trim());
  const first = (sections[0] ?? "").split(/\s+/)[0]?.replace(/[`*]/g, "") ?? "";
  if (!FLAG_TARGET_RE.test(first)) return { error: "the first field must be a definition module (e.g. Defs.Core.Circuit) or a statement id (e.g. L-circ-014)" };
  return { targetId: first, reason: (sections[1] ?? "").slice(0, 4000) };
}

export interface FlagEnv {
  github: GitHub;
  githubToken: string;
  deskUrl?: string;
  deskToken?: string;
  siteUrl?: string;
  fetchFn?: typeof fetch;
}

/** The review-flag workflow: send the flag to the desk and answer on the issue. */
export async function flagFromIssue(event: { issue?: { number: number; body?: string | null; user?: { login?: string }; labels?: { name: string }[] } }, env: FlagEnv): Promise<{ result: string; message: string }> {
  const issue = event.issue;
  if (!issue?.user?.login) throw new Error("not an issue event");
  if (!issue.labels?.some((l) => l.name === "review-flag")) return { result: "ignored", message: "not a review flag" };
  const parsed = parseFlagIssue(issue.body ?? "");
  let answer: { result: string; message: string };
  if ("error" in parsed) {
    answer = { result: "refused", message: parsed.error };
  } else if (!env.deskUrl || !env.deskToken) {
    answer = { result: "refused", message: "the desk is not connected to this repository yet (DESK_URL); a maintainer will look at this issue" };
  } else {
    const r = await (env.fetchFn ?? fetch)(`${env.deskUrl.replace(/\/$/, "")}/contrib/flags`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.deskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ issueNumber: issue.number, login: issue.user.login, targetId: parsed.targetId, reason: parsed.reason }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`desk answered ${r.status}: ${(await r.text()).slice(0, 300)} (re-run this workflow to retry)`);
    answer = (await r.json()) as { result: string; message: string };
  }
  const page = !("error" in parsed) && env.siteUrl ? `\n\nEvery review step, with the reviewers' reasoning: ${env.siteUrl.replace(/\/$/, "")}/${parsed.targetId.startsWith("Defs.") ? `definitions/${parsed.targetId}` : `lemmas/${parsed.targetId}`}` : "";
  const text =
    answer.result === "accepted" || answer.result === "attached"
      ? `Thank you. ${answer.message}. AI reviewer agents will look at it again, with your text as input (never as instructions).${page}`
      : `Not sent to review: ${answer.message}.`;
  await env.github.comment(issue.number, `${text}\n\n<sub>Definitions and statements here are reviewed by AI agents, not by a human mathematician.</sub>`, env.githubToken);
  return answer;
}
