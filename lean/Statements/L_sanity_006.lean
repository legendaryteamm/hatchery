-- program: definition-sanity
-- title: Resolution is sound: a refutable CNF is unsatisfiable
-- depends_on:
-- sanity_for: Defs.Core.Resolution
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Resolution

def Statement.L_sanity_006 : Prop :=
  ∀ (F : Hatchery.Defs.CNF) (π : List Hatchery.Defs.Clause), Hatchery.Defs.IsRefutation F π → Hatchery.Defs.CNF.Unsat F
