import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Me } from "../api";

/** Opened from the one-time invite link: /review/join#<token>. */
export function Join() {
  const [state, setState] = useState<{ me?: Me; error?: string }>({});
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    // Remove the token from the address bar and browser history right away.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ error: "This page needs the full invite link. Open the link from your invitation again." });
      return;
    }
    api
      .post<Me>("/review/join", { token })
      .then((me) => setState({ me }))
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  if (state.error)
    return (
      <div className="card">
        <h1>Sign-in link not accepted</h1>
        <p>{state.error}</p>
      </div>
    );
  if (!state.me) return <p className="muted">Signing you in…</p>;
  return (
    <div className="card">
      <h1>Welcome, {state.me.name}</h1>
      <p>
        You are signed in as a {state.me.role === "advisor" ? "math advisor" : "maintainer"}. This browser stays signed in for 30 days.
        The invite link has now been used and will not work again.
      </p>
      <p>
        <Link className="button" to="/review">
          Open the review queue
        </Link>
      </p>
    </div>
  );
}
