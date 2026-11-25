/**
 * Public read models for the site (Phase 4). Every number comes from the database.
 * Queries are aggregates, so the cost does not grow per agent (the world must stay smooth at 50+).
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { FEED_EVENT_TYPES, HEARTBEAT_ACTIVE_MS, HUNGRY_RUNWAY_DAYS, levelFor, petIdentity } from "@hatchery/shared";
import { agents, attempts, events, lemmas, messages, pantryInflows, pantryOutflows, programs, statements } from "./db/schema.ts";
import type { Desk } from "./service.ts";

export interface PantrySummary {
  pantryUsd: string;
  inflowsUsd: string;
  apiSpendUsd: string;
  otherOutflowsUsd: string;
  /** Average daily API spend over the last 7 days (null when nothing was spent). */
  dailySpendUsd: string | null;
  /** Days of food at that pace (null when nothing was spent). */
  runwayDays: number | null;
  hungry: boolean;
  globalCapUsd: string;
  perAgentCapUsd: string;
  spentTodayUsd: string;
  killSwitch: boolean;
  recentInflows: { ts: string; chain: string; amountUsd: string; txHash: string; usdRateSource: string }[];
  /** Top-ups (wallet to API billing) and other outflows, recorded by people. */
  topupsUsd: string;
  recentOutflows: { id: number; ts: string; kind: string; amountUsd: string; reference: string; note: string }[];
  /** The treasury this desk tracks ("mock" = development money, labelled on the site). */
  treasury: { chain: string; address: string; mock: boolean };
}

export async function pantrySummary(desk: Desk): Promise<PantrySummary> {
  const now = desk.now();
  const b = await desk.budget(null);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [t] = await desk.db.execute<{ inflows: string; api: string; other: string; topups: string; week: string; first: string | null }>(sql`
    select
      (select coalesce(sum(amount_usd), 0) from pantry_inflows)::numeric(14,6)::text as inflows,
      (select coalesce(sum(cost_usd), 0) from model_calls)::numeric(14,6)::text as api,
      (select coalesce(sum(amount_usd), 0) from pantry_outflows where kind = 'other')::numeric(14,6)::text as other,
      (select coalesce(sum(amount_usd), 0) from pantry_outflows where kind = 'topup_transfer')::numeric(14,6)::text as topups,
      (select coalesce(sum(cost_usd), 0) from model_calls where ts >= ${weekAgo}::timestamptz)::numeric(14,6)::text as week,
      (select min(ts)::text from model_calls where ts >= ${weekAgo}::timestamptz) as first`);
  // Average over the days actually covered (at most 7), so a young colony is not under-counted.
  const days = t!.first ? Math.min(7, Math.max(1, (now.getTime() - new Date(t!.first).getTime()) / 86_400_000)) : 0;
  const daily = days ? Number(t!.week) / days : 0;
  const pantry = Number(b.pantryUsd);
  const runway = daily > 0 ? Math.max(0, pantry / daily) : null;
  const recent = await desk.db.select().from(pantryInflows).orderBy(desc(pantryInflows.ts)).limit(20);
  const outs = await desk.db.select().from(pantryOutflows).orderBy(desc(pantryOutflows.ts)).limit(20);
  return {
    pantryUsd: b.pantryUsd,
    inflowsUsd: t!.inflows,
    apiSpendUsd: t!.api,
    otherOutflowsUsd: t!.other,
    dailySpendUsd: daily > 0 ? daily.toFixed(6) : null,
    runwayDays: runway === null ? null : Math.round(runway * 10) / 10,
    // Hungry: under HUNGRY_RUNWAY_DAYS of food at the current pace, or nothing left at all.
    hungry: pantry <= 0 || (runway !== null && runway < HUNGRY_RUNWAY_DAYS),
    globalCapUsd: b.globalCapUsd,
    perAgentCapUsd: b.perAgentCapUsd,
    spentTodayUsd: b.globalSpentUsd,
    killSwitch: b.killSwitch.on,
    recentInflows: recent.map((r) => ({ ts: r.ts.toISOString(), chain: r.chain, amountUsd: r.amountUsd, txHash: r.txHash, usdRateSource: r.usdRateSource })),
    topupsUsd: t!.topups,
    recentOutflows: outs.map((o) => ({ id: o.id, ts: o.ts.toISOString(), kind: o.kind, amountUsd: o.amountUsd, reference: o.reference, note: o.note })),
    treasury: { chain: desk.config.TREASURY_CHAIN, address: desk.config.TREASURY_ADDRESS, mock: desk.config.TREASURY_CHAIN === "mock" },
  };
}

