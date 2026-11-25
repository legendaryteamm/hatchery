-- Reuses the checked proof of L-fixture-001 (supplied by the desk as a dependency).
import Statements.L_fixture_002
import Proofs.L_fixture_001
theorem Proof.L_fixture_002 : Statement.L_fixture_002 := fun a b =>
  have _ := Proof.L_fixture_001 a
  Nat.add_comm a b
