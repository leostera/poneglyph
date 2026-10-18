#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TLA2TOOLS_JAR:-}" || ! -f "$TLA2TOOLS_JAR" ]]; then
  echo "Set TLA2TOOLS_JAR to a local tla2tools.jar" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")" && pwd)
evidence_dir=${READ_HEAD_EVIDENCE_DIR:-}
if [[ -n "$evidence_dir" && "$evidence_dir" != /* ]]; then evidence_dir="$PWD/$evidence_dir"; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$root"/ReadHeadPublication.{tla,safe.cfg,three-heads.cfg,no-freeze.cfg,no-fence.cfg,availability.cfg} "$tmp/"
cd "$tmp"
run_tlc() {
  java -Xmx2g -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC \
    -config "$1" ReadHeadPublication.tla >"$2" 2>&1
}
expect_counterexample() {
  local cfg=$1 invariant=$2 log=$3
  if run_tlc "$cfg" "$log"; then
    echo "$cfg unexpectedly satisfied $invariant" >&2
    exit 1
  fi
  if ! grep -q "Invariant $invariant is violated" "$log"; then
    tail -n 60 "$log" >&2
    exit 1
  fi
  echo "$cfg: expected $invariant counterexample"
}
if ! run_tlc ReadHeadPublication.safe.cfg safe.log; then
  tail -n 60 safe.log >&2
  exit 1
fi
echo "Clock-free replicated-head safety, bounded recovery and fair eventual acknowledgement passed"
grep -E 'states generated|depth of the complete' safe.log | tail -2
if ! run_tlc ReadHeadPublication.three-heads.cfg three-heads.log; then
  tail -n 60 three-heads.log >&2
  exit 1
fi
echo "Three-head registration, retirement, publication and recovery passed"
grep -E 'states generated|depth of the complete' three-heads.log | tail -2
expect_counterexample ReadHeadPublication.no-freeze.cfg ServingHeadsCurrent no-freeze.log
expect_counterexample ReadHeadPublication.no-fence.cfg ServingHeadsCurrent no-fence.log
expect_counterexample ReadHeadPublication.availability.cfg CanAnswer availability.log
echo "Bounded design evidence only: canonical storage, infinite capacity and unconditional availability are not proved"
if [[ -n "$evidence_dir" ]]; then
  mkdir -p "$evidence_dir"
  cp safe.log three-heads.log no-freeze.log no-fence.log availability.log "$evidence_dir/"
fi
