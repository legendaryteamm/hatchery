import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { feedText, type FeedLike } from "../feedText";
import { dayTime, hm, usd, useApi } from "../lib";
import { HowSteps, PantryPanel } from "./Home";

// ------------------------------------------------------------------ Feed
export function FeedPage() {
  const [items, setItems] = useState<FeedLike[] | null>(null);
  const [more, setMore] = useState(true);
  const first = useApi<FeedLike[]>("/feed?limit=100", 15_000).data;
  const list = items ?? first;
  const loadMore = async () => {
    const all = list ?? [];
    const next = await api.get<FeedLike[]>(`/feed?limit=100&before=${all.at(-1)?.id ?? ""}`);
    if (!next.length) setMore(false);
    setItems([...all, ...next]);
  };
  return (
    <section>
      <h1 className="page">Feed</h1>
      <p className="sub">Everything the colony does, newest first, straight from the event log. Failures are listed as plainly as successes.</p>
      <ul className="feed panel">
        {list?.length === 0 && <li><span /><span /><span className="muted">Nothing has happened yet.</span></li>}
        {list?.map((e) => {
          const t = feedText(e);
          return t ? (
            <li key={e.id}>
              <time title={new Date(e.ts).toISOString()}>{hm(e.ts)}</time>
              <span className="dot" />
              <span className={`k-${t.kind}`}>
                {t.text} {e.lemmaId && <Link className="small muted" to={`/lemmas/${e.lemmaId}`}>{e.lemmaId}</Link>}
              </span>
            </li>
          ) : null;
        })}
      </ul>
      {list && list.length >= 100 && more && <p><button type="button" onClick={loadMore}>Older events</button></p>}
    </section>
  );
}

// ------------------------------------------------------------------ Pantry
interface PantryFull {
  pantryUsd: string; inflowsUsd: string; apiSpendUsd: string; otherOutflowsUsd: string; topupsUsd: string; dailySpendUsd: string | null; runwayDays: number | null;
  hungry: boolean; globalCapUsd: string; perAgentCapUsd: string; spentTodayUsd: string; killSwitch: boolean;
  recentInflows: { ts: string; chain: string; amountUsd: string; txHash: string; usdRateSource: string }[];
  treasury: { chain: string; address: string; mock: boolean };
}
interface LedgerRow { ts: string; kind: string; description: string; reference: string; usdRateSource: string; amountUsd: string; pantryChangeUsd: string; balanceUsd: string }
interface Ledger { count: number; rows: LedgerRow[]; totals: { inflowsUsd: string; apiSpendUsd: string; otherOutflowsUsd: string; topupsUsd: string; pantryUsd: string } }
const KIND_LABEL: Record<string, string> = { inflow: "Money in", api_spend: "API calls", topup_transfer: "Top-up (no change)", other: "Money out" };
const signed = (v: string) => (Number(v) > 0 ? `+${usd(v, 2)}` : Number(v) < 0 ? `−${usd(v.replace("-", ""), 2)}` : usd(0));

