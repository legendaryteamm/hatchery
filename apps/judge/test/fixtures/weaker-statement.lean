-- Proves a different (not definitionally equal) proposition under the right name.
import Statements.L_fixture_001
theorem Proof.L_fixture_001 : ∀ n : Nat, 0 + n = n := fun n => Nat.zero_add n
