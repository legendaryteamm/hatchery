-- program: definition-sanity
-- title: A formula's depth is at most its size
-- depends_on:
-- sanity_for: Defs.Core.Formula
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Formula

def Statement.L_sanity_004 : Prop :=
  ∀ (n : Nat) (φ : Hatchery.Defs.Formula n), φ.depth ≤ φ.size