export interface ColonyAgent {
  id: string;
  name: string;
  species: string;
  shell: string;
  kind: "internal" | "external";
  model: string;
  level: number;
  checkedTotal: number;
  /** Seen within ACTIVE_AGENT_WINDOW_SECONDS. Inactive agents are not in the world (roster: "offline"). */
  active: boolean;
  lemmaId: string | null;
  program: string | null;
  /** The lease's heartbeat is fresher than HEARTBEAT_ACTIVE_MS (thinking dots + bounce). */
  heartbeatFresh: boolean;
  lastHeartbeat: string | null;
  sleeping: boolean;
  sleepReason: string | null;
  /** The program of its current or most recent lease: where it camps. */
  camp: string | null;
  spentTodayUsd: string;
  /** Remaining share of today's per-agent cap, 0..1 (the food bar). */
  food: number;
}

export interface ColonySnapshot {
  /** Events up to and including this id are reflected; stream from here. */
  asOfEventId: number;
  serverTime: string;
  programs: { slug: string; title: string; idPrefix: string; checked: number; total: number }[];
  agents: ColonyAgent[];
  pantry: { pantryUsd: string; runwayDays: number | null; hungry: boolean; perAgentCapUsd: string; killSwitch: boolean };
  totals: { checked: number; lemmas: number; awake: number };
}

export async function colonySnapshot(desk: Desk): Promise<ColonySnapshot> {
  const now = desk.now();
  const [{ max }] = (await desk.db.execute<{ max: number | null }>(sql`select max(id)::int as max from events`)) as unknown as [{ max: number | null }];
  const pantry = await pantrySummary(desk);
  const activeSince = new Date(now.getTime() - desk.config.ACTIVE_AGENT_WINDOW_SECONDS * 1000).toISOString();
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
  const progRows = await desk.db.execute<{ slug: string; title: string; id_prefix: string; checked: number; total: number }>(sql`
    select p.slug, p.title, p.id_prefix,
      count(l.id) filter (where l.status = 'checked')::int as checked, count(l.id)::int as total
    from programs p
    left join statements s on s.program_id = p.id and s.status = 'approved'
    left join lemmas l on l.id = s.id
    group by p.id order by p.sort`);
  const rows = await desk.db.execute<{
    id: string; display_name: string; species: string; shell_color: string; kind: "internal" | "external"; model: string;
    active: boolean; lemma_id: string | null; last_heartbeat: string | null; lease_program: string | null; camp: string | null;
    checked: number; spent: string; last_type: string | null; last_reason: string | null;
  }>(sql`
    select a.id, a.display_name, a.species, a.shell_color, a.kind, a.model,
      coalesce(a.last_seen_at >= ${activeSince}::timestamptz, false) as active,
      ls.lemma_id, ls.last_heartbeat::text as last_heartbeat, lp.slug as lease_program,
      (select p.slug from events e join statements s on s.id = e.lemma_id join programs p on p.id = s.program_id
        where e.type = 'leased' and e.agent_id = a.id order by e.id desc limit 1) as camp,
      (select count(*) from lemmas l where l.checked_by_agent = a.id and l.status = 'checked')::int as checked,
      (select coalesce(sum(cost_usd), 0) from model_calls m where m.agent_id = a.id and m.ts >= ${dayStart}::timestamptz)::numeric(14,6)::text as spent,
      st.type as last_type, st.payload->>'reason' as last_reason
    from agents a
    left join leases ls on ls.holder = a.id
    left join statements lst on lst.id = ls.lemma_id
    left join programs lp on lp.id = lst.program_id
    left join lateral (
      select e.type, e.payload from events e
      where e.agent_id = a.id and e.type in ('sleeping', 'leased', 'model_call', 'agent_registered', 'attempt_started')
      order by e.id desc limit 1
    ) st on true
    order by a.created_at, a.id`);
  const cap = Number(pantry.perAgentCapUsd);
  const list: ColonyAgent[] = rows.map((r) => {
    const fresh = r.last_heartbeat ? now.getTime() - new Date(r.last_heartbeat).getTime() < HEARTBEAT_ACTIVE_MS : false;
    const sleeping = r.last_type === "sleeping";
    return {
      id: r.id,
      name: r.display_name,
      species: r.species,
      shell: r.shell_color,
      kind: r.kind,
      model: r.model,
      level: levelFor(r.checked),
      checkedTotal: r.checked,
      active: r.active,
      lemmaId: r.lemma_id,
      program: r.lease_program,
      heartbeatFresh: fresh,
      lastHeartbeat: r.last_heartbeat ? new Date(r.last_heartbeat).toISOString() : null,
      sleeping,
      sleepReason: sleeping ? r.last_reason : null,
      camp: r.lease_program ?? r.camp,
      spentTodayUsd: Number(r.spent).toFixed(6),
      food: cap > 0 ? Math.max(0, Math.min(1, (cap - Number(r.spent)) / cap)) : 0,
    };
  });
  return {
    asOfEventId: Number(max ?? 0),
    serverTime: now.toISOString(),
    programs: progRows.map((p) => ({ slug: p.slug, title: p.title, idPrefix: p.id_prefix, checked: p.checked, total: p.total })),
    agents: list,
    pantry: { pantryUsd: pantry.pantryUsd, runwayDays: pantry.runwayDays, hungry: pantry.hungry, perAgentCapUsd: pantry.perAgentCapUsd, killSwitch: pantry.killSwitch },
    totals: {
      checked: progRows.reduce((a, p) => a + p.checked, 0),
      lemmas: progRows.reduce((a, p) => a + p.total, 0),
      awake: list.filter((a) => a.active && !a.sleeping).length,
    },
  };
}

