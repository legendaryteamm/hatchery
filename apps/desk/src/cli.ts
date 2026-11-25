/**
 * pnpm desk <command>
 *   migrate          apply DB migrations
 *   sync             sync lean/Statements into the DB, then run the re-check scan
 *   recheck          re-check scan + re-judge everything marked (needs the judge)
 *   export-proofs    write every checked proof to lean/Proofs/<L>.lean (pinned sources)
 *   report           print lemma statuses, attempts and spend
 *   pantry-mock-inflow <usd>   DEV ONLY: add a mock inflow (chain "mock") so agents have food
 *   kill-switch on|off         flip the shared kill switch
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { loadConfig } from "./config.ts";
import { connect, runMigrations } from "./db/client.ts";
import { randomUUID } from "node:crypto";
import { lemmas, pantryInflows } from "./db/schema.ts";
import { HttpJudgeClient } from "./judge-client.ts";
import { LeanRepo } from "./lean-repo.ts";
import { Desk } from "./service.ts";

const cmd = process.argv[2];
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
  } else if (cmd === "export-proofs") {
    const rows = await db.select().from(lemmas).where(eq(lemmas.status, "checked"));
    mkdirSync(join(config.LEAN_DIR, "Proofs"), { recursive: true });
    for (const l of rows) {
      const file = join(config.LEAN_DIR, "Proofs", `${l.id.replaceAll("-", "_")}.lean`);
      writeFileSync(file, l.checkedSource ?? "");
      console.log(`${l.id} -> ${file} (checked at ${l.checkedCommit})`);
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
    await db.insert(pantryInflows).values({
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
