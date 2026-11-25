/**
 * pnpm desk <command>
 *   migrate          apply DB migrations
 *   sync             sync lean/Statements into the DB, then run the re-check scan
 *   recheck          re-check scan + re-judge everything marked (needs the judge)
 *   export-proofs    write every checked proof to lean/Proofs/<L>.lean (pinned sources)
 *   report           print lemma statuses, attempts and spend
 *   pantry-mock-inflow <usd>   DEV ONLY: add a mock inflow (chain "mock") so agents have food
 *   kill-switch on|off         flip the shared kill switch
 *   reviewer add "<name>" advisor|maintainer    create a reviewer; prints a one-time invite link
 *   reviewer invite <id>       new invite link (old one stops working)
 *   reviewer list | reviewer disable <id>
 *   export-statements --to <dir>   write approved statement files (a maintainer commits them)
 *   export-proofs --to <dir>       write checked proof files
 * Exports into this checkout need HATCHERY_REAL_RUN=1 (dev runs never write to the real checkout).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "./config.ts";
import { connect, runMigrations } from "./db/client.ts";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { lemmas, reviewers, statements } from "./db/schema.ts";
import { OWN_REPO_ROOT } from "./proof-committer.ts";
import { Review } from "./review.ts";
import { HttpJudgeClient } from "./judge-client.ts";
import { LeanRepo } from "./lean-repo.ts";
import { Desk } from "./service.ts";

const cmd = process.argv[2];

/** `--to <dir>`; refuses this checkout unless HATCHERY_REAL_RUN=1. */
function exportDir(): string {
  const i = process.argv.indexOf("--to");
  const to = i > 0 ? process.argv[i + 1] : undefined;
  if (!to) throw new Error("usage: desk export-proofs|export-statements --to <dir>  (the lean/ directory to write into)");
  const abs = resolve(to);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {}
  if ((real === OWN_REPO_ROOT || real.startsWith(`${OWN_REPO_ROOT}/`)) && process.env.HATCHERY_REAL_RUN !== "1") {
    throw new Error(`${abs} is inside this checkout: set HATCHERY_REAL_RUN=1 to confirm you want to write there`);
  }
  return abs;
}
const config = loadConfig({ DESK_WORKER_TOKEN: "cli-does-not-serve-requests", ...process.env });
const { db, close } = connect(config.DATABASE_URL);
const desk = new Desk(db, new HttpJudgeClient(config.JUDGE_URL, config.JUDGE_API_TOKEN), new LeanRepo(config.LEAN_DIR), config);
try {
  if (cmd === "migrate") {
    await runMigrations(db);
    console.log("migrations applied");
  } else if (cmd === "sync") {
    await runMigrations(db);
    console.log(await desk.syncStatements());
    console.log({ markedForRecheck: await desk.recheckScan() });
  } else if (cmd === "recheck") {
    console.log({ marked: await desk.recheckScan() });
    console.log(await desk.runRechecks());
  } else if (cmd === "export-proofs" || cmd === "export-statements") {
    const dir = exportDir();
    const folder = cmd === "export-proofs" ? "Proofs" : "Statements";
    mkdirSync(join(dir, folder), { recursive: true });
    const rows =
      cmd === "export-proofs"
        ? (await db.select().from(lemmas).where(eq(lemmas.status, "checked"))).map((l) => ({ id: l.id, content: l.checkedSource ?? "" }))
        : (await db.select().from(statements).where(eq(statements.status, "approved"))).map((s) => ({ id: s.id, content: s.source }));
    for (const r of rows) {
      const file = join(dir, folder, `${r.id.replaceAll("-", "_")}.lean`);
      writeFileSync(file, r.content);
      console.log(`${r.id} -> ${file}`);
    }
  } else if (cmd === "reviewer") {
    const review = new Review(desk, desk.judge);
    const [sub, a, b] = process.argv.slice(3);
    if (sub === "add" && a && (b === "advisor" || b === "maintainer")) {
      const r = await review.addReviewer(a, b);
      console.log(`reviewer #${r.reviewer.id} ${r.reviewer.name} (${r.reviewer.role})\nOne-time invite link (send it privately; valid ${config.REVIEW_INVITE_DAYS} days):\n${r.inviteUrl}`);
    } else if (sub === "invite" && a) {
      console.log(await review.newInvite(Number(a)));
    } else if (sub === "disable" && a) {
      await review.disableReviewer(Number(a));
      console.log(`reviewer #${a} disabled; sessions ended`);
    } else if (sub === "list") {
      console.table((await db.select().from(reviewers)).map((r) => ({ id: r.id, name: r.name, role: r.role, disabled: !!r.disabledAt, inviteUsed: !!r.inviteUsedAt })));
    } else {
      throw new Error('usage: desk reviewer add "<name>" advisor|maintainer | invite <id> | disable <id> | list');
    }
  } else if (cmd === "report") {
    const r = await db.execute(sql`
      select l.id, l.status, l.checked_by_agent,
        (select count(*) from attempts a where a.lemma_id = l.id)::int as attempts,
        (select coalesce(sum(cost_usd),0)::numeric(14,6)::text from attempts a where a.lemma_id = l.id) as cost_usd
      from lemmas l order by l.id`);
    console.table(r);
    const [t] = await db.execute(sql`select count(*)::int as calls, coalesce(sum(cost_usd),0)::numeric(14,6)::text as total_usd from model_calls`);
    console.log("model calls:", t);
    const ev = await db.execute(sql`select type, count(*)::int as n from events group by type order by type`);
    console.table(ev);
  } else if (cmd === "pantry-mock-inflow") {
    const usd = Number(process.argv[3]);
    if (!(usd > 0)) throw new Error("usage: desk pantry-mock-inflow <usd>");
    await desk.recordInflow({
      txHash: `mock-${randomUUID()}`, chain: "mock", amountNative: String(usd), amountUsd: usd.toFixed(6),
      usdRateSource: "mock adapter (1 native = 1 USD); development only", ts: new Date(),
    });
    console.log(await desk.budget(null));
  } else if (cmd === "kill-switch") {
    const on = process.argv[3];
    if (on !== "on" && on !== "off") throw new Error("usage: desk kill-switch on|off");
    await desk.setKillSwitch(on === "on", `cli:${process.env.USER ?? "unknown"}`);
    console.log((await desk.budget(null)).killSwitch);
  } else {
    console.error("usage: desk migrate | sync | recheck | export-proofs | report | pantry-mock-inflow <usd> | kill-switch on|off");
    process.exitCode = 2;
  }
} finally {
  await close();
}
