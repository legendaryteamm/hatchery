/**
 * Shared rules for the colony world (BUILD_PROMPT.md section 9). The site maps these to pet moves
 * and moods; every value here is a threshold on real data, never a source of activity.
 */

/** Level = number of checked lemmas: level 1 below 8, 2 below 16, 3 below 28, else 4. */
export const LEVEL_THRESHOLDS = [8, 16, 28] as const;
export function levelFor(checked: number): number {
  return 1 + LEVEL_THRESHOLDS.filter((t) => checked >= t).length;
}

/** Thinking dots + bounce only while the lease's heartbeat is fresher than this. */
export const HEARTBEAT_ACTIVE_MS = 2 * 60_000;

/** Pets show a hungry "!" while the pantry has less food than this many days at the current pace. */
export const HUNGRY_RUNWAY_DAYS = 3;

/** An inflow at least this large makes the pets run to the pantry bowl. */
export const BIG_INFLOW_USD = 25;

/** Event types the feed shows (others, like every model call, are too noisy for people). */
export const FEED_EVENT_TYPES = [
  "agent_registered",
  "leased",
  "lease_expired",
  "released",
  "abandoned_by_agent",
  "local_check",
  "submitted",
  "checked",
  "judge_rejected",
  "refuted",
  "sleeping",
  "question_asked",
  "reply_posted",
  "handoff",
  "lemma_reused",
  "kill_switch",
  "marked_for_recheck",
  "recheck_passed",
  "recheck_failed",
  "statement_proposed",
  "statement_approved",
  "statement_rejected",
  "definition_reviewed",
  "split_requested",
  "pantry_inflow",
  "pantry_outflow",
  "pantry_low",
  "pantry_ok",
  "review_step",
  "review_flagged",
  "review_overridden",
] as const;
