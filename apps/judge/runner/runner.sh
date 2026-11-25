#!/bin/bash
# Entrypoint of the Lean runner container. Each mode runs in its OWN fresh container.
#
#   compile        stdin:  untrusted Lean source (one file)
#                  stdout: raw bytes of Submission.olean (only on success)
#                  stderr: Lean messages
#                  exit:   0 compiled, 1 Lean errors, 2 usage, 137 killed (memory)
#
#   check <Name>   stdin:  Submission.olean bytes produced by `compile` (treated as untrusted)
#                  stdout: HATCHERY_TYPECHECK ok|fail, HATCHERY_TYPECHECK_LOG <line>...,
#                          HATCHERY_REPORT <json>   (from the trusted `judgecheck` tool)
#
# Time limits are enforced from outside (the judge kills the container). Memory, CPU, pids,
# network and filesystem limits come from `docker run` flags.
set -uo pipefail
# shellcheck disable=SC1091
. /opt/hatchery/lean/runner.env
export HOME=/tmp

case "${1:-}" in
  compile)
    rm -rf /tmp/work && mkdir -p /tmp/work && cd /tmp/work || exit 2
    head -c 1000000 > Submission.lean
    LEAN_PATH="$BASE_LEAN_PATH" "$LEAN_BIN" --root=/tmp/work Submission.lean -o Submission.olean 1>&2
    rc=$?
    # 137 = Lean was SIGKILLed inside the container (cgroup OOM killer): report it as such.
    if [ "$rc" -eq 137 ]; then exit 137; fi
    if [ "$rc" -ne 0 ] || [ ! -s Submission.olean ]; then exit 1; fi
    cat Submission.olean
    ;;
  check)
    name="${2:-}"
    if ! [[ "$name" =~ ^L_[A-Za-z0-9_]+$ ]]; then echo "invalid lean name" >&2; exit 2; fi
    rm -rf /tmp/sub /tmp/chk && mkdir -p /tmp/sub /tmp/chk || exit 2
    head -c 268435456 > /tmp/sub/Submission.olean
    cat > /tmp/chk/Check.lean <<LEAN
import Statements.${name}
import Submission
example : Statement.${name} := Proof.${name}
LEAN
    cd /tmp/chk || exit 2
    if LEAN_PATH="$BASE_LEAN_PATH:/tmp/sub" "$LEAN_BIN" Check.lean > out.txt 2>&1; then
      echo "HATCHERY_TYPECHECK ok"
    else
      echo "HATCHERY_TYPECHECK fail"
      head -n 40 out.txt | sed 's/^/HATCHERY_TYPECHECK_LOG /'
    fi
    LEAN_PATH="$BASE_LEAN_PATH:/tmp/sub" "$JUDGECHECK" "$name"
    ;;
  version)
    "$LEAN_BIN" --version; echo "flavor=$HATCHERY_FLAVOR"
    ;;
  *)
    echo "usage: runner.sh compile | check <LeanName> | version" >&2; exit 2
    ;;
esac
