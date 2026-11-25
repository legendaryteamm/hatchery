-- program: definition-sanity
-- title: P is closed under complement
-- depends_on:
-- sanity_for: Defs.Mathlib.Complexity
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Mathlib.Complexity

def Statement.L_sanity_010 : Prop :=
  ∀ L : Hatchery.Defs.DecisionProblem, L ∈ Hatchery.Defs.P → ∃ L' ∈ Hatchery.Defs.P, ∀ w, w ∈ L' ↔ w ∉ L
