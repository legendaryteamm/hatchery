/**
 * Budget and kill switch (BUILD_PROMPT.md section 8). All amounts in integer micro-dollars.
 *
 *   pantry          = inflows - API spend (model_calls) - outflows of kind "other"
 *                     (topup_transfer is money moving from the wallet to API billing, not consumption)
 *   global cap      = min(GLOBAL_DAILY_CAP_USD, (pantry + spent today) / RUNWAY_TARGET_DAYS)
 *                     i.e. the pantry as it stood at the start of the day, plus today's inflows
 *   per-agent cap   = global cap / active internal agents (seen in the last ACTIVE_AGENT_WINDOW_SECONDS)
 *
 * A model call is allowed only while: kill switch off, pantry > 0, spent today < global cap and
 * the agent's spend today < its cap. Workers ask before EVERY model call, so an agent overshoots
 * its cap by at most the one call that crossed it.
 */
import { eq, sql } from "drizzle-orm";
import { microsToUsd, type SleepReason } from "@hatchery/shared";
import type { Db } from "./db/client.ts";
import { budgetDays, settings } from "./db/schema.ts";

export interface BudgetStatus {
  allowed: boolean;
  reason: SleepReason | null;
  day: string;
  pantryUsd: string;
  globalCapUsd: string;
  globalSpentUsd: string;
  perAgentCapUsd: string;
  agentSpentUsd: string;
  activeAgents: number;
  killSwitch: { on: boolean; source: "env" | "admin" | null };
}

const toMicros = (numericText: string | null | undefined) => Math.round(Number(numericText ?? "0") * 1_000_000);

export async function killSwitchState(db: Db, envOn: boolean): Promise<BudgetStatus["killSwitch"]> {
  if (envOn) return { on: true, source: "env" };
  const [row] = await db.select().from(settings).where(eq(settings.key, "kill_switch"));
  return (row?.value as { on?: boolean } | undefined)?.on ? { on: true, source: "admin" } : { on: false, source: null };
}

export async function budgetStatus(
  db: Db,
  cfg: { GLOBAL_DAILY_CAP_USD: number; RUNWAY_TARGET_DAYS: number; KILL_SWITCH: boolean; ACTIVE_AGENT_WINDOW_SECONDS: number },
  agentId: string | null,
  now: Date,
): Promise<BudgetStatus> {
  const day = now.toISOString().slice(0, 10);
  const dayStart = `${day}T00:00:00Z`;
  const activeSince = new Date(now.getTime() - cfg.ACTIVE_AGENT_WINDOW_SECONDS * 1000).toISOString();
  const [r] = await db.execute<{
    inflows: string; spend_all: string; other_out: string; spent_today: string; agent_today: string; active: number;
  }>(sql`
    select
      (select coalesce(sum(amount_usd), 0) from pantry_inflows)::text as inflows,
      (select coalesce(sum(cost_usd), 0) from model_calls)::text as spend_all,
      (select coalesce(sum(amount_usd), 0) from pantry_outflows where kind = 'other')::text as other_out,
      (select coalesce(sum(cost_usd), 0) from model_calls where ts >= ${dayStart}::timestamptz)::text as spent_today,
      (select coalesce(sum(cost_usd), 0) from model_calls where ts >= ${dayStart}::timestamptz and agent_id = ${agentId})::text as agent_today,
      (select count(*) from agents where kind = 'internal' and last_seen_at >= ${activeSince}::timestamptz)::int as active`);
  const pantry = toMicros(r!.inflows) - toMicros(r!.spend_all) - toMicros(r!.other_out);
  const spentToday = toMicros(r!.spent_today);
  const agentToday = toMicros(r!.agent_today);
  const active = Math.max(1, Number(r!.active));
  const fromRunway = Math.floor(Math.max(0, pantry + spentToday) / cfg.RUNWAY_TARGET_DAYS);
  const globalCap = Math.min(Math.round(cfg.GLOBAL_DAILY_CAP_USD * 1_000_000), fromRunway);
  const perAgentCap = Math.floor(globalCap / active);
  const kill = await killSwitchState(db, cfg.KILL_SWITCH);

  let reason: SleepReason | null = null;
  if (kill.on) reason = "kill_switch";
  else if (pantry <= 0) reason = "pantry_empty";
  else if (agentId !== null && agentToday >= perAgentCap) reason = "agent_cap"; // the more specific reason first
  else if (spentToday >= globalCap) reason = "global_cap";

  await db
    .insert(budgetDays)
    .values({ date: day, globalCapUsd: microsToUsd(globalCap), perAgentCapUsd: microsToUsd(perAgentCap), spentUsd: microsToUsd(spentToday) })
    .onConflictDoUpdate({
      target: budgetDays.date,
      set: { globalCapUsd: microsToUsd(globalCap), perAgentCapUsd: microsToUsd(perAgentCap), spentUsd: microsToUsd(spentToday) },
    });

  return {
    allowed: reason === null,
    reason,
    day,
    pantryUsd: microsToUsd(pantry),
    globalCapUsd: microsToUsd(globalCap),
    globalSpentUsd: microsToUsd(spentToday),
    perAgentCapUsd: microsToUsd(perAgentCap),
    agentSpentUsd: microsToUsd(agentToday),
    activeAgents: active,
    killSwitch: kill,
  };
}
