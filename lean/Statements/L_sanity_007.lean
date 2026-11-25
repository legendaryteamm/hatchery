-- program: definition-sanity
-- title: Two pigeons do not fit in one hole
-- depends_on:
-- sanity_for: Defs.Core.Resolution
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Resolution

def Statement.L_sanity_007 : Prop :=
  Hatchery.Defs.CNF.Unsat (Hatchery.Defs.php 2 1)
