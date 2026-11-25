/** Starts the compose postgres (port 5433) once for all desk tests. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  // Tests must never commit to (or write into) the real checkout: snapshot it and compare after.
  const before = checkoutState();
  return () => {
    const after = checkoutState();
    if (after !== before) {
      throw new Error(`the test run changed the real checkout (HEAD or lean/):\nbefore: ${before}\nafter:  ${after}`);
    }
  };
}

/**
 * Everything a test could change in the real checkout: HEAD, the index and working tree (whole
 * repo, untracked files included), and the directory tree outside node_modules/.git (Git does not
 * see empty directories).
 */
export function checkoutState(root: string = fileURLToPath(new URL("../../..", import.meta.url))): string {
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  const dirs: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      if (!e.isDirectory() || ["node_modules", ".git", ".lake"].includes(e.name)) continue;
      dirs.push(join(d, e.name));
      if (depth < 4) walk(join(d, e.name), depth + 1);
    }
  };
  walk(".", 0);
  // Contents, not just names: an edit to a file that is already modified keeps the same status line.
  const diff = createHash("sha256").update(execFileSync("git", ["-C", root, "diff", "HEAD", "--binary"])).digest("hex");
  const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const u = createHash("sha256");
  for (const f of untracked) u.update(f).update("\0").update(readFileSync(join(root, f))).update("\0");
  return `HEAD=${git("rev-parse", "HEAD")}\nstatus=${git("status", "--porcelain", "--untracked-files=all")}\ndiff=${diff}\nuntracked=${u.digest("hex")}\ndirs=${dirs.sort().join(",")}`;
}
