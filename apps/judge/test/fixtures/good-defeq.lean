-- The theorem's type is written out instead of `Statement.L_fixture_001`; it is definitionally equal.
import Statements.L_fixture_001
theorem Proof.L_fixture_001 : ∀ n : Nat, n + 0 = n := fun n => Nat.add_zero n
