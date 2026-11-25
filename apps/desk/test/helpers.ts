import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { JudgeRequestInput, JudgeVerdict } from "@hatchery/shared";
import { loadConfig, type DeskConfig } from "../src/config.ts";
import { connect, runMigrations, type Db } from "../src/db/client.ts";
import type { JudgeClient, JudgeInfo } from "../src/judge-client.ts";
import { LeanRepo } from "../src/lean-repo.ts";
import { Desk } from "../src/service.ts";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://hatchery:hatchery-dev-only@127.0.0.1:5433/postgres";
export const REPO_LEAN_DIR = fileURLToPath(new URL("../../../lean", import.meta.url));
export const WORKER_TOKEN = "test-worker-token-0123456789";

/** A fresh, migrated database. Dropped by the returned cleanup. */
export async function freshDb(): Promise<{ db: Db; url: string; cleanup: () => Promise<void> }> {
  const name = `hatchery_test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = ADMIN.replace(/\/[^/]+$/, `/${name}`);
  const { db, close } = connect(url);
  await runMigrations(db);
  return {
    db,
    url,
    cleanup: async () => {
      await close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/** Copy of lean/ in a temp dir, so tests can edit statements without touching the repo. */
export function tempLeanDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hatchery-lean-"));
  cpSync(REPO_LEAN_DIR, dir, { recursive: true, filter: (src) => !src.includes(".lake") });
  return dir;
}

export function testConfig(over: Partial<Record<string, string>> = {}): DeskConfig {
  return loadConfig({ DESK_WORKER_TOKEN: WORKER_TOKEN, GIT_COMMIT: "test-commit", ...over });
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

export async function makeDesk(opts: { leanDir?: string; config?: Partial<Record<string, string>>; now?: () => Date } = {}) {
  const fresh = await freshDb();
  const repo = new LeanRepo(opts.leanDir ?? REPO_LEAN_DIR);
  const judge = new FakeJudge({ flavor: "lite", trustedSha: repo.trustedSha(), leanVersion: "4.36.0" });
  const desk = new Desk(fresh.db, judge, repo, testConfig(opts.config), opts.now);
  await desk.syncStatements();
  return { desk, judge, repo, ...fresh };
}
