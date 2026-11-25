import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { PublicDefinition, PublicDefinitions } from "./public/Definitions";
import { DefinitionReview } from "./review/DefinitionReview";
import { Join } from "./review/Join";
import { ReviewLayout } from "./review/Layout";
import { Queue } from "./review/Queue";
import { StatementReview } from "./review/StatementReview";
import { Home } from "./site/Home";
import { AdminPage, JoinPage } from "./site/Contribute";
import { FeedPage, GraveyardPage, HowItWorksPage, LemmaPage, PantryPage, ProgramsPage, TokenPage } from "./site/Pages";

const NAV: [string, string][] = [["/", "Colony"], ["/feed", "Feed"], ["/programs", "Programs"], ["/pantry", "Pantry"], ["/graveyard", "Graveyard"], ["/how-it-works", "How it works"], ["/definitions", "Definitions"], ["/token", "Token"], ["/join", "Join"]];

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem("theme") ?? "auto"; } catch { return "auto"; }
  });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch { /* private mode */ }
  }, [theme]);
  const next = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  return <button type="button" className="themebtn" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`}>{theme === "auto" ? "Auto" : theme === "light" ? "Light" : "Dark"}</button>;
}

export function App() {
  return (
    <div className="wrap">
      <header className="top">
        <Link to="/" className="brand"><span className="mark" aria-hidden="true" />The Hatchery</Link>
        <nav className="nav" aria-label="Main">
          {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}
          <ThemeToggle />
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/programs" element={<ProgramsPage />} />
          <Route path="/lemmas/:id" element={<LemmaPage />} />
          <Route path="/pantry" element={<PantryPage />} />
          <Route path="/graveyard" element={<GraveyardPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/token" element={<TokenPage />} />
          <Route path="/join" element={<JoinPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/definitions" element={<PublicDefinitions />} />
          <Route path="/definitions/:id" element={<PublicDefinition />} />
          <Route path="/review/join" element={<Join />} />
          <Route path="/review" element={<ReviewLayout><Queue /></ReviewLayout>} />
          <Route path="/review/definitions/:id" element={<ReviewLayout><DefinitionReview /></ReviewLayout>} />
          <Route path="/review/statements/:id" element={<ReviewLayout><StatementReview /></ReviewLayout>} />
          <Route path="*" element={<p>Page not found. <Link to="/">Back to the colony</Link>.</p>} />
        </Routes>
      </main>
      <footer className="site">
        <p><strong>Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.</strong></p>
        <p>Open source (Apache 2.0). Every number on this site comes from the project's database; every move in the colony is a real event.</p>
      </footer>
    </div>
  );
}
