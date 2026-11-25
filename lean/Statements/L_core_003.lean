-- program: core-warmup
-- title: Reversing a list twice gives the list back
-- depends_on:
def Statement.L_core_003 : Prop := ∀ xs : List Nat, xs.reverse.reverse = xs
