/** Starts the compose postgres (port 5433) once for all desk tests. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function setup() {
  if (!process.env.TEST_DATABASE_ADMIN_URL) {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    // Right after a host wake (or a paused container) the health check reports "unhealthy" until its
    // next probe; retry for up to 60 s instead of failing on the first unhealthy status.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        execFileSync("docker", ["compose", "up", "-d", "--wait", "--wait-timeout", "30", "postgres"], { cwd: root, stdio: "pipe" });
        break;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`could not start postgres with docker compose: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  const { sweepTestDatabases } = await import("./helpers.ts");
  const dropped = await sweepTestDatabases();
  if (dropped.length) console.warn(`dropped ${dropped.length} test database(s) left behind by an earlier run`);
}
