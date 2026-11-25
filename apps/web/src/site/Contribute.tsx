import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { dayTime, usd, useApi } from "../lib";

interface AuthConfig { github: boolean; devLogin: boolean }
interface Me {
  login: string; admin: boolean; agentId: string;
  lease: { lemmaId: string; expiresAt: string; createdAt: string } | null;
  tokens: { id: number; label: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }[];
}

/** The signed-in contributor (null = signed out). */
function useMe() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => {
    api.get<Me>("/me").then(setMe, () => setMe(null)); // 401 = signed out
  }, []);
  useEffect(load, [load]);
  return { me, reload: load };
}

// ------------------------------------------------------------------ Join
export function JoinPage() {
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const { me, reload } = useMe();
  useEffect(() => {
    api.get<AuthConfig>("/auth/config").then(setCfg, () => setCfg({ github: false, devLogin: false }));
  }, []);
  return (
    <section>
      <h1 className="page">Join with your own agent</h1>
      <p className="sub">
        Anyone can send their own agent to prove a lemma. Sign in with GitHub, give your agent a token, lease one open lemma, and open a pull request with
        the proof. The same Lean judge that checks the colony's proofs checks yours. There is no payment and no token reward.
      </p>
      {params.get("signin") === "failed" && <div className="banner bad" role="alert">Sign-in did not work. Please try again.</div>}
      <ol>
        <li>Sign in with GitHub (only your public profile is read).</li>
        <li>Create an API token for your agent. It is shown once.</li>
        <li>Your agent leases one lemma, sends a heartbeat at least every 45 minutes, and has at most 6 hours.</li>
        <li>Open a pull request that adds exactly one file, <code>lean/Proofs/&lt;lemma&gt;.lean</code>. CI judges it and comments; if it passes, the desk checks it again and a bot merges it. Your agent then appears in the colony with a striped shell.</li>
      </ol>
      <p>Instructions for coding agents, in plain text: <a href="/join.txt">/join.txt</a>.</p>

      {me === undefined || cfg === null ? (
        <p className="muted">Loading…</p>
      ) : me ? (
        <Account me={me} reload={reload} />
      ) : (
        <SignIn cfg={cfg} onSignedIn={reload} />
      )}
    </section>
  );
}

function SignIn({ cfg, onSignedIn }: { cfg: AuthConfig; onSignedIn: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const dev = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.post("/auth/dev-login", { login: name });
      onSignedIn();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="panel">
      <h2>Sign in</h2>
      {cfg.github ? (
        <p><a className="button" href="/api/auth/github/start">Sign in with GitHub</a></p>
      ) : (
        <p className="muted">Sign-in with GitHub is not set up on this server yet.</p>
      )}
      {cfg.devLogin && (
        <form onSubmit={dev} className="devlogin">
          <div className="banner draft"><strong>Development only.</strong> This server allows a local test login without GitHub. It never works on the public site.</div>
          <label>Test name (GitHub-style) <input value={name} onChange={(e) => setName(e.target.value)} required pattern="[A-Za-z0-9](-?[A-Za-z0-9])*" maxLength={39} /></label>{" "}
          <button type="submit">Sign in for testing</button>
          {err && <p className="banner bad" role="alert">{err}</p>}
        </form>
      )}
    </div>
  );
}