export interface FeedItem {
  id: number;
  ts: string;
  type: string;
  agentId: string | null;
  agentName: string | null;
  shell: string | null;
  lemmaId: string | null;
  payload: Record<string, unknown>;
  /** For message events: the message itself (bubbles and feed lines come only from here). */
  message: { id: number; kind: string; short: string; body: string; fromAgent: string; toAgent: string | null; toName: string | null } | null;
}

/** Feed events (newest first), with the names and messages the site needs to render them. */
export async function feed(desk: Desk, opts: { before?: number; after?: number; limit?: number; agentId?: string; lemmaId?: string } = {}): Promise<FeedItem[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const conds = [inArray(events.type, [...FEED_EVENT_TYPES])];
  if (opts.before) conds.push(lt(events.id, opts.before));
  if (opts.after) conds.push(sql`${events.id} > ${opts.after}`);
  if (opts.agentId) conds.push(eq(events.agentId, opts.agentId));
  if (opts.lemmaId) conds.push(eq(events.lemmaId, opts.lemmaId));
  const rows = await desk.db
    .select({ e: events, name: agents.displayName, shell: agents.shellColor })
    .from(events)
    .leftJoin(agents, eq(agents.id, events.agentId))
    .where(and(...conds))
    .orderBy(desc(events.id))
    .limit(limit);
  const msgIds = rows.map((r) => Number((r.e.payload as { messageId?: number }).messageId)).filter((n) => Number.isInteger(n) && n > 0);
  const msgs = msgIds.length ? await desk.db.select().from(messages).where(inArray(messages.id, msgIds)) : [];
  const names = new Map((await desk.db.select({ id: agents.id, n: agents.displayName }).from(agents)).map((a) => [a.id, a.n]));
  return rows.map(({ e, name, shell }) => {
    const m = msgs.find((x) => x.id === Number((e.payload as { messageId?: number }).messageId));
    return {
      id: e.id,
      ts: e.ts.toISOString(),
      type: e.type,
      agentId: e.agentId,
      agentName: name ?? (e.agentId ? petIdentity(e.agentId).displayName : null),
      shell: shell ?? null,
      lemmaId: e.lemmaId,
      payload: e.payload as Record<string, unknown>,
      message: m ? { id: m.id, kind: m.kind, short: m.short, body: m.body, fromAgent: m.fromAgent, toAgent: m.toAgent, toName: m.toAgent ? names.get(m.toAgent) ?? null : null } : null,
    };
  });
}

