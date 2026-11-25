/**
 * Runs ONE fresh runner container with the sandbox flags, feeding stdin and collecting stdout.
 * The container is killed from outside on timeout or when stdout grows past a limit.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SandboxLimits {
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  maxStdoutBytes: number;
}

export interface ContainerResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  stdoutOverflow: boolean;
}

export type ContainerRunner = (
  image: string,
  args: string[],
  stdin: Buffer | string,
  limits: SandboxLimits,
) => Promise<ContainerResult>;

const MAX_STDERR = 64 * 1024;

export function sandboxArgs(name: string, image: string, args: string[], limits: SandboxLimits): string[] {
  return [
    "run",
    "--name", name,
    "--interactive",
    "--network", "none",
    "--read-only",
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", `${limits.memoryMb}m`,
    "--memory-swap", `${limits.memoryMb}m`,
    "--cpus", String(limits.cpus),
    "--pids-limit", "256",
    "--ulimit", "nofile=1024:1024",
    "--tmpfs", "/tmp:rw,size=1g,mode=1777",
    "--label", "dev.hatchery.role=judge-sandbox",
    image,
    ...args,
  ];
}

function docker(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => resolve({ code, out }));
    p.on("error", () => resolve({ code: -1, out: "" }));
  });
}

export const dockerRunner: ContainerRunner = async (image, args, stdin, limits) => {
  const name = `hatchery-judge-${randomUUID()}`;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let timedOut = false;
  let stdoutOverflow = false;

  const child = spawn("docker", sandboxArgs(name, image, args, limits), { stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => void docker(["kill", name]);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, limits.timeoutMs);

  child.stdout.on("data", (d: Buffer) => {
    size += d.length;
    if (size > limits.maxStdoutBytes) {
      if (!stdoutOverflow) {
        stdoutOverflow = true;
        kill();
      }
      return;
    }
    chunks.push(d);
  });
  child.stderr.on("data", (d: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += d.toString();
  });
  child.stdin.on("error", () => {}); // container may exit before reading all input
  child.stdin.end(stdin);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => {
      stderr += `\nfailed to start docker: ${err.message}`;
      resolve(null);
    });
  });
  clearTimeout(timer);

  const inspect = await docker(["inspect", "--format", "{{.State.OOMKilled}}", name]);
  const oomKilled = inspect.out.trim() === "true";
  await docker(["rm", "--force", name]);

  return {
    exitCode,
    stdout: Buffer.concat(chunks),
    stderr: stderr.slice(0, MAX_STDERR),
    timedOut,
    oomKilled,
    stdoutOverflow,
  };
};
