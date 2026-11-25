import Statements.L_fixture_001
theorem helper_outside (n : Nat) : n + 0 = n := Nat.add_zero n
theorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => helper_outside n
