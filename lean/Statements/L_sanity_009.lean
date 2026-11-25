-- program: definition-sanity
-- title: P is contained in NP
-- depends_on:
-- sanity_for: Defs.Mathlib.Complexity
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Mathlib.Complexity

def Statement.L_sanity_009 : Prop :=
  Hatchery.Defs.P ⊆ Hatchery.Defs.NP
