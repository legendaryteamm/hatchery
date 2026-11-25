import { Link, Route, Routes } from "react-router-dom";
import { PublicDefinition, PublicDefinitions } from "./public/Definitions";
import { DefinitionReview } from "./review/DefinitionReview";
import { Join } from "./review/Join";
import { ReviewLayout } from "./review/Layout";
import { Queue } from "./review/Queue";
import { StatementReview } from "./review/StatementReview";

export function App() {
  return (
    <>
      <header className="site">
        <Link to="/" className="brand">The Hatchery</Link>
        <nav>
          <Link to="/definitions">Definitions</Link>
          <Link to="/review">Review</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<PublicDefinitions />} />
          <Route path="/definitions" element={<PublicDefinitions />} />
          <Route path="/definitions/:id" element={<PublicDefinition />} />
          <Route path="/review/join" element={<Join />} />
          <Route path="/review" element={<ReviewLayout><Queue /></ReviewLayout>} />
          <Route path="/review/definitions/:id" element={<ReviewLayout><DefinitionReview /></ReviewLayout>} />
          <Route path="/review/statements/:id" element={<ReviewLayout><StatementReview /></ReviewLayout>} />
        </Routes>
      </main>
      <footer className="site">Nothing here says P vs NP is settled. A lemma counts only when the Lean checker passes it.</footer>
    </>
  );
}
