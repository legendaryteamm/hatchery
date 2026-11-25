import { loadConfig } from "./config.ts";
import { connect, runMigrations } from "./db/client.ts";
import { HttpJudgeClient } from "./judge-client.ts";
import { LeanRepo } from "./lean-repo.ts";
import { Review } from "./review.ts";
import { PantryAlerts } from "./pantry.ts";
import { buildServer } from "./server.ts";
import { Desk } from "./service.ts";

const config = loadConfig();
const { db } = connect(config.DATABASE_URL);
await runMigrations(db);
const desk = new Desk(db, new HttpJudgeClient(config.JUDGE_URL, config.JUDGE_API_TOKEN), new LeanRepo(config.LEAN_DIR), config);
const review = new Review(desk, desk.judge);
const app = buildServer(desk, review);
app.log.info({ proofCommits: config.PROOF_COMMIT_MODE, target: await desk.committer.targetLeanDir(), realRun: config.HATCHERY_REAL_RUN, push: config.PROOF_PUSH }, "where accepted proofs go");

const synced = await desk.syncStatements();
app.log.info(synced, "statements synced");
const reconciled = await desk.reconcileProofs();
if (reconciled.written.length || reconciled.removed.length) app.log.warn(reconciled, "lean/Proofs reconciled with the database");

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
// Automatic checks of proposed statements (well-formed, elaborates with sorry, not trivial).
const checks = () => review.runPendingChecks().then((d) => d.length && app.log.info({ checked: d }, "statement checks")).catch((err) => app.log.error(err, "statement checks"));
void checks();
setInterval(checks, 60_000);

// Pantry alerts (log + feed event + optional webhook) when food runs low, and when it recovers.
const alerts = new PantryAlerts(desk, app.log);
const alertCheck = () => alerts.check().catch((err) => app.log.error(err, "pantry alerts"));
void alertCheck();
setInterval(alertCheck, config.PANTRY_ALERT_CHECK_SECONDS * 1000);

await app.listen({ host: config.HOST, port: config.PORT });
