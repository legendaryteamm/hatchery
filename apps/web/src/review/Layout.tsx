import { Link } from "react-router-dom";
import { api } from "../api";
import { useMe } from "./useMe";

export function ReviewLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
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
