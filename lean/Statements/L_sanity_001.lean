-- program: definition-sanity
-- title: Parity has polynomial-size circuits
-- depends_on:
-- sanity_for: Defs.Core.Circuit
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Circuit

def Statement.L_sanity_001 : Prop :=
  ∃ k : Nat, ∀ n : Nat, ∃ c : Hatchery.Defs.Circuit n, c.Computes (Hatchery.Defs.parity n) ∧ c.size ≤ n ^ k + k
