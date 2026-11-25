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
  /** Sanity lemmas: the definition modules this known basic fact tests ("sanity_for:" header). */
  sanityFor: text("sanity_for").array().notNull().default(sql`'{}'::text[]`),
  /** Blocked by an admin: never auto-reviewed until unblocked. */
  blockedAt: ts("blocked_at"),
  /** Set when proposed as a split of another lemma. */
  parentId: text("parent_id"),
  proposedAt: ts("proposed_at"),
  approvedAt: ts("approved_at"),
});

/** draft = in review; rejected = the automated review failed; blocked = an admin blocked it (never auto-reviewed until unblocked). */
export const definitionStatus = pgEnum("definition_status", ["draft", "approved", "changes_requested", "rejected", "blocked"]);
export const reviewerRole = pgEnum("reviewer_role", ["advisor", "maintainer"]);
export const reviewDecision = pgEnum("review_decision", ["approve", "request_changes", "reject", "comment"]);

/**
 * ext (Phase 3): one row per definition module (`lean/Defs/.../*.lean`). It is a DRAFT unless an
 * review (AI agents; or a human with HUMAN_REVIEW_TOOL=1) approved exactly the current source (reviewed_sha256 = source_sha256) and every
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
  /** How the current status was decided: ai | human | admin (autonomous review). */
  reviewedVia: text("reviewed_via"),
  /** Goals the adversary tries to prove from this module, besides False ("adversary:" header). */
  adversaryGoals: text("adversary_goals").array().notNull().default(sql`'{}'::text[]`),
  blockedReason: text("blocked_reason"),
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
  /** Phase 6: checked through a contributor's pull request (the merge brings the file; the desk does not commit it). */
  checkedViaPr: integer("checked_via_pr"),
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
  note: text("note").notNull().default(""), // ext (Phase 5)
  recordedBy: text("recorded_by").notNull().default(""), // ext (Phase 5): who recorded it (admin login / cli user)
});

export const budgetDays = pgTable("budget_days", {
  date: date("date").primaryKey(),
  globalCapUsd: usd("global_cap_usd").notNull(),
  perAgentCapUsd: usd("per_agent_cap_usd").notNull(),
  spentUsd: usd("spent_usd").notNull().default("0"),
});

// ---------------------------------------------------------------- Phase 6: outside contributors

/** A person who signed in with GitHub (or with the local-only dev login). */
export const contributors = pgTable("contributors", {
  login: text("login").primaryKey(), // GitHub login, lowercase
  githubId: text("github_id"), // null for dev logins
  dev: boolean("dev").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
  blockedAt: ts("blocked_at"),
});

export const contributorSessions = pgTable("contributor_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  login: text("login").notNull().references(() => contributors.login),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});

/** API tokens for a contributor's own agent (shown once; only the hash is stored). */
export const apiTokens = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  login: text("login").notNull().references(() => contributors.login),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
});

/** Every pull request result the CI reported (idempotent per PR head commit). */
export const contributions = pgTable(
  "contributions",
  {
    id: serial("id").primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    login: text("login").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    lemmaId: text("lemma_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    result: text("result").notNull(), // pass | fail | refused
    reason: text("reason").notNull().default(""),
    attemptId: integer("attempt_id"),
    mergedCommit: text("merged_commit"),
  },
  (t) => [uniqueIndex("contributions_pr_head_idx").on(t.prNumber, t.headSha)],
);

// ---------------------------------------------------------------- Autonomous review (no human advisor)

/**
 * One review of one exact source text (definition module or statement). Every step and its
 * reasoning is kept, and shown on the site.
 */
export const reviewRounds = pgTable(
  "review_rounds",
  {
    id: serial("id").primaryKey(),
    targetKind: text("target_kind").notNull(), // definition | statement
    targetId: text("target_id").notNull(),
    targetSha256: text("target_sha256").notNull(),
    status: text("status").notNull().default("running"), // running | approved | rejected | superseded
    trigger: text("trigger").notNull(), // new | changed | flag | admin | dependency | human
    reason: text("reason").notNull().default(""),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    /** Adversary bookkeeping: judge checks run and money spent in this round. */
    adversaryChecks: integer("adversary_checks").notNull().default(0),
    adversaryDone: boolean("adversary_done").notNull().default(false),
    adversarySpentUsd: usd("adversary_spent_usd").notNull().default("0"),
    /** The adversary agent working on this round, and until when (one at a time). */
    adversaryAgent: text("adversary_agent"),
    adversaryUntil: ts("adversary_until"),
  },
  (t) => [index("review_rounds_target_idx").on(t.targetKind, t.targetId)],
);

export const reviewSteps = pgTable(
  "review_steps",
  {
    id: serial("id").primaryKey(),
    roundId: integer("round_id").notNull().references(() => reviewRounds.id),
    ts: ts("ts").notNull().defaultNow(),
    kind: text("kind").notNull(), // reviewer | sanity | adversary | filter | definitions | flag | admin | human
    actor: text("actor").notNull(), // agent id, "desk", "github:<login>", reviewer name
    model: text("model"),
    verdict: text("verdict").notNull(), // pass | fail | info
    summary: text("summary").notNull().default(""),
    reasoning: text("reasoning").notNull().default(""),
    details: jsonb("details").notNull().default({}),
    costUsd: usd("cost_usd").notNull().default("0"),
  },
  (t) => [index("review_steps_round_idx").on(t.roundId)],
);

/** Public flags (GitHub issues) that sent a definition or statement back to review. */
export const reviewFlags = pgTable("review_flags", {
  id: serial("id").primaryKey(),
  ts: ts("ts").notNull().defaultNow(),
  issueNumber: integer("issue_number").notNull().unique(),
  login: text("login").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  roundId: integer("round_id"),
});
