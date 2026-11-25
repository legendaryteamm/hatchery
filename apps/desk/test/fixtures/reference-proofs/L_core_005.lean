import Statements.L_core_005
theorem Proof.L_core_005 : Statement.L_core_005 := by
  intro n
  induction n with
  | zero => rfl
  | succ k ih =>
    rw [List.range_succ, List.sum_append, List.sum_cons, List.sum_nil, Nat.mul_add, ih]
    simp only [Nat.mul_add, Nat.add_mul, Nat.mul_one, Nat.one_mul, Nat.add_zero]
    omega
