-- Typeclass search that never terminates (each step asks for `Spin (n+1)`).
import Statements.L_fixture_001
namespace Proof.L_fixture_001
class Spin (n : Nat) : Prop where
instance spin {n : Nat} [Spin (n + 1)] : Spin n := ⟨⟩
set_option maxHeartbeats 0 in
set_option synthInstance.maxHeartbeats 0 in
set_option synthInstance.maxSize 1000000000 in
theorem stuck : Spin 0 := inferInstance
end Proof.L_fixture_001
theorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Nat.add_zero n
