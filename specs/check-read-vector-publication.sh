#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TLA2TOOLS_JAR:-}" || ! -f "$TLA2TOOLS_JAR" ]]; then
  echo "Set TLA2TOOLS_JAR to a local tla2tools.jar" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cp "$root/ReadVectorPublication.tla" \
  "$root/ReadVectorPublication.gated.cfg" \
  "$root/ReadVectorPublication.naive.cfg" \
  "$root/ReadVectorPublication.parallel.cfg" \
  "$root/ReadVectorPublication.lease-overlap.cfg" \
  "$root/ReadVectorRecovery.tla" \
  "$root/ReadVectorRecovery.cfg" \
  "$root/ReadVectorRecovery.parallel.cfg" \
  "$root/ReadVectorRecovery.lease-overlap.cfg" \
  "$tmp/"

cd "$tmp"
java -cp "$TLA2TOOLS_JAR" pcal.trans -nocfg ReadVectorPublication.tla

run_tlc() {
  local cfg=$1
  local module=$2
  local log=$3
  java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC \
    -config "$cfg" "$module" >"$log" 2>&1
}

expect_counterexample() {
  local cfg=$1
  local module=$2
  local invariant=$3
  local log=$4

  if run_tlc "$cfg" "$module" "$log"; then
    echo "$cfg unexpectedly satisfied $invariant" >&2
    exit 1
  fi

  if ! grep -q "Invariant $invariant is violated" "$log"; then
    echo "$cfg failed for an unexpected reason:" >&2
    cat "$log" >&2
    exit 1
  fi
}

if ! run_tlc ReadVectorPublication.gated.cfg ReadVectorPublication.tla gated.log; then
  cat gated.log >&2
  exit 1
fi
expect_counterexample ReadVectorPublication.naive.cfg ReadVectorPublication.tla \
  ClosedFrontier naive-counterexample.log

if ! run_tlc ReadVectorRecovery.cfg ReadVectorRecovery.tla recovery.log; then
  cat recovery.log >&2
  exit 1
fi
expect_counterexample ReadVectorRecovery.parallel.cfg ReadVectorRecovery.tla \
  NoDisjointFinalizers recovery-parallel-witness.log
expect_counterexample ReadVectorRecovery.lease-overlap.cfg ReadVectorRecovery.tla \
  NoLeaseDuringFinalization recovery-lease-overlap.log

echo "Verified:"
echo "- gated vector safety model passed"
echo "- recovery-step model passed safety/no-deadlock checks and fair eventual-ack progress"
echo "- naive max-publication produced the expected ClosedFrontier counterexample"
echo "- disjoint owner finalizers can overlap"
echo "- a read lease can be acquired during writer finalization"
printf '\n%s\n' '--- gated model state count ---'
grep -E 'states generated|Model checking completed|depth of the complete' gated.log | tail -3
printf '\n%s\n' '--- recovery model state count ---'
grep -E 'states generated|Model checking completed|depth of the complete' recovery.log | tail -3
printf '\n%s\n' '--- naive closure counterexample ---'
grep -E 'State [0-9]+:|frontier =|revision =|published =' naive-counterexample.log | tail -12
