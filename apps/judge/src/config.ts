import { z } from "zod";

const Env = z.object({
  JUDGE_IMAGE: z.string().default("hatchery-lean-runner:full"),
  JUDGE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  JUDGE_MEMORY_MB: z.coerce.number().int().min(512).default(8192),
  JUDGE_CPUS: z.coerce.number().positive().default(2),
  JUDGE_CONCURRENCY: z.coerce.number().int().positive().default(1),
  JUDGE_QUEUE_MAX: z.coerce.number().int().nonnegative().default(20),
  JUDGE_API_TOKEN: z.string().optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4100),
});

export interface JudgeConfig {
  image: string;
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  concurrency: number;
  queueMax: number;
  apiToken: string | undefined;
  host: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const e = Env.parse(env);
  return {
    image: e.JUDGE_IMAGE,
    timeoutSeconds: e.JUDGE_TIMEOUT_SECONDS,
    memoryMb: e.JUDGE_MEMORY_MB,
    cpus: e.JUDGE_CPUS,
    concurrency: e.JUDGE_CONCURRENCY,
    queueMax: e.JUDGE_QUEUE_MAX,
    apiToken: e.JUDGE_API_TOKEN || undefined,
    host: e.HOST,
    port: e.PORT,
  };
}
