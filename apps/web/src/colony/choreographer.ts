/**
 * The colony choreographer: turns the desk's event log into pet actions (BUILD_PROMPT.md section 9).
 *
 * Rules that make the world honest:
 *  - A pet changes what it does ONLY because of an event from the database (`cause` = event id), or
 *    because an action that such an event started has finished (then it returns to its camp).
 *  - Events are applied strictly in id order. Events for a pet that is busy wait in that pet's queue.
 *    A pet that walked to the judge waits there until the real verdict event arrives: the
 *    choreography never runs ahead of reality.
 *  - Idle pets stand still. Thinking dots + bounce only while the lease heartbeat is fresh.
 *  - Bubbles show only `messages.short` (carried in the event payload), never invented text.
 */
import { BIG_INFLOW_USD, HEARTBEAT_ACTIVE_MS, levelFor, petIdentity } from "@hatchery/shared";
import { BOWL_SPOTS, campOf, campSpot, JUDGE, nestSlot, WH, WW } from "./layout";
import type { Look } from "./sprites";

export interface SnapshotAgent {
  id: string;
  name: string;
  species: string;
  shell: string;
  kind: "internal" | "external";
  level: number;
  checkedTotal: number;
  active: boolean;
  lemmaId: string | null;
  lastHeartbeat: string | null;
  sleeping: boolean;
  sleepReason: string | null;
  camp: string | null;
  food: number;
}

export interface Snapshot {
  asOfEventId: number;
  serverTime: string;
  programs: { slug: string; idPrefix: string; checked: number; total: number }[];
  agents: SnapshotAgent[];
  pantry: { pantryUsd: string; runwayDays: number | null; hungry: boolean };
}

export interface RawEvent {
  id: number;
  ts: string;
  type: string;
  agentId: string | null;
  lemmaId: string | null;
  payload: Record<string, unknown>;
}

export type Act =
  | "idle" // standing at its camp spot
  | "toCamp"
  | "toJudge"
  | "atJudge" // waiting for the verdict event
  | "celebrate"
  | "toCheer"
  | "cheer"
  | "toTalk"
  | "talk"
  | "toNest"
  | "nap"
  | "toBowl"
  | "eat";

const MOVING: Act[] = ["toCamp", "toJudge", "toCheer", "toTalk", "toNest", "toBowl"];
const TIMED: Act[] = ["celebrate", "cheer", "talk", "eat"];
const SPEED = 2; // logical pixels per frame
/** Teammates who run over to cheer a checked proof (the nearest ones). */
export const MAX_CHEERERS = 4;
export const FRAME_MS = 100; // 10 frames per second

export interface Pet {
  id: string;
  name: string;
  species: string;
  shell: string;
  external: boolean;
  index: number;
  camp: string | null;
  lemmaId: string | null;
  checked: number;
  level: number;
  food: number;
  /** Server time of the latest heartbeat (lease heartbeat, or a model call made under the lease). */
  heartbeatAt: number | null;
  sleeping: boolean;
  sleepReason: string | null;
  x: number;
  y: number;
  tx: number;
  ty: number;
  act: Act;
  timer: number;
  carry: boolean;
  sadFrames: number;
  /** Event id that started the current action (null: the state came from the snapshot). */
  cause: number | null;
  queue: RawEvent[];
  /** After arriving somewhere (talk / handoff), who it is talking to. */
  partner: string | null;
}

export interface Bubble {
  petId: string;
  text: string;
  frames: number;
  cause: number;
  messageId: number | null;
}

export interface TraceEntry {
  frame: number;
  petId: string | null;
  what: string;
  cause: number | null;
}

export class Choreographer {
  pets = new Map<string, Pet>();
  bubbles: Bubble[] = [];
  private bubbleQueue: Bubble[] = [];
  gate: { type: "pass" | "reject" | null; frames: number; cause: number | null } = { type: null, frames: 0, cause: null };
  programs = new Map<string, { slug: string; idPrefix: string; checked: number; total: number }>();
  pantry: Snapshot["pantry"];
  lastEventId: number;
  frame = 0;
  /** Recent transitions with their causes (debug overlay, tests). */
  trace: TraceEntry[] = [];
  private clockOffsetMs: number;