/** The pet card (section 9): current lemma, attempts today, checked total, notes, recent activity, spend today. */
export async function agentCard(desk: Desk, id: string) {
  const snap = await colonySnapshot(desk);
  const a = snap.agents.find((x) => x.id === id);
  if (!a) return null;
  const dayStart = `${desk.now().toISOString().slice(0, 10)}T00:00:00Z`;
  const [c] = await desk.db.execute<{ today: number; failed: number; notes: number }>(sql`
    select
      (select count(*) from attempts where agent_id = ${id} and started_at >= ${dayStart}::timestamptz)::int as today,
      (select count(*) from attempts where agent_id = ${id} and result = 'failed')::int as failed,
      ((select count(*) from attempts where agent_id = ${id} and coalesce(notes, '') <> '')
        + (select count(*) from messages where from_agent = ${id}))::int as notes`);
  const [lemma] = a.lemmaId
    ? await desk.db.select({ id: statements.id, title: statements.title, leanStatement: statements.leanStatement }).from(statements).where(eq(statements.id, a.lemmaId))
    : [];
  const recentMessages = await desk.db
    .select()
    .from(messages)
    .where(sql`${messages.fromAgent} = ${id} or ${messages.toAgent} = ${id}`)
    .orderBy(desc(messages.id))
    .limit(10);
  return {
    ...a,
    attemptsToday: Number(c!.today),
    failedTotal: Number(c!.failed),
    notesShared: Number(c!.notes),
    perAgentCapUsd: snap.pantry.perAgentCapUsd,
    lemma: lemma ?? null,
    recentEvents: await feed(desk, { agentId: id, limit: 12 }),
    recentMessages: recentMessages.map((m) => ({ id: m.id, ts: m.ts.toISOString(), kind: m.kind, short: m.short, body: m.body, fromAgent: m.fromAgent, toAgent: m.toAgent })),
  };
}

/** Failures shown as prominently as successes (section 1). */
export async function graveyard(desk: Desk) {
  const fallen = await desk.db
    .select({ id: lemmas.id, status: lemmas.status, title: statements.title, program: programs.slug, leanStatement: statements.leanStatement })
    .from(lemmas)
    .innerJoin(statements, eq(statements.id, lemmas.id))
    .innerJoin(programs, eq(programs.id, statements.programId))
    .where(inArray(lemmas.status, ["refuted", "abandoned"]))
    .orderBy(lemmas.id);
  const rejected = await desk.db
    .select({ id: statements.id, title: statements.title, program: programs.slug, leanStatement: statements.leanStatement, reason: statements.rejectReason, origin: statements.origin })
    .from(statements)
    .innerJoin(programs, eq(programs.id, statements.programId))
    .where(eq(statements.status, "rejected"))
    .orderBy(desc(statements.proposedAt))
    .limit(100);
  const failedRechecks = await desk.db.select().from(events).where(eq(events.type, "recheck_failed")).orderBy(desc(events.id)).limit(50);
  const failedAttempts = await desk.db
    .select({ id: attempts.id, lemmaId: attempts.lemmaId, agentId: attempts.agentId, endedAt: attempts.endedAt, judgeErrors: attempts.judgeErrors, notes: attempts.notes, costUsd: attempts.costUsd })
    .from(attempts)
    .where(eq(attempts.result, "failed"))
    .orderBy(desc(attempts.id))
    .limit(50);
  const [{ n }] = (await desk.db.execute<{ n: number }>(sql`select count(*)::int as n from attempts where result = 'failed'`)) as unknown as [{ n: number }];
  return {
    lemmas: fallen,
    rejectedStatements: rejected,
    failedRechecks: failedRechecks.map((e) => ({ id: e.id, ts: e.ts.toISOString(), lemmaId: e.lemmaId, reason: (e.payload as { reason?: string }).reason ?? "" })),
    failedAttempts: failedAttempts.map((a) => ({ ...a, endedAt: a.endedAt?.toISOString() ?? null })),
    failedAttemptsTotal: Number(n),
  };
}
