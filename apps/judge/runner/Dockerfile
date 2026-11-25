# syntax=docker/dockerfile:1
# Lean runner image. Every judge check uses TWO fresh containers from this image:
#   1. `compile`       untrusted source on stdin  -> Submission.olean on stdout
#   2. `check <Name>`  that olean on stdin        -> trusted verdict data on stdout
# The judge service (apps/judge) starts them with --network none, --read-only, non-root,
# and CPU / memory / pids / time limits. See docs/judge.md.
#
# Build from the repo root:
#   docker build -f apps/judge/runner/Dockerfile --build-arg FLAVOR=lite -t hatchery-lean-runner:lite .
#   docker build -f apps/judge/runner/Dockerfile --build-arg FLAVOR=full -t hatchery-lean-runner:full .
# FLAVOR=full -> pinned Mathlib v4.36.0 with its prebuilt cache (~7-8 GB image)
# FLAVOR=lite -> Lean core only (judge development and tests; Mathlib imports fail to resolve)
ARG FLAVOR=full

FROM debian:bookworm-20251117-slim@sha256:b4aa902587c2e61ce789849cb54c332b0400fe27b1ee33af4669e1f7e7c3e22f AS toolchain
ARG ELAN_VERSION=v4.4.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 --shell /bin/bash lean \
 && mkdir -p /opt/hatchery/lean /opt/hatchery/bin \
 && chown -R lean:lean /opt/hatchery/lean
USER lean
ENV ELAN_HOME=/home/lean/.elan
ENV PATH=/home/lean/.elan/bin:$PATH
RUN curl -fsSL "https://raw.githubusercontent.com/leanprover/elan/${ELAN_VERSION}/elan-init.sh" -o /tmp/elan-init.sh \
 && sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain none \
 && rm /tmp/elan-init.sh
WORKDIR /opt/hatchery/lean
COPY --chown=lean:lean lean/lean-toolchain ./
RUN elan toolchain install "$(cat lean-toolchain)" && elan default "$(cat lean-toolchain)"

FROM toolchain AS project
ARG FLAVOR
# Dependencies first, so editing statements/proofs does not re-download Mathlib.
COPY --chown=lean:lean lean/lakefile.toml lean/lakefile.lite.toml lean/lake-manifest.json ./
RUN set -e; \
    if [ "$FLAVOR" = "lite" ]; then \
      mv lakefile.lite.toml lakefile.toml && rm lake-manifest.json; \
    elif [ "$FLAVOR" = "full" ]; then \
      rm lakefile.lite.toml && lake exe cache get && rm -rf /home/lean/.cache/mathlib; \
    else echo "FLAVOR must be 'full' or 'lite'" >&2; exit 1; fi
# Only the toolchain pin, the definitions and the checker are baked in. Statements and checked
# proofs arrive with every request (from the desk, which holds the approved versions).
COPY --chown=lean:lean lean/Defs ./Defs
COPY --chown=lean:lean lean/Judge ./Judge
# Hash of the trusted inputs baked into this image (toolchain pin, Defs). The desk computes the
# same hash from its checkout and refuses to judge if they differ (stale image).
RUN find lean-toolchain Defs -type f \( -name '*.lean' -o -name lean-toolchain \) \
      | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1 > trusted.sha256
RUN lake build
# Resolve every path at build time so the read-only runtime never touches elan or lake.
RUN T="$(dirname "$(dirname "$(elan which lean)")")" \
 && { echo "export LEAN_SYSROOT='$T'"; \
      echo "export LEAN_BIN='$T/bin/lean'"; \
      echo "export BASE_LEAN_PATH='$(lake env printenv LEAN_PATH)'"; \
      echo "export LD_LIBRARY_PATH='$(lake env printenv LD_LIBRARY_PATH)'"; \
      echo "export JUDGECHECK='/opt/hatchery/lean/.lake/build/bin/judgecheck'"; \
      echo "export LEANCHECKER='$T/bin/leanchecker'"; \
      echo "export LIBRARY_SRC='$T/src/lean/Init $T/src/lean/Std $(test -d .lake/packages/mathlib/Mathlib && echo /opt/hatchery/lean/.lake/packages/mathlib/Mathlib)'"; \
      echo "export PATH='$T/bin:/usr/bin:/bin'"; \
      echo "export HATCHERY_FLAVOR='$FLAVOR'"; } > /opt/hatchery/lean/runner.env

FROM project AS runner
ARG FLAVOR
LABEL org.opencontainers.image.title="hatchery-lean-runner" \
      org.opencontainers.image.licenses="Apache-2.0" \
      dev.hatchery.flavor="${FLAVOR}"
COPY --chmod=0555 apps/judge/runner/runner.sh /opt/hatchery/bin/runner.sh
USER lean
ENTRYPOINT ["/opt/hatchery/bin/runner.sh"]
