-- program: definition-sanity
-- title: PHP(2,1) has a resolution refutation
-- depends_on:
-- sanity_for: Defs.Core.Resolution
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Resolution

def Statement.L_sanity_008 : Prop :=
  ∃ π : List Hatchery.Defs.Clause, Hatchery.Defs.IsRefutation (Hatchery.Defs.php 2 1) π
