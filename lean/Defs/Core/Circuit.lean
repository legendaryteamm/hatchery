/-!
# Boolean circuits, AC⁰ and monotone circuits

title: Boolean circuits, AC0, parity, monotone circuits
summary: A Boolean circuit on n inputs is a list of gates. Wires 0 … n-1 are the inputs; gate number k is wire n + k and may only read wires with smaller numbers (so the circuit has no cycles). AND and OR gates have unbounded fan-in (any number of inputs, including none: an empty AND is true, an empty OR is false); NOT has fan-in 1. The output is the last gate. Size is the number of gates. Depth is the number of gates on the longest input-to-output path. A family of circuits (one for each input length n) is in AC0 if its size is bounded by a polynomial in n and its depth by a constant. A circuit is monotone if it has no NOT gates. Parity of n bits is true when an odd number of them are true.

Review status lives in the review tool, not in this file. Until a math advisor approves it, this
definition is a DRAFT and no statement that uses it can be approved.
-/
namespace Hatchery.Defs

/-- A gate reads earlier wires by number. -/
inductive Gate where
  | not (w : Nat)
  | and (ws : List Nat)
  | or (ws : List Nat)
  deriving Repr, DecidableEq

/-- A circuit on `n` inputs. -/
structure Circuit (n : Nat) where
  gates : List Gate
  deriving Repr

namespace Gate

/-- The wires a gate reads. -/
def inputs : Gate → List Nat
  | not w => [w]
  | and ws => ws
  | or ws => ws

end Gate

namespace Circuit

/-- Every gate `k` reads only wires numbered below `n + k`. -/
def WellFormed {n : Nat} (c : Circuit n) : Prop :=
  ∀ k (h : k < c.gates.length), ∀ w ∈ (c.gates[k]'h).inputs, w < n + k

/-- Values of all wires, inputs first, computed gate by gate. A wire that does not exist reads as `false`. -/
def wireValues {n : Nat} (c : Circuit n) (x : Fin n → Bool) : List Bool :=
  c.gates.foldl
    (fun vals g =>
      let v (w : Nat) := vals.getD w false
      vals ++ [match g with
        | Gate.not w => !(v w)
        | Gate.and ws => ws.all v
        | Gate.or ws => ws.any v])
    (List.ofFn x)

/-- The output: the value of the last gate (or `false` for a circuit without gates). -/
def eval {n : Nat} (c : Circuit n) (x : Fin n → Bool) : Bool :=
  if c.gates.isEmpty then false else (c.wireValues x).getLastD false

/-- Number of gates. -/
def size {n : Nat} (c : Circuit n) : Nat := c.gates.length

/-- Depth of every wire (inputs have depth 0; a gate is one more than its deepest input). -/
def wireDepths {n : Nat} (c : Circuit n) : List Nat :=
  c.gates.foldl (fun ds g => ds ++ [(g.inputs.map fun w => ds.getD w 0).foldl max 0 + 1]) (List.replicate n 0)

/-- Depth of the output gate. -/
def depth {n : Nat} (c : Circuit n) : Nat := c.wireDepths.getLastD 0

/-- No NOT gates. -/
def Monotone {n : Nat} (c : Circuit n) : Prop := ∀ g ∈ c.gates, ∀ w, g ≠ Gate.not w

/-- The circuit computes `f`. -/
def Computes {n : Nat} (c : Circuit n) (f : (Fin n → Bool) → Bool) : Prop :=
  c.WellFormed ∧ ∀ x, c.eval x = f x

end Circuit

/-- A Boolean function for every input length. -/
abbrev BoolFunFamily := (n : Nat) → (Fin n → Bool) → Bool

/-- `f` has circuits of size at most `n^k + k` and depth at most `d`, for constants `k` and `d`: AC⁰. -/
def InAC0 (f : BoolFunFamily) : Prop :=
  ∃ k d : Nat, ∀ n, ∃ c : Circuit n, c.Computes (f n) ∧ c.size ≤ n ^ k + k ∧ c.depth ≤ d

/-- Parity: true when an odd number of the inputs are true. -/
def parity : BoolFunFamily := fun n x => (List.ofFn x).foldl (fun acc b => acc ^^ b) false

end Hatchery.Defs