  constructor(s: Snapshot, private nowMs: () => number = () => Date.now()) {
    this.lastEventId = s.asOfEventId;
    this.pantry = s.pantry;
    this.clockOffsetMs = new Date(s.serverTime).getTime() - this.nowMs();
    for (const p of s.programs) this.programs.set(p.slug, { ...p });
    for (const a of s.agents) if (a.active) this.addPet(a);
  }

  /** Server "now", from the browser clock corrected by the snapshot's server time. */
  serverNow(): number {
    return this.nowMs() + this.clockOffsetMs;
  }

  private log(petId: string | null, what: string, cause: number | null) {
    this.trace.push({ frame: this.frame, petId, what, cause });
    if (this.trace.length > 2000) this.trace.splice(0, this.trace.length - 2000);
  }

  private addPet(a: SnapshotAgent | { id: string }): Pet {
    const full: SnapshotAgent =
      "name" in a
        ? a
        : { ...petIdentity(a.id), id: a.id, name: petIdentity(a.id).displayName, shell: petIdentity(a.id).shellColor, kind: "internal", level: 1, checkedTotal: 0, active: true, lemmaId: null, lastHeartbeat: null, sleeping: false, sleepReason: null, camp: null, food: 1 };
    const index = this.pets.size;
    const spot = full.sleeping ? nestSlot(this.napCount()) : campSpot(full.camp, index);
    const pet: Pet = {
      id: full.id, name: full.name, species: full.species, shell: full.shell, external: full.kind === "external", index,
      camp: full.camp, lemmaId: full.lemmaId, checked: full.checkedTotal, level: full.level, food: full.food,
      heartbeatAt: full.lastHeartbeat ? new Date(full.lastHeartbeat).getTime() : null,
      sleeping: full.sleeping, sleepReason: full.sleepReason,
      x: spot.x, y: spot.y, tx: spot.x, ty: spot.y, act: full.sleeping ? "nap" : "idle", timer: 0, carry: false, sadFrames: 0,
      cause: null, queue: [], partner: null,
    };
    this.pets.set(pet.id, pet);
    return pet;
  }

  private napCount() {
    let n = 0;
    for (const p of this.pets.values()) if (p.act === "nap" || p.act === "toNest") n++;
    return n;
  }

  private programOfLemma(lemmaId: string | null): string | null {
    if (!lemmaId) return null;
    const prefix = /^L-([a-z0-9]+)-/.exec(lemmaId)?.[1];
    for (const p of this.programs.values()) if (p.idPrefix === prefix) return p.slug;
    return null;
  }

  private goto(p: Pet, act: Act, x: number, y: number, cause: number | null) {
    p.act = act;
    p.tx = Math.max(7, Math.min(WW - 7, Math.round(x)));
    p.ty = Math.max(12, Math.min(WH - 2, Math.round(y)));
    p.cause = cause;
    this.log(p.id, act, cause);
  }

  private goCamp(p: Pet, cause: number | null) {
    const s = campSpot(p.camp, p.index);
    this.goto(p, "toCamp", s.x, s.y, cause);
  }

  private bubble(petId: string, text: unknown, cause: number, messageId: unknown) {
    if (typeof text !== "string" || !text) return;
    const b: Bubble = { petId, text, frames: 32, cause, messageId: typeof messageId === "number" ? messageId : null };
    if (this.bubbles.length < 4) this.bubbles.push(b);
    else this.bubbleQueue.push(b);
    this.log(petId, `bubble:${text}`, cause);
  }

  /** A pet is free to start a new action when it is standing at its camp or napping. */
  private free(p: Pet) {
    return p.act === "idle" || p.act === "nap";
  }

