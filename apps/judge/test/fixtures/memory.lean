-- `decide` over 50 million cases: exhausts the memory limit quickly.
import Statements.L_fixture_001
namespace Proof.L_fixture_001
set_option maxHeartbeats 0 in
set_option maxRecDepth 100000 in
theorem big : ∀ x, x < 50000000 → x * x ≠ 2 := by decide
end Proof.L_fixture_001
theorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Nat.add_zero n
