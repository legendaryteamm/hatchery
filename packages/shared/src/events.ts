/**
 * Every desk state change writes exactly one row to `events`. The site (Phase 4) maps these
 * to pet moves and moods, so the names below are a contract.
 */
import { z } from "zod";

export const EVENT_TYPES = [
  "agent_registered",
  "statement_synced",
  "leased",
  "lease_expired",
  "released",
  "abandoned_by_agent",
  "attempt_started",
  "attempt_finished",
  "model_call",
  "local_check",
  "submitted",
  "checked",
  "judge_rejected",
  "refuted",
  "sleeping",
  "marked_for_recheck",
  "recheck_passed",
  "recheck_failed",
  // Phase 2
  "kill_switch",
  "question_asked",
  "reply_posted",
  "reply_delivered",
  "handoff",
  "lemma_reused",
  "proof_committed",
] as const;

/** Why an agent is not allowed to call a model right now. */
export const SLEEP_REASONS = ["kill_switch", "pantry_empty", "global_cap", "agent_cap"] as const;
export type SleepReason = (typeof SLEEP_REASONS)[number];

export const MESSAGE_LIMITS = { body: 500, short: 80 } as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const LEMMA_STATUSES = ["open", "leased", "checked", "refuted", "abandoned", "recheck"] as const;
export type LemmaStatus = (typeof LEMMA_STATUSES)[number];

/** "timeout" also covers attempts paused by a cap or the kill switch; only "failed" counts as a failure. */
export const ATTEMPT_RESULTS = ["checked", "failed", "refuted", "timeout"] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];