  // ------------------------------------------------------------------ events

  /** Apply one event from the log. Must be called in id order; older ids are ignored. */
  apply(e: RawEvent): void {
    if (e.id <= this.lastEventId) return;
    this.lastEventId = e.id;
    if (e.type === "pantry_inflow") return this.onInflow(e);
    // The desk's low-food alert (same rule as the snapshot's `hungry`): every pet shows "!" until it clears.
    if (e.type === "pantry_low" || e.type === "pantry_ok") {
      this.pantry = { ...this.pantry, hungry: e.type === "pantry_low" };
      return this.log("*", e.type === "pantry_low" ? "hungry" : "fed", e.id);
    }
    if (e.type === "checked" && e.lemmaId) {
      const prog = this.programs.get(this.programOfLemma(e.lemmaId) ?? "");
      if (prog) prog.checked++;
    }
    if (e.type === "statement_approved" && e.lemmaId) {
      const prog = this.programs.get(this.programOfLemma(e.lemmaId) ?? "");
      if (prog) prog.total++;
    }
    if (!e.agentId) return;
    let p = this.pets.get(e.agentId);
    if (!p) {
      if (e.type === "agent_registered" || e.type === "leased" || e.type === "model_call") p = this.addPet({ id: e.agentId });
      else return;
    }
    // Heartbeat evidence: a model call happens right after the lease heartbeat.
    if (e.type === "model_call" || e.type === "attempt_started") p.heartbeatAt = Math.max(p.heartbeatAt ?? 0, new Date(e.ts).getTime());
    if (e.type === "local_check" && e.payload.ok === false) {
      p.sadFrames = 30; // a mood, not a move: shown at once
      this.log(p.id, "sad", e.id);
    }
    // Verdicts resolve a pet waiting at the judge.
    if ((e.type === "checked" || e.type === "judge_rejected") && p.act === "atJudge") return this.verdict(p, e);
    if (this.free(p)) this.start(p, e);
    else p.queue.push(e);
  }

  /** Start the action an event asks for (the pet is free). */
  private start(p: Pet, e: RawEvent): void {
    switch (e.type) {
      case "agent_registered":
        return;
      case "leased": {
        p.lemmaId = e.lemmaId;
        p.camp = this.programOfLemma(e.lemmaId) ?? p.camp;
        p.sleeping = false;
        p.heartbeatAt = new Date(e.ts).getTime();
        return this.goCamp(p, e.id);
      }
      case "model_call":
      case "attempt_started":
        if (p.sleeping || p.act === "nap") {
          p.sleeping = false;
          return this.goCamp(p, e.id); // woke up
        }
        return;
      case "submitted":
        p.carry = true;
        return this.goto(p, "toJudge", JUDGE.x + ((p.index % 5) - 2) * 3, JUDGE.y, e.id);
      case "checked":
      case "judge_rejected":
        // The pet was not at the judge (e.g. the submission happened before the snapshot): show the verdict in place.
        return this.verdict(p, e);
      case "sleeping":
        p.sleeping = true;
        p.sleepReason = typeof e.payload.reason === "string" ? e.payload.reason : null;
        {
          const s = nestSlot(this.napCount());
          return this.goto(p, "toNest", s.x, s.y, e.id);
        }
      case "lease_expired":
      case "released":
      case "abandoned_by_agent":
        p.lemmaId = null;
        p.carry = false;
        return this.goCamp(p, e.id);
      case "question_asked": {
        const to = Array.isArray(e.payload.routedTo) ? (e.payload.routedTo as string[]).find((id) => this.pets.has(id)) : undefined;
        return this.visit(p, to ?? null, e, false);
      }
      case "reply_posted":
        return this.visit(p, typeof e.payload.toAgent === "string" ? e.payload.toAgent : null, e, false);
      case "handoff":
        return this.visit(p, typeof e.payload.toAgent === "string" ? e.payload.toAgent : null, e, true);
      default:
        return; // feed-only events (statements, reuse, re-checks, ...)
    }
  }

