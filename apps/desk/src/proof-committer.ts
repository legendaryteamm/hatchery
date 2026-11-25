/**
 * Writes every accepted proof to lean/Proofs/<L>.lean and commits it (only that path) with a bot
 * identity. Removes it again when a re-check fails.
 *
 * WHERE (docs/deploy.md, "Where bot commits go"):
 *   sandbox  (default)  a throwaway clone made on first use; the real checkout is never touched
 *   commit / write      the real checkout; config refuses these unless HATCHERY_REAL_RUN=1
 *   off                 database only
 * Pushing happens only with PROOF_PUSH=1 (server real runs), and only touches lean/Proofs/.
 *
 * A proof is committed only once its approved statement file is in the target checkout with the
 * same content as in the database, because CI re-checks every pushed proof against that file.
 * Statements reach the repo through a maintainer (`desk export-statements`), never the bot.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CommitMode = "sandbox" | "commit" | "write" | "off";

export interface CommitterOptions {
  mode: CommitMode;
  authorName: string;
  authorEmail: string;
  /** sandbox mode: where to put the clone (default: new temp dir). */
  sandboxDir?: string;
  push?: { remote: string; branch: string };
}

/** The repository this code lives in (the developer's real checkout when running from source). */
export const OWN_REPO_ROOT = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));

export type PublishResult = { commit: string | null; deferred: boolean; pushed: boolean };

export class ProofCommitter {
  private chain: Promise<unknown> = Promise.resolve();
  private target: string | null = null; // the lean/ dir commits go to

