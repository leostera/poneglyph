#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TLA2TOOLS_JAR:-}" || ! -f "$TLA2TOOLS_JAR" ]]; then
  echo "Set TLA2TOOLS_JAR to a local tla2tools.jar" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for name in TransactionVisibility ShardSplit; do
  cp "$root/$name.tla" "$root/$name.cfg" "$tmp/"
  (
    cd "$tmp"
    java -cp "$TLA2TOOLS_JAR" pcal.trans -nocfg "$name.tla"
    java -XX:+UseParallelGC -cp "$TLA2TOOLS_JAR" tlc2.TLC -config "$name.cfg" "$name.tla"
  )
done
