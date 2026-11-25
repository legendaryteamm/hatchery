import Mathlib.Computability.TuringMachine.Computable
import Mathlib.Computability.Language
import Mathlib.Algebra.Polynomial.Eval.Defs

/-!
# P and NP

title: Polynomial time, P and NP (Mathlib Turing machines)
summary: Inputs are binary strings (lists of booleans) and a decision problem is a set of binary strings. A function from binary strings to true/false is polynomial-time computable if one of Mathlib's multi-stack Turing machines (FinTM2) computes it, reading the input string bit by bit and writing the one-bit answer, within a number of steps bounded by a polynomial in the input length. P is the class of decision problems whose membership test is polynomial-time computable. NP is the class of decision problems L for which there is a polynomial-time verifier V and a polynomial p such that a string w is in L exactly when some certificate c of length at most p(|w|) makes V accept the pair (w, c). The pair is written as one binary string: each bit b of w becomes the two bits (1, b), then a single 0 marks the end of w, then c follows.

adversary: Hatchery.Defs.P = Hatchery.Defs.NP; Hatchery.Defs.P ≠ Hatchery.Defs.NP

Built only in the full (Mathlib) judge image: it cannot be compiled on a machine without Mathlib.
Review status lives in the desk, not in this file. This definition is a DRAFT until the automated
review approves it (docs/autonomous-review.md): reviewer agents compare it with the textbook
definition, its sanity lemmas (lean/Statements, "sanity_for") are proved, and an adversary agent
fails to prove False (or the goals below) from it. Reviewed by AI agents, not by a human mathematician.
-/
namespace Hatchery.Defs

/-- A decision problem: a set of binary strings. -/
abbrev DecisionProblem := Language Bool

/-- `f` is computed by a Mathlib multi-stack Turing machine in time polynomial in the input length. -/
def PolyTimeComputable (f : List Bool → Bool) : Prop :=
  Nonempty (Turing.TM2ComputableInPolyTime (fun w : List Bool => w) Computability.encodeBool f)

/-- The complexity class P. -/
def P : Set DecisionProblem :=
  { L | ∃ f : List Bool → Bool, PolyTimeComputable f ∧ ∀ w, w ∈ L ↔ f w = true }

/-- The pair (w, c) as one binary string: `1 b` for each bit `b` of `w`, then `0`, then `c`. -/
def pairEncode (w c : List Bool) : List Bool :=
  (w.flatMap fun b => [true, b]) ++ [false] ++ c

/-- The complexity class NP (verifier definition). -/
def NP : Set DecisionProblem :=
  { L | ∃ (V : List Bool → Bool) (p : Polynomial ℕ), PolyTimeComputable V ∧
      ∀ w, w ∈ L ↔ ∃ c : List Bool, c.length ≤ p.eval w.length ∧ V (pairEncode w c) = true }

end Hatchery.Defs
