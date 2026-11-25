/**
 * Writes every accepted proof to lean/Proofs/<L>.lean and commits it (only that path) with a
 * bot identity. Removes the file again when a re-check fails. Never pushes.
 *
 * The DB is the source of truth; `reconcile()` (run at desk start) repairs the files after a
 * crash between the DB update and the commit.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CommitterOptions {
  mode: "commit" | "write" | "off";
  authorName: string;
  authorEmail: string;
}

export class ProofCommitter {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private leanDir: string, readonly opts: CommitterOptions) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await run(
      "git",
      ["-C", this.leanDir, "-c", `user.name=${this.opts.authorName}`, "-c", `user.email=${this.opts.authorEmail}`, ...args],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  }

  private path(leanName: string): string {
    if (!/^L(_[a-z0-9]+)+$/.test(leanName)) throw new Error(`invalid lean name ${leanName}`);
    return join(this.leanDir, "Proofs", `${leanName}.lean`);
  }

  /** Commit only `file` (other staged or unstaged work in the checkout is left alone). Returns the new HEAD, or null if nothing changed. */
  private async commitPath(file: string, message: string, removed: boolean): Promise<string | null> {
    const rel = relative(this.leanDir, file);
    if (removed) {
      const tracked = await this.git(["ls-files", "--", rel]);
      if (!tracked) return null;
      await this.git(["rm", "--cached", "--quiet", "--", rel]);
    } else {
      await this.git(["add", "--", rel]);
    }
    const changed = await this.git(["diff", "--cached", "--name-only", "--", rel]);
    if (!changed) return null;
    await this.git(["commit", "--quiet", "--only", "-m", message, "--", rel]);
    return this.git(["rev-parse", "HEAD"]);
  }

  /** Write (and commit) an accepted proof. Returns the commit sha in "commit" mode. */
  publish(leanName: string, source: string, message: string): Promise<string | null> {
    if (this.opts.mode === "off") return Promise.resolve(null);
    return this.serial(async () => {
      const file = this.path(leanName);
      mkdirSync(join(this.leanDir, "Proofs"), { recursive: true });
      writeFileSync(file, source);
      return this.opts.mode === "commit" ? this.commitPath(file, message, false) : null;
    });
  }

  /** Remove (and commit the removal of) a proof that is no longer checked. */
  withdraw(leanName: string, message: string): Promise<string | null> {
    if (this.opts.mode === "off") return Promise.resolve(null);
    return this.serial(async () => {
      const file = this.path(leanName);
      if (existsSync(file)) rmSync(file);
      return this.opts.mode === "commit" ? this.commitPath(file, message, true) : null;
    });
  }

  /** Make lean/Proofs match the DB: checked lemmas present with their pinned source, others absent. */
  async reconcile(checked: Map<string, string>): Promise<{ written: string[]; removed: string[] }> {
    const written: string[] = [];
    const removed: string[] = [];
    if (this.opts.mode === "off") return { written, removed };
    const dir = join(this.leanDir, "Proofs");
    const present = existsSync(dir) ? readdirSync(dir).filter((f) => /^L(_[a-z0-9]+)+\.lean$/.test(f) && !f.startsWith("L_fixture_")) : [];
    for (const [leanName, source] of checked) {
      const file = this.path(leanName);
      if (!existsSync(file) || readFileSync(file, "utf8") !== source) {
        await this.publish(leanName, source, `proof: ${leanName} (reconciled with the desk database)`);
        written.push(leanName);
      }
    }
    for (const f of present) {
      const leanName = f.replace(/\.lean$/, "");
      if (!checked.has(leanName)) {
        await this.withdraw(leanName, `proof: remove ${leanName} (not checked in the desk database)`);
        removed.push(leanName);
      }
    }
    return { written, removed };
  }
}