  /** Walk to another pet and say the message there (or say it in place if they are not in the world). */
  private visit(p: Pet, toId: string | null, e: RawEvent, scroll: boolean) {
    const q = toId ? this.pets.get(toId) : undefined;
    if (!q || q === p) {
      this.bubble(p.id, e.payload.short, e.id, e.payload.messageId);
      if (scroll) p.lemmaId = null;
      return;
    }
    p.carry = scroll;
    p.partner = q.id;
    this.goto(p, "toTalk", q.x + (p.x < q.x ? -9 : 9), q.y, e.id);
    (p as Pet & { pending?: RawEvent }).pending = e;
  }

  private verdict(p: Pet, e: RawEvent) {
    p.carry = false;
    if (e.type === "checked") {
      this.gate = { type: "pass", frames: 12, cause: e.id };
      this.log(null, "gate:pass", e.id);
      p.checked++;
      p.level = levelFor(p.checked);
      p.lemmaId = null;
      p.act = "celebrate";
      p.timer = 16;
      p.cause = e.id;
      this.log(p.id, "celebrate", e.id);
      // Teammates (same camp, or nearby) run over and cheer: the nearest few, so a big camp does not pile up.
      const mates = [...this.pets.values()]
        .filter((q) => q !== p && this.free(q) && !q.sleeping && (q.camp === p.camp || Math.hypot(q.x - p.x, q.y - p.y) < 50))
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))
        .slice(0, MAX_CHEERERS);
      mates.forEach((q, i) => {
        const side = i % 2 ? -1 : 1;
        this.goto(q, "toCheer", JUDGE.x + side * (14 + Math.floor(i / 2) * 7), 66 + (i % 2) * 3, e.id);
      });
    } else {
      this.gate = { type: "reject", frames: 10, cause: e.id };
      this.log(null, "gate:reject", e.id);
      p.sadFrames = 30;
      this.goCamp(p, e.id);
    }
  }

  private onInflow(e: RawEvent) {
    if (Number(e.payload.amountUsd) < BIG_INFLOW_USD) return;
    let i = 0;
    for (const p of this.pets.values()) {
      if (!this.free(p) || p.sleeping) continue;
      const s = BOWL_SPOTS[i++ % BOWL_SPOTS.length]!;
      this.goto(p, "toBowl", s.x + ((p.index % 3) - 1) * 2, s.y, e.id);
    }
  }

  // ------------------------------------------------------------------ frames

  /** Advance one frame (FRAME_MS): movement, timers, queued events. */
  step(): void {
    this.frame++;
    for (const p of this.pets.values()) {
      if (p.sadFrames > 0) p.sadFrames--;
      if (MOVING.includes(p.act)) {
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const d = Math.hypot(dx, dy);
        if (d <= SPEED) {
          p.x = p.tx;
          p.y = p.ty;
          this.arrive(p);
        } else {
          p.x += (dx / d) * SPEED;
          p.y += (dy / d) * SPEED;
        }
      } else if (TIMED.includes(p.act)) {
        if (--p.timer <= 0) this.goCamp(p, p.cause);
      }
      if (this.free(p) && p.queue.length) this.start(p, p.queue.shift()!);
      else if (p.act === "atJudge" && p.queue.length && (p.queue[0]!.type === "checked" || p.queue[0]!.type === "judge_rejected")) {
        this.verdict(p, p.queue.shift()!);
      }
    }
    if (this.gate.frames > 0 && --this.gate.frames === 0) this.gate = { type: null, frames: 0, cause: null };
    for (const b of this.bubbles) b.frames--;
    this.bubbles = this.bubbles.filter((b) => b.frames > 0);
    while (this.bubbles.length < 4 && this.bubbleQueue.length) this.bubbles.push(this.bubbleQueue.shift()!);
  }

  private arrive(p: Pet) {
    switch (p.act) {
      case "toCamp":
        p.act = "idle";
        return;
      case "toJudge":
        p.act = "atJudge"; // waits here for the verdict event
        return;
      case "toCheer":
        p.act = "cheer";
        p.timer = 14;
        return;
      case "toNest":
        p.act = "nap";
        return;
      case "toBowl":
        p.act = "eat";
        p.timer = 14;
        return;
      case "toTalk": {
        const e = (p as Pet & { pending?: RawEvent }).pending;
        if (e) {
          this.bubble(p.id, e.payload.short, e.id, e.payload.messageId);
          if (e.type === "handoff") {
            p.carry = false;
            p.lemmaId = null;
          }
        }
        delete (p as Pet & { pending?: RawEvent }).pending;
        p.act = "talk";
        p.timer = 30;
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ looks and refreshes

  /** What the pet looks like right now (moods only from real state). */
  look(p: Pet): Look {
    if (p.act === "nap" || p.act === "toNest") return "sleeping";
    if (p.act === "celebrate" || p.act === "cheer") return "celebrate";
    if (p.sadFrames > 0) return "sad";
    if (p.act === "talk") return "talk";
    if (MOVING.includes(p.act)) return "walk";
    if (this.pantry.hungry) return "hungry";
    if (p.lemmaId && this.heartbeatFresh(p)) return "working";
    return "idle";
  }

  heartbeatFresh(p: Pet): boolean {
    return p.heartbeatAt !== null && this.serverNow() - p.heartbeatAt < HEARTBEAT_ACTIVE_MS;
  }

  /** Merge slow-changing facts from a fresh snapshot (food, levels, heartbeats, pantry). Never moves a pet. */
  refresh(s: Snapshot): void {
    this.pantry = s.pantry;
    this.clockOffsetMs = new Date(s.serverTime).getTime() - this.nowMs();
    for (const p of s.programs) this.programs.set(p.slug, { ...p });
    for (const a of s.agents) {
      const p = this.pets.get(a.id);
      if (!p) {
        if (a.active && s.asOfEventId <= this.lastEventId) this.addPet(a);
        continue;
      }
      p.food = a.food;
      p.checked = Math.max(p.checked, a.checkedTotal);
      p.level = levelFor(p.checked);
      if (a.lastHeartbeat) p.heartbeatAt = Math.max(p.heartbeatAt ?? 0, new Date(a.lastHeartbeat).getTime());
      if (!a.active && this.free(p) && !p.queue.length) this.pets.delete(a.id); // the process is gone
    }
  }

  /** Short status line for the roster and the card. */
  status(p: Pet): string {
    const L = p.lemmaId ?? "its lemma";
    switch (p.act) {
      case "nap":
      case "toNest":
        return p.sleepReason === "pantry_empty" ? "Napping: the pantry is empty" : p.sleepReason === "kill_switch" ? "Napping: the colony is paused" : p.sleepReason === "global_cap" ? "Napping: today's colony budget is used" : "Napping: today's food cap is used";
      case "toJudge":
      case "atJudge":
        return `Taking ${L} to the Lean judge`;
      case "celebrate":
        return "Proof checked!";
      case "toCheer":
      case "cheer":
        return "Cheering for a teammate";
      case "toTalk":
      case "talk":
        return "Talking with a teammate";
      case "toBowl":
      case "eat":
        return "Grabbing a snack from the pantry";
      case "toCamp":
        return p.lemmaId ? `Heading to ${L}` : "Heading back to camp";
    }
    if (p.sadFrames > 0) return `Lean said no. Trying again on ${L}`;
    if (p.lemmaId) return this.heartbeatFresh(p) ? `Working on ${p.lemmaId}` : `Holding ${p.lemmaId} (no heartbeat in the last 2 minutes)`;
    return "Waiting for an open lemma";
  }

  campOf(p: Pet) {
    return campOf(p.camp);
  }
}
