-- program: definition-sanity
-- title: AND of two variables is a formula of size 1
-- depends_on:
-- sanity_for: Defs.Core.Formula
-- A known basic fact. The definition it tests is approved only after this is proved (docs/autonomous-review.md).
import Defs.Core.Formula

def Statement.L_sanity_005 : Prop :=
  ∃ φ : Hatchery.Defs.Formula 2, φ.Computes (fun x => x 0 && x 1) ∧ φ.size = 1