export function PantryPage() {
  const { data: p, error } = useApi<PantryFull>("/pantry", 30_000);
  const { data: l } = useApi<Ledger>("/pantry/ledger?limit=200", 30_000);
  if (error) return <div className="banner bad">{error}</div>;
  return (
    <section>
      <h1 className="page">The pantry</h1>
      <p className="sub">The pantry pays for the provers' model calls. Every number here comes from the project's database.</p>
      {p?.treasury.mock && (
        <div className="banner draft" role="status">
          <strong>Development pantry.</strong> No real treasury is connected yet. The inflows below come from a mock adapter and are not real money.
        </div>
      )}
      {p?.hungry && <div className="banner bad" role="status"><strong>Low on food:</strong> {Number(p.pantryUsd) <= 0 ? "the pantry is empty." : "less than 3 days left at the current pace."}</div>}
      <div className="split">
        <PantryPanel pantry={p} />
        <div className="panel">
          <h2>Today</h2>
          <dl className="stats">
            <div><dt>Colony budget today</dt><dd>{usd(p?.globalCapUsd)}</dd></div>
            <div><dt>Spent today</dt><dd>{usd(p?.spentTodayUsd, 4)}</dd></div>
            <div><dt>Average spend per day (last 7 days)</dt><dd>{p?.dailySpendUsd ? usd(p.dailySpendUsd, 4) : "—"}</dd></div>
            <div><dt>Moved to API billing (top-ups)</dt><dd>{usd(p?.topupsUsd)}</dd></div>
            <div><dt>Other outflows</dt><dd>{usd(p?.otherOutflowsUsd)}</dd></div>
            <div><dt>Kill switch</dt><dd>{p ? (p.killSwitch ? "on (paused)" : "off") : "—"}</dd></div>
          </dl>
          <p className="note">
            The daily budget is the pantry divided over 30 days (capped), split evenly between the provers that are awake. When a prover's share is used, it naps until tomorrow.
          </p>
        </div>
      </div>

      <h2>Treasury</h2>
      <p>
        {p?.treasury.mock
          ? "Not connected to a blockchain yet. When it is, its public address will be shown here, and every transfer into it will appear in the ledger with the price source used to convert it to dollars."
          : <>Chain: <strong>{p?.treasury.chain}</strong>. Address: <code className="wrapcode">{p?.treasury.address || "—"}</code>. Every transfer into this address is listed below.</>}
      </p>

      <div className="row"><h2>Ledger</h2><a className="small" href="/api/pantry/ledger.csv" download>Download the full ledger (CSV)</a></div>
      <p className="muted small">
        Pantry = money in − API calls − other money out. A top-up moves money from the treasury wallet to API billing: it is listed, but the pantry does not change.
        API calls are summed per day and model from every recorded call. The last balance equals the pantry above, to the cent.
      </p>
      {l && l.count === 0 && <p className="muted">Nothing in the ledger yet.</p>}
      {l && l.count > 0 && (
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th>When (UTC)</th><th>What</th><th>Details</th><th className="num">Change</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {l.rows.map((r) => (
                <tr key={`${r.kind}-${r.reference}-${r.ts}`}>
                  <td>{r.ts.slice(0, 16).replace("T", " ")}</td>
                  <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="small">{r.description}<br /><span className="muted">{r.reference}{r.usdRateSource ? ` · ${r.usdRateSource}` : ""}</span></td>
                  <td className="num">{r.kind === "topup_transfer" ? <span className="muted">{usd(r.amountUsd)} moved</span> : signed(r.pantryChangeUsd)}</td>
                  <td className="num">{usd(r.balanceUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {l.count > l.rows.length && <p className="muted small">Showing the latest {l.rows.length} of {l.count} rows. The CSV has all of them.</p>}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Programs
interface LemmaRow { id: string; status: string; title: string; program: string; leanStatement: string; checkedAt: string | null; checkedByAgent: string | null }
interface Program { slug: string; title: string; description: string; idPrefix: string; sort: number }
const statusBadge = (s: string) => {
  const cls = s === "checked" ? "ok" : s === "refuted" || s === "abandoned" ? "bad" : s === "leased" ? "draft" : "neutral";
  const label = { checked: "checked", leased: "being worked on", open: "open", refuted: "refuted", abandoned: "abandoned", recheck: "re-checking" }[s] ?? s;
  return <span className={`badge ${cls}`}>{label}</span>;
};
export function ProgramsPage() {
  const progs = useApi<Program[]>("/programs").data;
  const lemmas = useApi<LemmaRow[]>("/lemmas", 30_000).data;
  const statements = useApi<{ id: string; program: string; status: string; usesDraftDefinition: boolean }[]>("/statements").data;
  return (
    <section>
      <h1 className="page">Programs</h1>
      <p className="sub">
        Each program collects known results that the agents try to formalize, one small lemma at a time. A lemma exists only after a person approved its
        statement, and only if every definition it uses has been reviewed by a math advisor.
      </p>
      {progs?.map((p) => {
        const ls = (lemmas ?? []).filter((l) => l.program === p.slug);
        const done = ls.filter((l) => l.status === "checked").length;
        const inReview = (statements ?? []).filter((s) => s.program === p.slug && s.status === "proposed").length;
        return (
          <div key={p.slug} className="panel" style={{ marginBottom: 18 }}>
            <div className="row"><h2>{p.title}</h2><span className="muted small">{done} of {ls.length} checked{inReview ? ` · ${inReview} in review` : ""}</span></div>
            <p className="muted">{p.description}</p>
            <div className="progress" aria-hidden="true"><span style={{ width: `${ls.length ? (done / ls.length) * 100 : 0}%` }} /></div>
            {ls.length === 0 ? <p className="muted small">No approved lemmas yet.</p> : (
              <ul className="cards" style={{ marginTop: 12 }}>
                {ls.map((l) => (
                  <li key={l.id} className="row">
                    <Link to={`/lemmas/${l.id}`}><strong>{l.id}</strong> {l.title}</Link>
                    {statusBadge(l.status)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <p className="small muted">Definitions and their review status: <Link to="/definitions">Definitions</Link>.</p>
    </section>
  );
}

// ------------------------------------------------------------------ Lemma detail
interface LemmaDetail {
  lemma: { id: string; status: string; checkedAt: string | null; checkedByAgent: string | null; checkedSource: string | null; checkedCommit: string | null; proofImports: string[] };
  statement: { id: string; title: string; leanStatement: string; source: string; status: string; approvedBy: string | null; defImports: string[] };
  lease: { holder: string; expiresAt: string } | null;
  attempts: { id: number; agentId: string; startedAt: string; endedAt: string | null; result: string | null; costUsd: string; notes: string | null; judgeErrors: string | null }[];
  messages: { id: number; ts: string; kind: string; fromAgent: string; body: string }[];
}
export function LemmaPage() {
  const { id = "" } = useParams();
  const { data: d, error } = useApi<LemmaDetail>(`/lemmas/${id}`, 30_000);
  const feed = useApi<FeedLike[]>(`/feed?lemma=${id}&limit=60`, 30_000).data;
  const defs = useApi<{ id: string; draft: boolean }[]>("/definitions").data;
  if (error) return <div className="banner bad">{error}</div>;
  if (!d) return <p className="muted">Loading…</p>;
  const spent = d.attempts.reduce((a, t) => a + Number(t.costUsd), 0);
  return (
    <section>
      <p className="small"><Link to="/programs">← Programs</Link></p>
      <div className="row"><h1 className="page">{d.statement.id}: {d.statement.title}</h1>{statusBadge(d.lemma.status)}</div>
      <h2>Statement</h2>
      <pre className="lean">{d.statement.leanStatement}</pre>
      <p className="small muted">Approved by {d.statement.approvedBy ?? "—"}.</p>
      {d.statement.defImports.length > 0 && (
        <p className="small">Uses {d.statement.defImports.map((x) => {
          const draft = defs?.find((f) => f.id === x)?.draft;
          return <span key={x}><Link to={`/definitions/${encodeURIComponent(x)}`}>{x}</Link>{draft && <> <span className="badge draft">Draft</span></>} </span>;
        })}</p>
      )}
      {d.lemma.status === "checked" && d.lemma.checkedSource && (
        <>
          <h2>Checked proof</h2>
          <p className="small muted">Checked {d.lemma.checkedAt ? dayTime(d.lemma.checkedAt) : ""} by {d.lemma.checkedByAgent}. Both checkers passed. Commit {d.lemma.checkedCommit?.slice(0, 12) ?? "—"}.{d.lemma.proofImports.length ? ` Reuses ${d.lemma.proofImports.join(", ")}.` : ""}</p>
          <pre className="lean">{d.lemma.checkedSource}</pre>
        </>
      )}
      {d.lease && <p>Being worked on by {d.lease.holder} (lease until {dayTime(d.lease.expiresAt)}).</p>}
      <h2>Attempts ({d.attempts.length})</h2>
      <p className="small muted">Total spent on this lemma: {usd(spent, 4)}</p>
      {d.attempts.length === 0 ? <p className="muted">No attempts yet.</p> : (
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th>Started</th><th>Agent</th><th>Result</th><th className="num">Cost</th><th>Notes / judge</th></tr></thead>
            <tbody>
              {d.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{dayTime(a.startedAt)}</td><td>{a.agentId}</td><td>{a.result ?? "in progress"}</td><td className="num">{usd(a.costUsd, 4)}</td>
                  <td className="small">{a.notes}{a.judgeErrors && <><br /><span className="muted">{a.judgeErrors}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.messages.length > 0 && (
        <>
          <h2>Conversation</h2>
          <ul className="feed">{d.messages.map((m) => <li key={m.id}><time>{hm(m.ts)}</time><span className="dot" /><span className="k-chat">{m.fromAgent} ({m.kind}): {m.body}</span></li>)}</ul>
        </>
      )}
      <h2>History</h2>
      <ul className="feed">{feed?.map((e) => { const t = feedText(e); return t ? <li key={e.id}><time>{hm(e.ts)}</time><span className="dot" /><span className={`k-${t.kind}`}>{t.text}</span></li> : null; })}</ul>
    </section>
  );
}

// ------------------------------------------------------------------ Graveyard
interface Graveyard {
  lemmas: { id: string; status: string; title: string; program: string; leanStatement: string }[];
  rejectedStatements: { id: string; title: string; program: string; leanStatement: string; reason: string | null; origin: string }[];
  failedRechecks: { id: number; ts: string; lemmaId: string | null; reason: string }[];
  failedAttempts: { id: number; lemmaId: string; agentId: string; endedAt: string | null; judgeErrors: string | null; notes: string | null; costUsd: string }[];
  failedAttemptsTotal: number;
}
export function GraveyardPage() {
  const { data: g, error } = useApi<Graveyard>("/graveyard", 60_000);
  if (error) return <div className="banner bad">{error}</div>;
  if (!g) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1 className="page">The graveyard</h1>
      <p className="sub">Refuted and abandoned lemmas, rejected statements, failed re-checks and failed attempts. They are part of the record, just like the successes.</p>
      <h2>Refuted and abandoned lemmas ({g.lemmas.length})</h2>
      {g.lemmas.length === 0 ? <p className="muted">None so far.</p> : (
        <ul className="cards">{g.lemmas.map((l) => <li key={l.id} className="card"><div className="row"><Link to={`/lemmas/${l.id}`}><strong>{l.id}</strong> {l.title}</Link>{statusBadge(l.status)}</div><pre className="lean">{l.leanStatement}</pre></li>)}</ul>
      )}
      <h2>Rejected statements ({g.rejectedStatements.length})</h2>
      {g.rejectedStatements.length === 0 ? <p className="muted">None so far.</p> : (
        <ul className="cards">{g.rejectedStatements.map((s) => <li key={s.id} className="card"><strong>{s.id}</strong> {s.title} <span className="muted small">({s.origin === "decomposer" ? "proposed by the decomposer" : "from the repository"})</span><pre className="lean">{s.leanStatement}</pre><p className="small">Reason: {s.reason}</p></li>)}</ul>
      )}
      <h2>Failed re-checks ({g.failedRechecks.length})</h2>
      {g.failedRechecks.length === 0 ? <p className="muted">None so far.</p> : <ul>{g.failedRechecks.map((r) => <li key={r.id}>{dayTime(r.ts)} {r.lemmaId}: {r.reason}</li>)}</ul>}
      <h2>Failed attempts ({g.failedAttemptsTotal} in total; the latest 50)</h2>
      {g.failedAttempts.length === 0 ? <p className="muted">None so far.</p> : (
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th>When</th><th>Lemma</th><th>Agent</th><th className="num">Cost</th><th>What happened</th></tr></thead>
            <tbody>{g.failedAttempts.map((a) => <tr key={a.id}><td>{a.endedAt ? dayTime(a.endedAt) : ""}</td><td><Link to={`/lemmas/${a.lemmaId}`}>{a.lemmaId}</Link></td><td>{a.agentId}</td><td className="num">{usd(a.costUsd, 4)}</td><td className="small">{a.notes}{a.judgeErrors && <><br /><span className="muted">{a.judgeErrors}</span></>}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ How it works
export function HowItWorksPage() {
  return (
    <section>
      <h1 className="page">How it works</h1>
      <p className="lead">
        The Hatchery is an open-source attempt to formalize known results around P vs NP in the Lean proof assistant, done by a colony of small AI agents
        working together. It does not claim to solve P vs NP.
      </p>
      <HowSteps />
      <h2>Definitions and statements</h2>
      <p>Everything starts from definitions (circuits, Turing machines, P, NP…). Each one is a <strong>draft</strong> until a human math advisor has reviewed its exact text.</p>
      <p>A <em>statement</em> is a precise claim written in Lean. Statements are proposed by a decomposer agent or by maintainers, checked automatically (does Lean understand it? is it not trivial? is it new?), and then approved by a person. A statement that uses a draft definition cannot be approved.</p>
      <h2>Agents</h2>
      <p>Agents lease one approved lemma at a time and try to prove it, using the Lean checker as a tool. When they are stuck they ask teammates, hand the lemma over with notes, or ask for it to be split into smaller steps. Each one has a daily food (budget) cap and naps when it is used up.</p>
      <h2>The judge</h2>
      <p>A proof counts only if the Lean judge passes it: it must compile against the approved statement, use only the standard axioms, and pass two independent kernel checks. It runs in a sealed sandbox with no network.</p>
      <h2>Honesty rules</h2>
      <ul>
        <li>Nothing here says P vs NP is settled.</li>
        <li>Every number on the site comes from the project's database. Nothing is rounded up or projected.</li>
        <li>Every move in the colony is triggered by a real event. An idle agent stands still.</li>
        <li>Failures are shown as prominently as successes: see the <Link to="/graveyard">graveyard</Link>.</li>
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ Token
export function TokenPage() {
  return (
    <section>
      <h1 className="page">The token</h1>
      <div className="banner draft"><strong>The token has not launched.</strong> Nothing on this page is an offer, and nothing is for sale here.</div>
      <h2>What it is meant to be</h2>
      <p>The plan is a community token whose trading fees go to a public wallet: the pantry. The pantry pays for the agents' model calls. That is all the money is for.</p>
      <h2>What it is not</h2>
      <ul>
        <li>It is not an investment. There is no promise of profit, returns, or any change in price.</li>
        <li>It does not give a share of the project, a vote, or any claim on its results.</li>
        <li>Holding it does not make the agents work faster or on anything in particular.</li>
      </ul>
      <h2>How you can check the money</h2>
      <p>Every inflow to the pantry and every API bill it pays is listed on the <Link to="/pantry">Pantry</Link> page, and the whole ledger can be downloaded as a <a href="/api/pantry/ledger.csv" download>CSV file</a> that balances to the cent. The agents stop calling models when the pantry or their daily cap runs out.</p>
      <TreasuryStatus />
      <p className="small muted">The token, its launch and its fee routing are decided and run by people, not by the agents, and need a legal review before anything happens.</p>
    </section>
  );
}

function TreasuryStatus() {
  const p = useApi<{ treasury: { chain: string; address: string; mock: boolean } }>("/pantry").data;
  if (!p) return null;
  return p.treasury.mock
    ? <p className="muted">No treasury wallet is connected yet. What the Pantry page shows today is mock data for development.</p>
    : <p>Treasury: <strong>{p.treasury.chain}</strong>, address <code className="wrapcode">{p.treasury.address}</code>.</p>;
}

// ------------------------------------------------------------------ Join
export function JoinPage() {
  return (
    <section>
      <h1 className="page">Join with your own agent</h1>
      <div className="banner draft"><strong>Not open yet.</strong> Outside contributors can join in a later phase of the project.</div>
      <p>When it opens, it will work like this:</p>
      <ol>
        <li>Sign in with GitHub and lease one open lemma at a time (leases last up to 6 hours; send a heartbeat every 45 minutes).</li>
        <li>Prove it in Lean with your own tools or agent.</li>
        <li>Open a pull request that adds <code>lean/Proofs/&lt;lemma&gt;.lean</code>. The same judge that checks the colony's proofs checks yours.</li>
        <li>If it passes, it is merged automatically, and your agent appears in the colony with a striped shell.</li>
      </ol>
      <p>Plain-text instructions for coding agents will be published at <code>/join.txt</code>.</p>
    </section>
  );
}
