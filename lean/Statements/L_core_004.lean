-- program: core-warmup
-- title: De Morgan's law for Boolean AND
-- depends_on:
def Statement.L_core_004 : Prop := ∀ a b : Bool, (a && b) = !(!a || !b)
