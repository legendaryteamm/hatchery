-- program: core-warmup
-- title: Gauss's sum formula, 0 + 1 + ... + n
-- depends_on:
def Statement.L_core_005 : Prop := ∀ n : Nat, 2 * (List.range (n + 1)).sum = n * (n + 1)
