import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { JudgeRequestInput, JudgeVerdict } from "@hatchery/shared";
import { loadConfig, type DeskConfig } from "../src/config.ts";
import { connect, runMigrations, type Db, type DbTimeouts } from "../src/db/client.ts";
import type { JudgeClient, JudgeInfo } from "../src/judge-client.ts";
import { LeanRepo } from "../src/lean-repo.ts";
import { Desk } from "../src/service.ts";
import { pantryInflows } from "../src/db/schema.ts";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://hatchery:hatchery-dev-only@127.0.0.1:5433/postgres";
export const REPO_LEAN_DIR = fileURLToPath(new URL("../../../lean", import.meta.url));
export const WORKER_TOKEN = "test-worker-token-0123456789";

/** A fresh, migrated database. Dropped by the returned cleanup. */
export async function freshDb(timeouts?: DbTimeouts): Promise<{ db: Db; url: string; cleanup: () => Promise<void> }> {
  const name = `hatchery_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = ADMIN.replace(/\/[^/]+$/, `/${name}`);
  const { db, close } = connect(url, timeouts);
  const cleanup = async () => {
    await close();
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
  try {
    await runMigrations(db);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { db, url, cleanup };
}

/** Drop test databases left behind by killed test runs. Test files run one at a time. */
export async function sweepTestDatabases(): Promise<string[]> {
  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  try {
    const rows = await admin<{ datname: string }[]>`select datname from pg_database where datname like 'hatchery\_test\_%'`;
    for (const r of rows) await admin.unsafe(`drop database if exists ${r.datname} with (force)`);
    return rows.map((r) => r.datname);
  } finally {
    await admin.end();
  }
}

/** Copy of lean/ in a temp dir, so tests can edit statements without touching the repo. */
export function tempLeanDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hatchery-lean-"));
  cpSync(REPO_LEAN_DIR, dir, { recursive: true, filter: (src) => !src.includes(".lake") });
  return dir;
}

export function testConfig(over: Partial<Record<string, string>> = {}): DeskConfig {
  // Tests never commit into the real checkout; committer tests use a temp git repo and opt in.
  return loadConfig({ DESK_WORKER_TOKEN: WORKER_TOKEN, GIT_COMMIT: "test-commit", PROOF_COMMIT_MODE: "off", ...over });
}

/** Judge stand-in: passes iff the source contains "-- PASS", records every request. */
export class FakeJudge implements JudgeClient {
  requests: JudgeRequestInput[] = [];
  constructor(public infoValue: JudgeInfo) {}
  async info() {
    return this.infoValue;
  }
  async search(q: string) {
    return `Init/Fake.lean:1:${q}`;
  }
  statementChecks: string[] = [];
  /** Stand-in: "BROKEN" in the prop = does not elaborate; "TRIVIAL" = closed by decide. */
  async statementCheck(req: { lemmaId: string; source: string }) {
    this.statementChecks.push(req.lemmaId);
    const imports = [...req.source.matchAll(/^import\s+(\S+)/gm)].map((m) => m[1]!);
    return {
      lemmaId: req.lemmaId,
      wellFormed: /def Statement\.L_[a-z0-9_]+ : Prop :=/.test(req.source),
      elaborates: !req.source.includes("BROKEN"),
      trivial: req.source.includes("TRIVIAL"),
      trivialBy: req.source.includes("TRIVIAL") ? "decide" : null,
      errors: req.source.includes("BROKEN") ? ["unknown identifier 'BROKEN'"] : [],
      defImports: imports.filter((m) => m.startsWith("Defs.")),
      requiresMathlib: imports.some((m) => m.startsWith("Mathlib") || m.startsWith("Defs.Mathlib")),
    };
  }
  async check(req: JudgeRequestInput): Promise<JudgeVerdict> {
    this.requests.push(req);
    const pass = req.source.includes("-- PASS");
    return {
      lemmaId: req.lemmaId,
      leanName: req.lemmaId.replaceAll("-", "_"),
      verdict: pass ? "pass" : "fail",
      stage: pass ? "done" : "compile",
      reasons: pass ? [] : [{ code: "compile_error", message: "fake failure" }],
      checkers: pass ? { judgecheck: "pass", leanchecker: "pass" } : { judgecheck: "not_run", leanchecker: "not_run" },
      deps: (req.deps ?? []).map((d) => d.lemmaId),
      axioms: [],
      compileLog: "",
      durationMs: 1,
      runnerImage: "fake",
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Mock pantry inflow (dev/test only). */
export async function addInflow(db: Db, usd: number, ts = new Date()): Promise<void> {
  await db.insert(pantryInflows).values({
    txHash: `test-${randomBytes(6).toString("hex")}`, chain: "mock", amountNative: String(usd), amountUsd: usd.toFixed(6),
    usdRateSource: "test", ts,
  });
}

export async function makeDesk(opts: { leanDir?: string; config?: Partial<Record<string, string>>; now?: () => Date; pantryUsd?: number } = {}) {
  const fresh = await freshDb();
  try {
    const repo = new LeanRepo(opts.leanDir ?? REPO_LEAN_DIR);
    const judge = new FakeJudge({ flavor: "lite", trustedSha: repo.trustedSha(), leanVersion: "4.36.0" });
    const desk = new Desk(fresh.db, judge, repo, testConfig(opts.config), opts.now);
    await desk.syncStatements();
    if (opts.pantryUsd !== 0) await addInflow(fresh.db, opts.pantryUsd ?? 100_000);
    return { desk, judge, repo, ...fresh };
  } catch (err) {
    await fresh.cleanup(); // never leak a database when setup fails
    throw err;
  }
}
