/**
 * Fleet launcher: WORKER_COUNT processes, one agent loop each (AGENT_ID_PREFIX-1 .. -N).
 * A crashed agent is restarted with backoff; SIGTERM/SIGINT stop all of them gracefully.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const count = Number(process.env.WORKER_COUNT ?? "4");
const prefix = process.env.AGENT_ID_PREFIX ?? "agent";
if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error("WORKER_COUNT must be 1..200");
const main = fileURLToPath(new URL("./main.ts", import.meta.url));
const children = new Map<number, ChildProcess>();
let stopping = false;

function start(i: number, restarts = 0) {
  const child = spawn(process.execPath, ["--import", "tsx", main], {
    env: { ...process.env, AGENT_ID: `${prefix}-${i}` },
    stdio: "inherit",
  });
  children.set(i, child);
  child.on("exit", (code, signal) => {
    children.delete(i);
    if (stopping) return;
    if (code === 0) return; // finished normally (e.g. WORKER_EXIT_WHEN_IDLE=1)
    const delay = Math.min(300_000, 5_000 * 2 ** restarts);
    console.error(JSON.stringify({ t: new Date().toISOString(), msg: `agent ${prefix}-${i} exited (${code ?? signal}); restarting in ${delay / 1000}s` }));
    setTimeout(() => start(i, restarts + 1), delay);
  });
}

for (let i = 1; i <= count; i++) start(i);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    for (const c of children.values()) c.kill("SIGTERM");
  });
}
