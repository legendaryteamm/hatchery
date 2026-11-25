-- program: definition-sanity
-- title: AND of two inputs is a single gate of depth 1
-- depends_on:
-- sanity_for: Defs.Core.Circuit
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Circuit

def Statement.L_sanity_002 : Prop :=
  ∃ c : Hatchery.Defs.Circuit 2, c.Computes (fun x => x 0 && x 1) ∧ c.size = 1 ∧ c.depth = 1
