/-!
# CNF formulas, resolution, and the pigeonhole principle

title: CNF formulas, resolution refutations, pigeonhole formulas
summary: A literal is a variable (a natural number) with a sign. A clause is a list of literals (their OR); a CNF formula is a list of clauses (their AND). Resolution derives a new clause from two clauses that contain a variable with opposite signs: the result contains all other literals of both clauses. A resolution refutation of a CNF is a list of clauses, each either a clause of the CNF or obtained by resolution from two earlier clauses, ending with the empty clause; its size is the number of clauses in the list. The pigeonhole formula PHP(m, n) says that m pigeons can each be put into one of n holes with no two pigeons in the same hole; it is unsatisfiable when m > n. Variable p·n + h means "pigeon p sits in hole h".

Review status lives in the desk, not in this file. This definition is a DRAFT until the automated
review approves it (docs/autonomous-review.md): reviewer agents compare it with the textbook
definition, its sanity lemmas (lean/Statements, "sanity_for") are proved, and an adversary agent
fails to prove False (or the goals below) from it. Reviewed by AI agents, not by a human mathematician.
-/
namespace Hatchery.Defs

/-- A literal: variable `var`, positive when `pos` is true. -/
structure Lit where
  var : Nat
  pos : Bool
  deriving Repr, DecidableEq

/-- A clause: the OR of its literals. -/
abbrev Clause := List Lit

/-- A CNF formula: the AND of its clauses. -/
abbrev CNF := List Clause

/-- An assignment satisfies a clause when it makes one of its literals true. -/
def Clause.Sat (a : Nat → Bool) (c : Clause) : Prop := ∃ l ∈ c, a l.var = l.pos

/-- An assignment satisfies a CNF when it satisfies every clause. -/
def CNF.Sat (a : Nat → Bool) (F : CNF) : Prop := ∀ c ∈ F, Clause.Sat a c

/-- No assignment satisfies the CNF. -/
def CNF.Unsat (F : CNF) : Prop := ∀ a, ¬ CNF.Sat a F

/-- `r` is a resolvent of `c₁` and `c₂` on variable `v`: `v` occurs positively in `c₁` and
negatively in `c₂`, and `r` contains exactly the other literals of both (as a set). -/
def IsResolvent (c₁ c₂ r : Clause) (v : Nat) : Prop :=
  ⟨v, true⟩ ∈ c₁ ∧ ⟨v, false⟩ ∈ c₂ ∧
  ∀ l, l ∈ r ↔ ((l ∈ c₁ ∧ l ≠ ⟨v, true⟩) ∨ (l ∈ c₂ ∧ l ≠ ⟨v, false⟩))

/-- Each line is an axiom of `F` or a resolvent of two earlier lines. -/
def IsDerivation (F : CNF) (π : List Clause) : Prop :=
  ∀ k (h : k < π.length),
    π[k] ∈ F ∨ ∃ i j v, ∃ (hi : i < k) (hj : j < k),
      IsResolvent (π[i]'(Nat.lt_trans hi h)) (π[j]'(Nat.lt_trans hj h)) π[k] v

/-- A resolution refutation: a derivation whose last line is the empty clause. -/
def IsRefutation (F : CNF) (π : List Clause) : Prop :=
  IsDerivation F π ∧ π.getLast? = some []

/-- Pigeonhole formula PHP(m, n): variable `p * n + h` means "pigeon `p` is in hole `h`". -/
def php (m n : Nat) : CNF :=
  -- every pigeon is in some hole
  ((List.range m).map fun p => (List.range n).map fun h => (⟨p * n + h, true⟩ : Lit)) ++
  -- no two pigeons share a hole
  ((List.range n).flatMap fun h =>
    (List.range m).flatMap fun p =>
      (List.range m).filterMap fun q =>
        if p < q then some [(⟨p * n + h, false⟩ : Lit), ⟨q * n + h, false⟩] else none)

end Hatchery.Defs
