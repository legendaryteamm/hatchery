/-
  judgecheck: the trusted half of the Hatchery Lean judge.

  Usage (inside the runner container):  judgecheck <LeanName>
    e.g. judgecheck L_circ_014

  Reads `Submission.olean` (compiled from untrusted source, possibly forged) from the
  search path WITHOUT trusting any metadata in it, then:
    1. builds a base environment from the submission's declared imports plus the trusted
       statement module `Statements.<LeanName>`;
    2. replays every constant of the submission through the kernel (`Kernel.Environment.replay`);
    3. looks up `Proof.<LeanName>` in the replayed environment, checks it is a theorem whose
       type is definitionally `Statement.<LeanName>` (kernel `isDefEq`);
    4. collects the axioms it depends on by walking terms in the replayed kernel environment
       (NOT via the `exportedAxiomsExt` cache, which comes from oleans and is untrusted).

  Prints exactly one line `HATCHERY_REPORT <json>` on stdout. Policy decisions (allowed axioms,
  allowed imports, namespace rules) are made by the TypeScript judge, not here.
-/
import Lean
open Lean

namespace Judge

structure Report where
  imports : Array String := #[]
  isModule : Bool := false
  constants : Array String := #[]
  unsafeOrPartial : Array String := #[]
  replay : String := "skipped"
  theoremFound : Bool := false
  theoremKind : String := ""
  typeDefEq : String := "skipped"
  axioms : Array String := #[]
  missing : Array String := #[]
  error : String := ""
  deriving ToJson

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "rec"

structure AxState where
  seen : NameSet := {}
  axioms : NameSet := {}
  missing : NameSet := {}

/-- Walk every constant reachable from `n` (types, values, constructors) and record axioms. -/
partial def collect (env : Kernel.Environment) (n : Name) : StateM AxState Unit := do
  if (← get).seen.contains n then return
  modify fun s => { s with seen := s.seen.insert n }
  let goE (e : Expr) : StateM AxState Unit := e.getUsedConstants.forM (collect env)
  match env.find? n with
  | some (.axiomInfo v) =>
      modify fun s => { s with axioms := s.axioms.insert n }
      goE v.type
  | some (.defnInfo v) => goE v.type *> goE v.value
  | some (.thmInfo v) => goE v.type *> goE v.value
  | some (.opaqueInfo v) => goE v.type *> goE v.value
  | some (.quotInfo _) => pure ()
  | some (.ctorInfo v) => goE v.type
  | some (.recInfo v) => goE v.type
  | some (.inductInfo v) => goE v.type *> v.ctors.forM (collect env)
  | none => modify fun s => { s with missing := s.missing.insert n }

def sorted (s : NameSet) : Array String :=
  (s.toArray.map toString).qsort (· < ·)

def run (leanName : String) : IO Report := do
  let thmName := Name.mkStr `Proof leanName
  let stmtName := Name.mkStr `Statement leanName
  let stmtModule := Name.mkStr `Statements leanName
  let mut r : Report := {}
  let oleanPath ← findOLean `Submission
  let (md, _region) ← readModuleData oleanPath
  r := { r with
    imports := md.imports.map (toString ·.module)
    isModule := md.isModule
    constants := (md.constNames.map toString).qsort (· < ·)
    unsafeOrPartial := (md.constants.filter (fun c => c.isUnsafe || c.isPartial)).map (toString ·.name) }
  -- Base environment: trusted oleans only (the submission's imports + the trusted statement).
  let baseImports := md.imports.map (fun i => ({ module := i.module } : Import)) |>.push { module := stmtModule }
  let base ← importModules baseImports {} (trustLevel := 0)
  let mut newConsts : Std.HashMap Name ConstantInfo := {}
  for c in md.constants do
    newConsts := newConsts.insert c.name c
  let kenv ← try
      let k ← base.toKernelEnv.replay newConsts
      r := { r with replay := "ok" }
      pure (some k)
    catch e =>
      r := { r with replay := s!"failed: {e}" }
      pure none
  let some kenv := kenv | return r
  match kenv.find? thmName with
  | none => return r
  | some ci =>
    r := { r with theoremFound := true, theoremKind := kindOf ci }
    let env := Environment.ofKernelEnv kenv
    let defeq := match Kernel.isDefEq env {} ci.type (.const stmtName []) with
      | .ok true => "yes"
      | .ok false => "no"
      | .error _ => "error"
    let ((), s) := (collect kenv thmName).run {}
    return { r with typeDefEq := defeq, axioms := sorted s.axioms, missing := sorted s.missing }

end Judge

def main (args : List String) : IO UInt32 := do
  let [leanName] := args
    | IO.eprintln "usage: judgecheck <LeanName>"; return 2
  unless leanName.startsWith "L_" && leanName.all (fun c => c.isAlphanum || c == '_') do
    IO.eprintln "invalid lean name"; return 2
  initSearchPath (← findSysroot)
  let report ← try Judge.run leanName catch e => pure { error := toString e }
  IO.println s!"HATCHERY_REPORT {(toJson report).compress}"
  return 0
