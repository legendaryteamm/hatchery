-- Only meaningful with the FULL runner image (pinned Mathlib).
import Mathlib.Tactic.Ring
import Statements.L_fixture_002
theorem Proof.L_fixture_002 : Statement.L_fixture_002 := by
  intro a b
  ring
