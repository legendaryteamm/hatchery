/**
 * Reads the trusted Lean files of the repo checkout (lean/): statements, definitions and the
 * toolchain pins, and computes the hashes the desk relies on.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LEAN_NAME_RE, leanNameToLemmaId } from "@hatchery/shared";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export interface StatementFile {
  id: string;
  leanName: string;
  program: string;
  title: string;
  dependsOn: string[];
  leanStatement: string;
  requiresMathlib: boolean;
  fileSha256: string;
  source: string;
}

export class LeanRepo {
  constructor(readonly dir: string) {}

  read(rel: string): string {
    return readFileSync(join(this.dir, rel), "utf8");
  }

  /**
   * Same algorithm as the runner Dockerfile:
   *   find lean-toolchain Defs Statements (*.lean | lean-toolchain) | LC_ALL=C sort | xargs sha256sum | sha256sum
   */
  trustedSha(): string {
    const files = [join(this.dir, "lean-toolchain"), ...walk(join(this.dir, "Defs")), ...walk(join(this.dir, "Statements"))]
      .map((p) => relative(this.dir, p))
      .filter((p) => p === "lean-toolchain" || p.endsWith(".lean"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(files.map((p) => `${sha256(readFileSync(join(this.dir, p)))}  ${p}\n`).join(""));
  }

  /** Toolchain and dependency pins. A change here invalidates every checked proof. */
  envHash(): string {
    return sha256(["lean-toolchain", "lakefile.toml", "lake-manifest.json"].map((f) => `${f}\n${this.read(f)}`).join("\n"));
  }

  defsHash(): string {
    const files = walk(join(this.dir, "Defs")).filter((p) => p.endsWith(".lean")).sort();
    return sha256(files.map((p) => `${relative(this.dir, p)}\n${readFileSync(p, "utf8")}`).join("\n"));
  }

  statementFiles(): StatementFile[] {
    return walk(join(this.dir, "Statements"))
      .filter((p) => p.endsWith(".lean") && !p.split("/").pop()!.startsWith("L_fixture_")) // judge test fixtures
      .map((p) => this.parseStatement(p))
      .filter((s): s is StatementFile => s !== null);
  }

  statementFileSha(leanName: string): string | null {
    const p = join(this.dir, "Statements", `${leanName}.lean`);
    return existsSync(p) ? sha256(readFileSync(p)) : null;
  }

  private parseStatement(path: string): StatementFile | null {
    const leanName = path.split("/").pop()!.replace(/\.lean$/, "");
    if (!LEAN_NAME_RE.test(leanName)) return null;
    const source = readFileSync(path, "utf8");
    const header = (key: string) => new RegExp(`^--\\s*${key}:[ \\t]*(.*)$`, "m").exec(source)?.[1]?.trim() ?? "";
    const def = new RegExp(`def\\s+Statement\\.${leanName}\\s*:\\s*Prop\\s*:=\\s*([\\s\\S]*)$`).exec(source);
    if (!def) throw new Error(`${path}: missing \`def Statement.${leanName} : Prop := ...\``);
    const program = header("program");
    if (!program) throw new Error(`${path}: missing "-- program: <slug>" header`);
    return {
      id: leanNameToLemmaId(leanName),
      leanName,
      program,
      title: header("title"),
      dependsOn: header("depends_on").split(",").map((s) => s.trim()).filter(Boolean),
      leanStatement: def[1]!.trim(),
      requiresMathlib: /^\s*import\s+Mathlib/m.test(source),
      fileSha256: sha256(source),
      source,
    };
  }

  /** Commit of the checkout, with "+dirty" if lean/ has uncommitted changes. */
  gitCommit(override?: string): string {
    if (override) return override;
    try {
      const head = execFileSync("git", ["-C", this.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["-C", this.dir, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim();
      return dirty ? `${head}+dirty` : head;
    } catch {
      return "unknown";
    }
  }
}

export { sha256 };
