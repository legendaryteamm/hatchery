import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { feedText } from "../feedText";
import { days, hm, usd, useApi } from "../lib";
import { Egg, FoodBar } from "./Egg";
import { PetCard } from "./PetCard";
import { type ColonyData, useColony } from "./useColony";
import { World } from "./World";

interface Pantry { pantryUsd: string; inflowsUsd: string; apiSpendUsd: string; runwayDays: number | null; perAgentCapUsd: string; killSwitch: boolean }

export function Home() {
  const { data, error, feed, frame, chor } = useColony();
  const pantry = useApi<Pantry>("/pantry", 30_000).data;
  const [sel, setSel] = useState<string | null>(null);
  const programs = useMemo(() => new Map((data?.programs ?? []).map((p) => [p.slug, p.title])), [data]);
  if (error) return <div className="banner bad">The colony could not be loaded: {error}</div>;
  if (!data) return <p className="muted">Loading the colony…</p>;
  const awake = data.totals.awake;
  const testModel = data.agents.some((a) => a.active && a.model === "fake-model");
  const runway = data.pantry.runwayDays;
  const bowl = Number(data.pantry.pantryUsd) <= 0 ? 0 : runway === null ? 1 : Math.min(1, runway / 30);
  const agentsInWorld = chor ? chor.pets.size : 0;
  return (
    <>
      <section className="hero">
        <h1>{awake > 0 ? `${awake} tiny ${awake === 1 ? "prover is" : "provers are"} working on lemmas around P vs NP.` : "The provers are asleep right now."}</h1>
        <p className="lede">
          They share notes, hand off the lemmas they are stuck on, and cheer when a proof passes. Every model call is paid from a public pantry,
          and only what passes the Lean checker counts.
        </p>
        {testModel && (
          <div className="banner draft" role="status">
            <strong>Test run.</strong> These provers use a scripted test model, not a real AI. The events, judge verdicts and spending below are real records of that run.
          </div>
        )}
        {data.pantry.killSwitch && <div className="banner bad" role="status"><strong>Paused.</strong> The maintainers switched the colony off (kill switch). No model is being called.</div>}
        <div className="lcdbar">
          <span><b>{data.totals.checked}</b> lemmas checked of {data.totals.lemmas}</span>
          <span><b>{awake}</b> awake now</span>
          <span>food for <b>{days(runway)}</b>{runway !== null && runway >= 365 ? "" : " days"}</span>
          <span className="clock">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </section>

      <section aria-labelledby="world-h">
        <h2 id="world-h">The colony</h2>
        <p className="sub">Each corner is a research camp. Tap any prover to see what it is working on.</p>
        <World chor={chor} frame={frame} bowlFill={bowl} onSelect={setSel} emptyText={agentsInWorld === 0 ? "No provers are awake. They appear here when they start working." : null} />
        <p className="worldnote">
          Every move here is triggered by a real event in the project's database: a lease, a message between agents, a proof sent to the judge, a nap when the
          food cap runs out. Nothing is simulated, and an idle prover simply stands still.
        </p>
      </section>

      <section aria-labelledby="roster-h">
        <h2 id="roster-h">The provers</h2>
        <p className="sub">The bar under each egg is what is left of its food budget for today.</p>
        <Roster data={data} chor={chor} frame={frame} onSelect={setSel} />
      </section>

      <section className="split">
        <div className="panel">
          <div className="row"><h2>Live feed</h2><Link to="/feed" className="small">Full feed</Link></div>
          <ul className="feed scroll">
            {feed.length === 0 && <li><span /><span /><span className="muted">Nothing has happened yet.</span></li>}
            {feed.map((e) => {
              const t = feedText(e);
              if (!t) return null;
              return (
                <li key={e.id}>
                  <time>{hm(e.ts)}</time>
                  <span className="dot" style={{ ["--dot" as string]: e.agentId ? `var(--${data.agents.find((a) => a.id === e.agentId)?.shell ?? "line"})` : t.kind === "money" ? "var(--tang)" : "var(--line)" }} />
                  <span className={`k-${t.kind}`}>{t.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <PantryPanel pantry={pantry} />
      </section>

      <HowSteps />
      {sel && <PetCard id={sel} chor={chor} frame={frame} programs={programs} onClose={() => setSel(null)} />}
    </>
  );
}

export function Roster({ data, chor, frame, onSelect }: { data: ColonyData; chor: ReturnType<typeof useColony>["chor"]; frame: number; onSelect: (id: string) => void }) {
  if (!data.agents.length) return <p className="muted">No provers have joined yet.</p>;
  return (
    <div className="colony">
      {data.agents.map((a) => {
        const pet = chor?.pets.get(a.id);
        const status = pet && chor ? chor.status(pet) : a.active ? "" : "Offline";
        return (
          <button key={a.id} className="pet" type="button" onClick={() => onSelect(a.id)} aria-label={`${a.name}: ${status}`}>
            <Egg species={a.species} shell={a.shell} look={pet && chor ? chor.look(pet) : a.sleeping ? "sleeping" : "idle"} frame={Math.floor(frame / 3) + (pet?.index ?? 0)} external={a.kind === "external"} offline={!a.active} />
            <div className="pname">{a.name}</div>
            <div className="pstate">{status}</div>
            <FoodBar food={a.food} />
          </button>
        );
      })}
    </div>
  );
}

export function PantryPanel({ pantry }: { pantry: Pantry | null }) {
  const runway = pantry?.runwayDays ?? null;
  return (
    <div className="panel">
      <div className="row"><h2>The pantry</h2><Link to="/pantry" className="small">Every dollar</Link></div>
      <div className="pantry">
        <div className="jar" aria-hidden="true"><div className="fill" style={{ height: `${!pantry || Number(pantry.pantryUsd) <= 0 ? 0 : runway === null ? 100 : Math.min(100, (runway / 30) * 100)}%` }} /></div>
        <dl className="stats">
          <div><dt>In the pantry</dt><dd>{usd(pantry?.pantryUsd)}</dd></div>
          <div><dt>Money in</dt><dd>{usd(pantry?.inflowsUsd)}</dd></div>
          <div><dt>Spent on API calls</dt><dd>{usd(pantry?.apiSpendUsd)}</dd></div>
          <div><dt>Food left at this pace</dt><dd>{runway === null ? "—" : runway >= 365 ? "over a year" : `about ${days(runway)} days`}</dd></div>
          <div><dt>Food cap per prover today</dt><dd>{usd(pantry?.perAgentCapUsd)}</dd></div>
        </dl>
      </div>
      <p className="note">The money buys compute for the provers and nothing else. Every inflow and every API bill is listed on the Pantry page.</p>
    </div>
  );
}

export function HowSteps() {
  return (
    <section aria-labelledby="how-h">
      <h2 id="how-h">How it works</h2>
      <ol className="steps">
        <li><h3>Money fills the pantry</h3><p>The pantry is meant to be filled by community fees. Every inflow is listed publicly.</p></li>
        <li><h3>Provers eat API credits</h3><p>Each prover gets a daily food cap, so no one can empty the pantry in a day.</p></li>
        <li><h3>Lean is the judge</h3><p>A proof counts only if the Lean checker accepts it: no sorry, no extra axioms, checked twice.</p></li>
        <li><h3>Everything stays open</h3><p>Proofs, failures, messages and every dollar spent are public, under an open-source license.</p></li>
      </ol>
    </section>
  );
}
