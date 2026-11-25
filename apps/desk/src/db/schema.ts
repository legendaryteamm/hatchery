/**
 * Database schema (BUILD_PROMPT.md section 4). Extensions beyond the minimum are marked "ext".
 * Money is stored as numeric(14,6) USD (exact micro-dollars), never floats.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const usd = (name: string) => numeric(name, { precision: 14, scale: 6 });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const programStatus = pgEnum("program_status", ["active", "paused", "archived"]);
export const statementStatus = pgEnum("statement_status", ["proposed", "approved", "rejected"]);
export const lemmaStatus = pgEnum("lemma_status", ["open", "leased", "checked", "refuted", "abandoned", "recheck"]);
export const agentKind = pgEnum("agent_kind", ["internal", "external"]);
export const attemptResult = pgEnum("attempt_result", ["checked", "failed", "refuted", "timeout"]);
export const messageKind = pgEnum("message_kind", ["question", "hint", "note", "handoff", "reply"]);
export const outflowKind = pgEnum("outflow_kind", ["api_spend", "topup_transfer", "other"]);

export const programs = pgTable("programs", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: programStatus("status").notNull().default("active"),
});

export const statements = pgTable("statements", {
  id: text("id").primaryKey(), // e.g. L-core-001
  programId: integer("program_id").notNull().references(() => programs.id),
  leanName: text("lean_name").notNull().unique(),
  title: text("title").notNull().default(""), // ext
  leanStatement: text("lean_statement").notNull(),
  status: statementStatus("status").notNull().default("proposed"),
  proposedBy: text("proposed_by").notNull(),
  approvedBy: text("approved_by"),
  dependsOn: text("depends_on").array().notNull().default(sql`'{}'::text[]`),
  requiresMathlib: boolean("requires_mathlib").notNull().default(false), // ext: gate (docs/deploy.md)
  fileSha256: text("file_sha256").notNull(), // ext: hash of lean/Statements/<L>.lean
});

export const lemmas = pgTable("lemmas", {
  id: text("id").primaryKey().references(() => statements.id),
  status: lemmaStatus("status").notNull().default("open"),
  checkedProofPath: text("checked_proof_path"),
  checkedAt: ts("checked_at"),
  checkedByAgent: text("checked_by_agent"),
  // ext: the checked proof, pinned exactly as it was checked
  checkedSource: text("checked_source"),
  checkedSourceSha256: text("checked_source_sha256"),
  checkedCommit: text("checked_commit"),
  /** Hash of everything the check depended on (statement, defs, toolchain, deps). See fingerprint.ts. */
  checkedFingerprint: text("checked_fingerprint"),
  /** Checked lemmas this proof imports directly (`import Proofs.L_x`). */
  proofImports: text("proof_imports").array().notNull().default(sql`'{}'::text[]`),
  checkedVerdict: jsonb("checked_verdict"),
});

export const leases = pgTable("leases", {
  lemmaId: text("lemma_id").primaryKey().references(() => lemmas.id),
  holder: text("holder").notNull(),
  expiresAt: ts("expires_at").notNull(),
  lastHeartbeat: ts("last_heartbeat").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  species: text("species").notNull(),
  shellColor: text("shell_color").notNull(),
  kind: agentKind("kind").notNull().default("internal"),
  model: text("model").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const attempts = pgTable(
  "attempts",
  {
    id: serial("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    lemmaId: text("lemma_id").notNull().references(() => lemmas.id),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    result: attemptResult("result"),
    judgeErrors: text("judge_errors"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0), // ext
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0), // ext
    costUsd: usd("cost_usd").notNull().default("0"),
    notes: text("notes"),
    turns: integer("turns").notNull().default(0), // ext
    submittedSource: text("submitted_source"), // ext
  },
  (t) => [index("attempts_lemma_idx").on(t.lemmaId), index("attempts_agent_idx").on(t.agentId)],
);

/** ext: one row per model call - the raw spend ledger the daily caps (Phase 2) are built on. */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    attemptId: integer("attempt_id").references(() => attempts.id),
    purpose: text("purpose").notNull(), // "prove" now; "question" / "reply" / ... in Phase 2
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costUsd: usd("cost_usd").notNull(),
    priceAsOf: text("price_as_of").notNull(),
    requestId: text("request_id"),
  },
  (t) => [index("model_calls_ts_idx").on(t.ts)],
);

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  fromAgent: text("from_agent").notNull().references(() => agents.id),
  toAgent: text("to_agent").references(() => agents.id),
  lemmaId: text("lemma_id").references(() => lemmas.id),
  kind: messageKind("kind").notNull(),
  body: text("body").notNull(),
  short: text("short").notNull(),
  costUsd: usd("cost_usd").notNull().default("0"),
});

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    type: text("type").notNull(),
    agentId: text("agent_id"),
    lemmaId: text("lemma_id"),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [index("events_lemma_idx").on(t.lemmaId), index("events_agent_idx").on(t.agentId)],
);

export const pantryInflows = pgTable(
  "pantry_inflows",
  {
    txHash: text("tx_hash").notNull(),
    chain: text("chain").notNull(),
    amountNative: numeric("amount_native", { precision: 38, scale: 18 }).notNull(),
    amountUsd: usd("amount_usd").notNull(),
    usdRateSource: text("usd_rate_source").notNull(),
    ts: ts("ts").notNull(),
  },
  (t) => [uniqueIndex("pantry_inflows_tx_idx").on(t.chain, t.txHash)],
);

export const pantryOutflows = pgTable("pantry_outflows", {
  id: serial("id").primaryKey(),
  kind: outflowKind("kind").notNull(),
  amountUsd: usd("amount_usd").notNull(),
  reference: text("reference").notNull(),
  ts: ts("ts").notNull().defaultNow(),
});

export const budgetDays = pgTable("budget_days", {
  date: date("date").primaryKey(),
  globalCapUsd: usd("global_cap_usd").notNull(),
  perAgentCapUsd: usd("per_agent_cap_usd").notNull(),
  spentUsd: usd("spent_usd").notNull().default("0"),
});
