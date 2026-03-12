#!/usr/bin/env bash
set -euo pipefail

children=()
labels=()

start() {
  local label="$1"
  shift

  echo "[dev] starting ${label}"
  "$@" &
  children+=("$!")
  labels+=("$label")
}

kill_tree() {
  local pid="$1"
  local child_pid

  while read -r child_pid; do
    [[ -n "$child_pid" ]] || continue
    kill_tree "$child_pid"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  local pid

  for pid in "${children[@]}"; do
    kill_tree "$pid"
  done

  wait "${children[@]}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

start app bun run --cwd app dev
start www bun run --cwd www dev
start ui bun run --cwd packages/ui dev

# If any server exits or fails, stop the others and bubble the status.
status=0
finished_pid=""
if ! wait -n -p finished_pid "${children[@]}"; then
  status=$?
fi

for i in "${!children[@]}"; do
  if [[ "${children[$i]}" == "$finished_pid" ]]; then
    if [[ "$status" -eq 0 ]]; then
      echo "[dev] ${labels[$i]} exited cleanly"
    else
      echo "[dev] ${labels[$i]} exited with status ${status}"
    fi
    break
  fi
done

cleanup
exit "$status"
