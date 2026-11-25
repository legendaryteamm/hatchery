import { loadConfig } from "./config.ts";
import { connect, runMigrations } from "./db/client.ts";
import { HttpJudgeClient } from "./judge-client.ts";
import { LeanRepo } from "./lean-repo.ts";
import { buildServer } from "./server.ts";
import { Desk } from "./service.ts";

const config = loadConfig();
const { db } = connect(config.DATABASE_URL);
await runMigrations(db);
const desk = new Desk(db, new HttpJudgeClient(config.JUDGE_URL, config.JUDGE_API_TOKEN), new LeanRepo(config.LEAN_DIR), config);
const app = buildServer(desk);

const synced = await desk.syncStatements();
app.log.info(synced, "statements synced");

// Scheduler: expire leases every 30 s; re-check scan + re-checks on start and every RECHECK_INTERVAL_SECONDS.
setInterval(() => desk.expireLeases().catch((err) => app.log.error(err, "expireLeases")), 30_000);
const recheck = async () => {
  try {
    const marked = await desk.recheckScan();
    if (marked.length) app.log.warn({ marked }, "lemmas marked for re-check");
    const r = await desk.runRechecks();
    if (r.passed.length || r.failed.length) app.log.warn(r, "re-checks done");
  } catch (err) {
    app.log.error(err, "re-check");
  }
};
void recheck();
setInterval(recheck, config.RECHECK_INTERVAL_SECONDS * 1000);

await app.listen({ host: config.HOST, port: config.PORT });
