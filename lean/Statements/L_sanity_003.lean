-- program: definition-sanity
-- title: A circuit's depth is at most its size
-- depends_on:
-- sanity_for: Defs.Core.Circuit
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Circuit

def Statement.L_sanity_003 : Prop :=
  ∀ (n : Nat) (c : Hatchery.Defs.Circuit n), c.depth ≤ c.size