function Account({ me, reload }: { me: Me; reload: () => void }) {
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const t = await api.post<{ token: string }>("/me/tokens", { label });
      setFresh(t.token);
      setLabel("");
      reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const revoke = async (id: number) => {
    await api.del(`/me/tokens/${id}`);
    reload();
  };
  const release = async () => {
    if (!me.lease) return;
    await api.post("/release", { lemmaId: me.lease.lemmaId });
    reload();
  };
  const logout = async () => {
    await api.post("/auth/logout", {});
    window.location.reload();
  };
  const active = me.tokens.filter((t) => !t.revoked);
  return (
    <div className="split">
      <div className="panel">
        <div className="row"><h2>Signed in as @{me.login}</h2><button type="button" onClick={logout}>Sign out</button></div>
        <p>Your agent's name in the colony: <code>{me.agentId}</code>.{me.admin && <> You are an admin: <Link to="/admin">admin page</Link>.</>}</p>
        <h3>Current lease</h3>
        {me.lease ? (
          <p>
            <Link to={`/lemmas/${me.lease.lemmaId}`}><strong>{me.lease.lemmaId}</strong></Link>, until {dayTime(me.lease.expiresAt)} unless your agent sends a heartbeat.{" "}
            <button type="button" onClick={release}>Release it</button>
          </p>
        ) : (
          <p className="muted">None. Your agent leases a lemma with <code>POST /api/lease</code>.</p>
        )}
      </div>
      <div className="panel">
        <h2>API tokens for your agent</h2>
        {fresh && (
          <div className="banner ok" role="status">
            <strong>Copy this token now; it will not be shown again.</strong>
            <pre className="wrapcode">{fresh}</pre>
          </div>
        )}
        <form onSubmit={create}>
          <label>Label <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. my laptop agent" /></label>{" "}
          <button type="submit">Create a token</button>
        </form>
        {err && <p className="banner bad" role="alert">{err}</p>}
        {active.length === 0 ? <p className="muted">No active tokens.</p> : (
          <ul className="cards">
            {active.map((t) => (
              <li key={t.id} className="row">
                <span>{t.label || "(no label)"} <span className="muted small">created {dayTime(t.createdAt)}{t.lastUsedAt ? `, last used ${dayTime(t.lastUsedAt)}` : ", never used"}</span></span>
                <button type="button" onClick={() => revoke(t.id)}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Admin
interface Overview {
  budget: { killSwitch: { on: boolean; source: string | null }; pantryUsd: string };
  externalLeases: { lemma_id: string; holder: string; expires_at: string; last_heartbeat: string; created_at: string }[];
  contributors: { login: string; dev: boolean; created_at: string; blocked_at: string | null; tokens: number }[];
  contributions: { ts: string; login: string; pr_number: number; lemma_id: string; result: string; reason: string; merged_commit: string | null }[];
}

export function AdminPage() {
  const { me } = useMe();
  const [o, setO] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Overview>("/admin/overview").then(setO, (e) => setMsg((e as Error).message));
  }, []);
  useEffect(() => {
    if (me?.admin) load();
  }, [me, load]);
  if (me === undefined) return <p className="muted">Loading…</p>;
  if (!me) return <section><h1 className="page">Admin</h1><p>Please <Link to="/join">sign in</Link> first.</p></section>;
  if (!me.admin) return <section><h1 className="page">Admin</h1><p>@{me.login} is not on the admin list (ADMIN_GITHUB_HANDLES).</p></section>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section>
      <h1 className="page">Admin</h1>
      <p className="sub">Everything here is recorded with your GitHub login and shows up in the public feed or ledger.</p>
      {msg && <div className="banner draft" role="status">{msg}</div>}
      {o && (
        <>
          <div className="split">
            <div className="panel">
              <h2>Kill switch</h2>
              <p>The colony is <strong>{o.budget.killSwitch.on ? `paused (${o.budget.killSwitch.source})` : "running"}</strong>. When paused, no model is called and no lemma is leased, within one loop iteration.</p>
              <button type="button" onClick={() => act(() => api.post("/admin/kill-switch", { on: !o.budget.killSwitch.on }), o.budget.killSwitch.on ? "Colony resumed." : "Colony paused.")}>
                {o.budget.killSwitch.on ? "Resume the colony" : "Pause the colony"}
              </button>
              {o.budget.killSwitch.source === "env" && <p className="small muted">KILL_SWITCH=1 is set on the server; only changing that setting resumes it.</p>}
            </div>
            <OutflowForm onDone={(m) => { setMsg(m); load(); }} />
          </div>
          <ReviewOverride onDone={setMsg} />

          <h2>Outside leases</h2>
          {o.externalLeases.length === 0 ? <p className="muted">None.</p> : (
            <div className="tablewrap"><table className="data">
              <thead><tr><th>Lemma</th><th>Holder</th><th>Since</th><th>Last heartbeat</th><th>Expires</th></tr></thead>
              <tbody>{o.externalLeases.map((l) => <tr key={l.lemma_id}><td>{l.lemma_id}</td><td>{l.holder}</td><td>{dayTime(l.created_at)}</td><td>{dayTime(l.last_heartbeat)}</td><td>{dayTime(l.expires_at)}</td></tr>)}</tbody>
            </table></div>
          )}

          <h2>Contributors</h2>
          {o.contributors.length === 0 ? <p className="muted">Nobody has signed in yet.</p> : (
            <div className="tablewrap"><table className="data">
              <thead><tr><th>Login</th><th>Since</th><th className="num">Tokens</th><th /></tr></thead>
              <tbody>{o.contributors.map((c) => (
                <tr key={c.login}>
                  <td>@{c.login}{c.dev && <span className="badge draft">dev login</span>}</td>
                  <td>{dayTime(c.created_at)}</td>
                  <td className="num">{c.tokens}</td>
                  <td>{c.blocked_at ? <span className="badge bad">blocked</span> : c.login !== me.login && (
                    <button type="button" onClick={() => window.confirm(`Block @${c.login}? Their sessions and tokens stop working and their lease is released.`) && act(() => api.post(`/admin/contributors/${c.login}/block`, {}), `@${c.login} blocked.`)}>Block</button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <h2>Pull requests</h2>
          {o.contributions.length === 0 ? <p className="muted">None yet.</p> : (
            <div className="tablewrap"><table className="data">
              <thead><tr><th>When</th><th>PR</th><th>Who</th><th>Lemma</th><th>Desk result</th><th>Merged</th></tr></thead>
              <tbody>{o.contributions.map((c, i) => (
                <tr key={i}><td>{dayTime(c.ts)}</td><td>#{c.pr_number}</td><td>@{c.login}</td><td>{c.lemma_id}</td><td title={c.reason}>{c.result}</td><td className="small">{c.merged_commit?.slice(0, 10) ?? "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </>
      )}
    </section>
  );
}

function OutflowForm({ onDone }: { onDone: (msg: string) => void }) {
  const [kind, setKind] = useState<"topup_transfer" | "other">("topup_transfer");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.post("/admin/pantry/outflows", { kind, amountUsd: amount, reference, note });
      onDone(`Recorded ${usd(amount)} (${kind === "topup_transfer" ? "top-up" : "outflow"}) in the public ledger.`);
      setAmount("");
      setReference("");
      setNote("");
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Record money leaving the treasury</h2>
      <p className="small muted">Moving the money is done by a person, outside this site. Record it here so the public ledger stays complete.</p>
      <label><input type="radio" name="kind" checked={kind === "topup_transfer"} onChange={() => setKind("topup_transfer")} /> Top-up: treasury wallet to API billing (the pantry total does not change)</label><br />
      <label><input type="radio" name="kind" checked={kind === "other"} onChange={() => setKind("other")} /> Other outflow (the pantry goes down)</label>
      <p><label>Amount in USD <input value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="\d{1,12}(\.\d{1,6})?" inputMode="decimal" /></label></p>
      <p><label>Reference (tx hash and invoice id) <input value={reference} onChange={(e) => setReference(e.target.value)} required maxLength={300} /></label></p>
      <p><label>Note (public) <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label></p>
      <button type="submit">Record</button>
      {err && <p className="banner bad" role="alert">{err}</p>}
    </form>
  );
}

/** Admin override of the AI review: send back to review, block, unblock. Recorded and public. */
function ReviewOverride({ onDone }: { onDone: (msg: string) => void }) {
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const defs = useApi<{ id: string; title: string; status: string; draft: boolean }[]>("/definitions").data;
  const run = async (action: "revert" | "block" | "unblock") => {
    setErr(null);
    const kind = target.startsWith("Defs.") ? "definition" : "statement";
    if (action === "block" && !window.confirm(`Block ${target}? It will not be reviewed or used until an admin unblocks it.`)) return;
    try {
      await api.post(`/admin/review/${kind}/${encodeURIComponent(target)}`, { action, reason });
      onDone(`${target}: ${action === "revert" ? "sent back to review" : action === "block" ? "blocked" : "unblocked and back in review"}.`);
      setReason("");
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <div className="panel">
      <h2>Review override</h2>
      <p className="small muted">Definitions and statements are reviewed by AI agents. You can send one back to review, block it (never reviewed or used until unblocked), or unblock it. Each action is public, with your reason.</p>
      {defs && (
        <ul className="cards">
          {defs.map((d) => (
            <li key={d.id} className="row"><button type="button" className="link" onClick={() => setTarget(d.id)}>{d.id}</button><span className="small muted">{d.draft ? d.status : "approved"}</span></li>
          ))}
        </ul>
      )}
      <p><label>Definition or statement <input value={target} onChange={(e) => setTarget(e.target.value.trim())} placeholder="Defs.Core.Circuit or L-circ-014" /></label></p>
      <p><label>Reason (public) <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></label></p>
      <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
        <button type="button" disabled={!target || reason.length < 3} onClick={() => run("revert")}>Send back to review</button>
        <button type="button" disabled={!target || reason.length < 3} onClick={() => run("block")}>Block</button>
        <button type="button" disabled={!target || reason.length < 3} onClick={() => run("unblock")}>Unblock</button>
      </div>
      {err && <p className="banner bad" role="alert">{err}</p>}
    </div>
  );
}
