import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../lib";
import { useMe } from "./useMe";

export function ReviewLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const cfg = useApi<{ humanReviewTool: boolean }>("/review-config").data;
  if (cfg && !cfg.humanReviewTool) return <ToolDisabled />;
  if (me === undefined) return <p className="muted">Loading…</p>;
  if (me === null)
    return (
      <div className="card">
        <h1>Review tool</h1>
        <p>You are not signed in. Open the invite link the maintainer sent you. If it no longer works, ask for a new one.</p>
      </div>
    );
  return (
    <div>
      <nav className="reviewbar">
        <Link to="/review">Review queue</Link>
        <span className="muted">
          Signed in as <strong>{me.name}</strong> ({me.role === "advisor" ? "math advisor" : "maintainer"})
        </span>
        <button
          type="button"
          className="link"
          onClick={async () => {
            await api.post("/review/logout", {});
            window.location.assign("/review");
          }}
        >
          Sign out
        </button>
      </nav>
      {children}
    </div>
  );
}

/** The human advisor tool is kept in the code but off: there is no human math advisor. */
export function ToolDisabled() {
  return (
    <div className="card">
      <h1>Review tool</h1>
      <p>
        The human review tool is switched off. Definitions and statements are reviewed by AI agents, not by a human mathematician; every
        review, with the agents' reasoning, is on the <Link to="/definitions">definition</Link> and lemma pages.
      </p>
    </div>
  );
}
