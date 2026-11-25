/-!
# Boolean formulas

title: Boolean formulas
summary: A Boolean formula over n input variables is a tree built from the variables, the constants true and false, NOT, AND and OR. Every gate has fan-out 1 (it is used once), which is what separates formulas from circuits. Size counts the AND/OR/NOT gates; depth is the length of the longest path from the root to a leaf.

Review status lives in the desk, not in this file. This definition is a DRAFT until the automated
review approves it (docs/autonomous-review.md): reviewer agents compare it with the textbook
definition, its sanity lemmas (lean/Statements, "sanity_for") are proved, and an adversary agent
fails to prove False (or the goals below) from it. Reviewed by AI agents, not by a human mathematician.
-/
namespace Hatchery.Defs

/-- A Boolean formula over `n` input variables `x₀ … x_{n-1}`. -/
inductive Formula (n : Nat) where
  | var (i : Fin n)
  | const (b : Bool)
  | not (f : Formula n)
  | and (f g : Formula n)
  | or (f g : Formula n)
  deriving Repr

namespace Formula

/-- The value of the formula on the assignment `x`. -/
def eval {n : Nat} : Formula n → (Fin n → Bool) → Bool
  | var i, x => x i
  | const b, _ => b
  | not f, x => !(f.eval x)
  | and f g, x => f.eval x && g.eval x
  | or f g, x => f.eval x || g.eval x

/-- Number of NOT, AND and OR gates. -/
def size {n : Nat} : Formula n → Nat
  | var _ => 0
  | const _ => 0
  | not f => f.size + 1
  | and f g => f.size + g.size + 1
  | or f g => f.size + g.size + 1

/-- Length of the longest root-to-leaf path. -/
def depth {n : Nat} : Formula n → Nat
  | var _ => 0
  | const _ => 0
  | not f => f.depth + 1
  | and f g => max f.depth g.depth + 1
  | or f g => max f.depth g.depth + 1

/-- The formula computes the Boolean function `f`. -/
def Computes {n : Nat} (φ : Formula n) (f : (Fin n → Bool) → Bool) : Prop :=
  ∀ x, φ.eval x = f x

end Formula
end Hatchery.Defs
