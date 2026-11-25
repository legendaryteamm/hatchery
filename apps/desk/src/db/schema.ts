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
  /** ext: short prefix for lemma ids, e.g. "circ" in L-circ-014. */
  idPrefix: text("id_prefix").notNull().default(""),
  sort: integer("sort").notNull().default(0),
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
  fileSha256: text("file_sha256").notNull(), // ext: sha256 of `source`
  // ext (Phase 3)
  /** The whole statement file `Statements/<L>.lean`: what reviewers approve and the judge receives. */
  source: text("source").notNull().default(""),
  origin: text("origin").notNull().default("repo"), // repo | decomposer
  /** Definition modules the statement imports (`Defs.*`). It cannot be approved while any is a draft. */
  defImports: text("def_imports").array().notNull().default(sql`'{}'::text[]`),
  /** Result of the automatic statement check (null = not checked yet). */
  check: jsonb("check"),
  rationale: text("rationale").notNull().default(""),
  rejectReason: text("reject_reason"),
  /** Set when proposed as a split of another lemma. */
  parentId: text("parent_id"),
  proposedAt: ts("proposed_at"),
  approvedAt: ts("approved_at"),
});

export const definitionStatus = pgEnum("definition_status", ["draft", "approved", "changes_requested"]);
export const reviewerRole = pgEnum("reviewer_role", ["advisor", "maintainer"]);
export const reviewDecision = pgEnum("review_decision", ["approve", "request_changes", "reject", "comment"]);

/**
 * ext (Phase 3): one row per definition module (`lean/Defs/.../*.lean`). It is a DRAFT unless an
 * advisor approved exactly the current source (reviewed_sha256 = source_sha256) and every
 * definition module it imports is approved too.
 */
export const definitions = pgTable("definitions", {
  id: text("id").primaryKey(), // module name, e.g. Defs.Core.Circuit
  path: text("path").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  source: text("source").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  imports: text("imports").array().notNull().default(sql`'{}'::text[]`),
  requiresMathlib: boolean("requires_mathlib").notNull().default(false),
  status: definitionStatus("status").notNull().default("draft"),
  reviewedSha256: text("reviewed_sha256"),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  removed: boolean("removed").notNull().default(false),
});

/** ext (Phase 3): people who review definitions and statements (no developer account needed). */
export const reviewers = pgTable("reviewers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  role: reviewerRole("role").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  disabledAt: ts("disabled_at"),
  inviteTokenHash: text("invite_token_hash").unique(),
  inviteExpiresAt: ts("invite_expires_at"),
  inviteUsedAt: ts("invite_used_at"),
});

export const reviewerSessions = pgTable("reviewer_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  reviewerId: integer("reviewer_id").notNull().references(() => reviewers.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

/** ext (Phase 3): every review decision, bound to the exact source the reviewer saw. */
export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    targetKind: text("target_kind").notNull(), // definition | statement
    targetId: text("target_id").notNull(),
    targetSha256: text("target_sha256").notNull(),
    reviewerId: integer("reviewer_id").notNull().references(() => reviewers.id),
    decision: reviewDecision("decision").notNull(),
    comment: text("comment").notNull().default(""),
  },
  (t) => [index("reviews_target_idx").on(t.targetKind, t.targetId)],
);

/** ext (Phase 3, section 6b "split request"): an agent asks the decomposer to split its lemma. */
export const splitRequests = pgTable("split_requests", {
  id: serial("id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  agentId: text("agent_id").notNull(),
  lemmaId: text("lemma_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"), // open | done
  handledAt: ts("handled_at"),
  proposals: text("proposals").array().notNull().default(sql`'{}'::text[]`),
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
  /** ext (6b handoff): full handoff note (approaches, errors, best partial proof) for the next agent. */
  handoffNote: text("handoff_note"),
  /** ext (6b handoff): the lemma is offered first to this idle teammate until offered_until. */
  offeredTo: text("offered_to"),
  offeredUntil: ts("offered_until"),
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
  /** ext: last request from this agent; "active" agents share the daily budget. */
  lastSeenAt: ts("last_seen_at"),
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
    purpose: text("purpose").notNull(), // "prove" | "reply"
    /** The model that served this part of the call (a refusal fallback can add a second part). */
    model: text("model").notNull(),
    /** Index of the part within one API call (iterations of usage), 0-based. */
    part: integer("part").notNull().default(0),
    servedByFallback: boolean("served_by_fallback").notNull().default(false),
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
  // ext (6b): routing and delivery
  replyTo: integer("reply_to"),
  routedTo: text("routed_to").array().notNull().default(sql`'{}'::text[]`),
  deliveredAt: ts("delivered_at"),
  deliveredInAttempt: integer("delivered_in_attempt"),
  expiresAt: ts("expires_at"),
});

/** ext (6b reuse): which checked lemma helped which. */
export const reuses = pgTable("reuses", {
  id: serial("id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  lemmaId: text("lemma_id").notNull().references(() => lemmas.id),
  reusedLemmaId: text("reused_lemma_id").notNull().references(() => lemmas.id),
  agentId: text("agent_id").notNull(),
});

/** ext: shared switches (kill switch), so every desk instance and worker sees the same value. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
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
