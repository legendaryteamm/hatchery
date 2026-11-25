/-
  FIXTURE checked proof (also the judge's sample proof). Not part of any research program.
-/
import Statements.L_fixture_001

namespace Proof.L_fixture_001

theorem helper (n : Nat) : n + 0 = n := Nat.add_zero n

end Proof.L_fixture_001

theorem Proof.L_fixture_001 : Statement.L_fixture_001 := fun n => Proof.L_fixture_001.helper n
