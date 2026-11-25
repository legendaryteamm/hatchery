#!/bin/bash
# Entrypoint of the Lean runner container. Each mode runs in its OWN fresh container.
# Input on stdin is a tar archive built by the judge service (apps/judge/src/tar.ts):
#
#   deps.txt              one Lean name per line, dependency order (may be empty)
#   Proofs/<L_dep>.lean   source of each already-CHECKED proof the submission imports
#   Submission.lean       (compile mode) the untrusted proof
#   Submission.olean      (check mode)   output of compile mode, treated as untrusted
#
# compile        stdout: raw bytes of Submission.olean (only on success); stderr: Lean messages
#                exit:   0 compiled, 1 Lean errors, 2 usage, 3 a dependency failed, 137 killed (memory)
#
# check <Name>   stdout: HATCHERY_TYPECHECK ok|fail, HATCHERY_TYPECHECK_LOG <line>...,
#                        HATCHERY_LEANCHECKER ok|fail, HATCHERY_LEANCHECKER_LOG <line>...,
#                        HATCHERY_REPORT <json>
#                Dependencies are recompiled HERE from their trusted sources; nothing compiled in the
#                untrusted container except Submission.olean is used.
#
# Time limits are enforced from outside (the judge kills the container). Memory, CPU, pids,
# network and filesystem limits come from `docker run` flags.
set -uo pipefail
# shellcheck disable=SC1091
. /opt/hatchery/lean/runner.env
export HOME=/tmp

unpack() { # $1 = dir
  rm -rf "$1" && mkdir -p "$1" && head -c 300000000 | tar -x --no-same-owner --no-same-permissions -C "$1" -f - || exit 2
}

build_deps() { # $1 = dir holding Proofs/*.lean and deps.txt; oleans are written next to the sources
  local dir="$1" dep
  [ -f "$dir/deps.txt" ] || return 0
  while IFS= read -r dep; do
    [ -z "$dep" ] && continue
    [[ "$dep" =~ ^L_[A-Za-z0-9_]+$ ]] || { echo "invalid dependency name" >&2; exit 2; }
    if ! LEAN_PATH="$dir:$BASE_LEAN_PATH" "$LEAN_BIN" --root="$dir" "$dir/Proofs/$dep.lean" -o "$dir/Proofs/$dep.olean" >&2; then
      echo "dependency Proofs.$dep failed to compile" >&2; exit 3
    fi
  done < "$dir/deps.txt"
}

case "${1:-}" in
  compile)
    unpack /tmp/work
    build_deps /tmp/work
    cd /tmp/work || exit 2
    [ -f Submission.lean ] || exit 2
    LEAN_PATH="/tmp/work:$BASE_LEAN_PATH" "$LEAN_BIN" --root=/tmp/work Submission.lean -o Submission.olean 1>&2
    rc=$?
    # 137 = Lean was SIGKILLed inside the container (cgroup OOM killer): report it as such.
    if [ "$rc" -eq 137 ]; then exit 137; fi
    if [ "$rc" -ne 0 ] || [ ! -s Submission.olean ]; then exit 1; fi
    cat Submission.olean
    ;;
  check)
    name="${2:-}"
    if ! [[ "$name" =~ ^L_[A-Za-z0-9_]+$ ]]; then echo "invalid lean name" >&2; exit 2; fi
    unpack /tmp/in
    rm -rf /tmp/deps /tmp/sub /tmp/chk && mkdir -p /tmp/deps/Proofs /tmp/sub /tmp/chk || exit 2
    [ -f /tmp/in/deps.txt ] && cp /tmp/in/deps.txt /tmp/deps/
    [ -d /tmp/in/Proofs ] && cp /tmp/in/Proofs/*.lean /tmp/deps/Proofs/ 2>/dev/null
    build_deps /tmp/deps
    mv /tmp/in/Submission.olean /tmp/sub/Submission.olean || exit 2
    LP="/tmp/deps:$BASE_LEAN_PATH:/tmp/sub"
    cat > /tmp/chk/Check.lean <<LEAN
import Statements.${name}
import Submission
example : Statement.${name} := Proof.${name}
LEAN
    cd /tmp/chk || exit 2
    # Checker 0: elaborate `example : Statement.X := Proof.X` in a fresh file.
    if LEAN_PATH="$LP" "$LEAN_BIN" Check.lean > out.txt 2>&1; then
      echo "HATCHERY_TYPECHECK ok"
    else
      echo "HATCHERY_TYPECHECK fail"
      head -n 40 out.txt | sed 's/^/HATCHERY_TYPECHECK_LOG /'
    fi
    # Checker 2: leanchecker (formerly lean4checker), independent replay of the module's constants.
    if LEAN_PATH="$LP" "$LEANCHECKER" Submission > lc.txt 2>&1; then
      echo "HATCHERY_LEANCHECKER ok"
    else
      echo "HATCHERY_LEANCHECKER fail"
    fi
    head -n 40 lc.txt | sed 's/^/HATCHERY_LEANCHECKER_LOG /'
    # Checker 1: our judgecheck (kernel replay, defeq, own axiom walk).
    LEAN_PATH="$LP" "$JUDGECHECK" "$name"
    ;;
  version)
    "$LEAN_BIN" --version; echo "flavor=$HATCHERY_FLAVOR"; echo "trusted_sha=$(cat /opt/hatchery/lean/trusted.sha256)"
    ;;
  search)
    # Fixed-string search over the library sources (Lean core Init/Std; Mathlib in the full image).
    q="${2:-}"
    if [ -z "$q" ] || [ "${#q}" -gt 100 ] || ! [[ "$q" =~ ^[[:print:]]+$ ]]; then echo "invalid query" >&2; exit 2; fi
    # shellcheck disable=SC2086
    grep -rnF --include='*.lean' -m 5 -- "$q" $LIBRARY_SRC 2>/dev/null | sed "s#^$LEAN_SYSROOT/src/lean/##; s#^/opt/hatchery/lean/.lake/packages/mathlib/##" | head -n 60
    ;;
  *)
    echo "usage: runner.sh compile | check <LeanName> | version | search <text>   (tar archive on stdin)" >&2; exit 2
    ;;
esac