  constructor(private sourceLeanDir: string, readonly opts: CommitterOptions) {
    // Tests may never commit or write into this repository's real checkout.
    if (process.env.VITEST && (opts.mode === "commit" || opts.mode === "write")) {
      const real = realpathSync(sourceLeanDir);
      if (real === OWN_REPO_ROOT || real.startsWith(`${OWN_REPO_ROOT}/`)) {
        throw new Error(`refusing PROOF_COMMIT_MODE=${opts.mode} on the real checkout during tests (${real})`);
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run(
      "git",
      ["-C", cwd, "-c", `user.name=${this.opts.authorName}`, "-c", `user.email=${this.opts.authorEmail}`, ...args],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  }

  /** The lean/ directory commits go to (creating the sandbox clone on first use). */
  async targetLeanDir(): Promise<string | null> {
    if (this.opts.mode === "off") return null;
    if (this.target) return this.target;
    if (this.opts.mode !== "sandbox") return (this.target = this.sourceLeanDir);
    let root: string;
    let rel = "lean";
    try {
      root = await this.git(this.sourceLeanDir, ["rev-parse", "--show-toplevel"]);
      rel = relative(root, realpathSync(this.sourceLeanDir)) || ".";
    } catch {
      root = "";
    }
    // The sandbox must be outside the checkout it clones (and outside this repository).
    // Checked BEFORE anything is created, using the nearest existing parent of the path.
    if (this.opts.sandboxDir) {
      const wanted = resolve(this.opts.sandboxDir);
      let probe = wanted;
      while (!existsSync(probe)) probe = dirname(probe);
      const realWanted = join(realpathSync(probe), relative(probe, wanted));
      for (const forbidden of [root, OWN_REPO_ROOT].filter(Boolean)) {
        const f = realpathSync(forbidden);
        if (realWanted === f || realWanted.startsWith(`${f}/`)) throw new Error(`PROOF_SANDBOX_DIR ${wanted} is inside the checkout ${f}; choose a directory outside it`);
      }
    }
    const dir = this.opts.sandboxDir ?? mkdtempSync(join(tmpdir(), "hatchery-proof-sandbox-"));
    mkdirSync(dir, { recursive: true });
    if (root && !existsSync(join(dir, ".git"))) {
      await run("git", ["clone", "--quiet", "--no-hardlinks", root, dir]);
    } else if (!existsSync(join(dir, ".git"))) {
      await run("git", ["init", "--quiet", dir]);
    }
    this.target = join(dir, rel);
    mkdirSync(this.target, { recursive: true });
    return this.target;
  }

  private path(leanDir: string, folder: "Proofs" | "Statements", leanName: string): string {
    if (!/^L(_[a-z0-9]+)+$/.test(leanName)) throw new Error(`invalid lean name ${leanName}`);
    return join(leanDir, folder, `${leanName}.lean`);
  }

  /** Commit only `file` (other staged or unstaged work in the checkout is left alone). Returns the new HEAD, or null if nothing changed. */
  private async commitPath(leanDir: string, file: string, message: string, removed: boolean): Promise<string | null> {
    const rel = relative(leanDir, file);
    if (removed) {
      const tracked = await this.git(leanDir, ["ls-files", "--", rel]);
      if (!tracked) return null;
      await this.git(leanDir, ["rm", "--cached", "--quiet", "--", rel]);
    } else {
      await this.git(leanDir, ["add", "--", rel]);
    }
    const changed = await this.git(leanDir, ["diff", "--cached", "--name-only", "--", rel]);
    if (!changed) return null;
    await this.git(leanDir, ["commit", "--quiet", "--only", "-m", message, "--", rel]);
    return this.git(leanDir, ["rev-parse", "HEAD"]);
  }

  private async push(leanDir: string): Promise<boolean> {
    if (!this.opts.push) return false;
    try {
      await this.git(leanDir, ["push", "--quiet", this.opts.push.remote, `HEAD:${this.opts.push.branch}`]);
      return true;
    } catch (err) {
      console.error(`push failed (will retry at the next commit or restart): ${(err as Error).message}`);
      return false;
    }
  }

  /** Is the approved statement in the target checkout, with exactly this content? */
  private statementPresent(leanDir: string, leanName: string, statementSource: string): boolean {
    const f = this.path(leanDir, "Statements", leanName);
    return existsSync(f) && readFileSync(f, "utf8") === statementSource;
  }

  /** Write (and commit, and push on a server) an accepted proof. */
  publish(leanName: string, source: string, statementSource: string, message: string): Promise<PublishResult> {
    if (this.opts.mode === "off") return Promise.resolve({ commit: null, deferred: false, pushed: false });
    return this.serial(async () => {
      const dir = (await this.targetLeanDir())!;
      if (!this.statementPresent(dir, leanName, statementSource)) return { commit: null, deferred: true, pushed: false };
      const file = this.path(dir, "Proofs", leanName);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
      if (this.opts.mode === "write") return { commit: null, deferred: false, pushed: false };
      const commit = await this.commitPath(dir, file, message, false);
      return { commit, deferred: false, pushed: commit ? await this.push(dir) : false };
    });
  }

  /** Remove (and commit the removal of) a proof that is no longer checked. */
  withdraw(leanName: string, message: string): Promise<string | null> {
    if (this.opts.mode === "off") return Promise.resolve(null);
    return this.serial(async () => {
      const dir = (await this.targetLeanDir())!;
      const file = this.path(dir, "Proofs", leanName);
      if (existsSync(file)) rmSync(file);
      if (this.opts.mode === "write") return null;
      const commit = await this.commitPath(dir, file, message, true);
      if (commit) await this.push(dir);
      return commit;
    });
  }

  /**
   * Make lean/Proofs match the DB: checked lemmas present with their pinned source; lemmas the DB
   * knows and says are NOT checked (e.g. a failed re-check) absent. Files the DB knows nothing about
   * are left alone, so a fresh or restored database can never wipe the committed proofs.
   */
  async reconcile(
    checked: Map<string, { source: string; statement: string }>,
    knownNotChecked: ReadonlySet<string>,
  ): Promise<{ written: string[]; removed: string[]; deferred: string[] }> {
    const written: string[] = [];
    const removed: string[] = [];
    const deferred: string[] = [];
    if (this.opts.mode === "off") return { written, removed, deferred };
    const dir = (await this.targetLeanDir())!;
    const proofsDir = join(dir, "Proofs");
    const present = existsSync(proofsDir) ? readdirSync(proofsDir).filter((f) => /^L(_[a-z0-9]+)+\.lean$/.test(f) && !f.startsWith("L_fixture_")) : [];
    for (const [leanName, { source, statement }] of checked) {
      const file = this.path(dir, "Proofs", leanName);
      if (!existsSync(file) || readFileSync(file, "utf8") !== source) {
        const r = await this.publish(leanName, source, statement, `proof: ${leanName} (reconciled with the desk database)`);
        (r.deferred ? deferred : written).push(leanName);
      }
    }
    for (const f of present) {
      const leanName = f.replace(/\.lean$/, "");
      if (!checked.has(leanName) && knownNotChecked.has(leanName)) {
        await this.withdraw(leanName, `proof: remove ${leanName} (not checked in the desk database)`);
        removed.push(leanName);
      }
    }
    if (this.opts.mode === "commit") await this.serial(() => this.push(dir)); // retry pushes that failed earlier
    return { written, removed, deferred };
  }
}
