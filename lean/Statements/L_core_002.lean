-- program: core-warmup
-- title: Length of an appended list
-- depends_on:
def Statement.L_core_002 : Prop := ∀ xs ys : List Nat, (xs ++ ys).length = xs.length + ys.length
