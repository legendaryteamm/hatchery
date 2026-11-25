/** Starts the compose postgres (port 5433) once for all desk tests. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup() {
  if (process.env.TEST_DATABASE_ADMIN_URL) return;
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  try {
    execFileSync("docker", ["compose", "up", "-d", "--wait", "postgres"], { cwd: root, stdio: "pipe" });
  } catch (err) {
    throw new Error(`could not start postgres with docker compose: ${(err as Error).message}`);
  }
}
