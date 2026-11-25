/** Facts about the runner image (flavor, trusted-input hash) and library search. */
import { dockerRunner, type ContainerRunner } from "./docker.ts";

export interface RunnerInfo {
  flavor: "full" | "lite" | "unknown";
  trustedSha: string;
  leanVersion: string;
}

const SMALL = { timeoutMs: 60_000, memoryMb: 512, cpus: 1, maxStdoutBytes: 256 * 1024 };

export async function runnerInfo(image: string, run: ContainerRunner = dockerRunner): Promise<RunnerInfo> {
  const r = await run(image, ["version"], "", SMALL);
  const out = r.stdout.toString("utf8");
  if (r.exitCode !== 0) throw new Error(`runner image ${image} is not usable: ${r.stderr.slice(0, 300)}`);
  const flavor = /flavor=(\w+)/.exec(out)?.[1];
  return {
    flavor: flavor === "full" || flavor === "lite" ? flavor : "unknown",
    trustedSha: /trusted_sha=([0-9a-f]{64})/.exec(out)?.[1] ?? "",
    leanVersion: /Lean \(version ([^,]+)/.exec(out)?.[1] ?? "",
  };
}

export const SEARCH_QUERY_RE = /^[\x20-\x7e]{2,100}$/;

/** Fixed-string search over Lean core (and Mathlib in the full image) sources, max 60 lines. */
export async function searchLibrary(image: string, query: string, run: ContainerRunner = dockerRunner): Promise<string> {
  if (!SEARCH_QUERY_RE.test(query)) throw new Error("query must be 2-100 printable ASCII characters");
  const r = await run(image, ["search", query], "", { ...SMALL, timeoutMs: 30_000 });
  if (r.timedOut) return "(search timed out)";
  return r.stdout.toString("utf8").trim() || "(no matches)";
}
