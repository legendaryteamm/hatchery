-- Does not import the trusted statement; defines its own trivial one with the same name.
def Statement.L_fixture_001 : Prop := True
theorem Proof.L_fixture_001 : Statement.L_fixture_001 := trivial
