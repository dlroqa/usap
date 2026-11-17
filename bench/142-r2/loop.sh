#!/usr/bin/env bash
# Bench-only (#142): run the patched R2 test N times in ./target, recording pass/fail, the R2 observation records
# and any sd-server processes left under a test root after each run (recorded, then stopped by PID).
set -u
N="${1:-30}"; OUT="$PWD/out"; mkdir -p "$OUT"
pass=0; fail=0
for i in $(seq 1 "$N"); do
  ( cd target && DIAG142="$OUT/diag142.jsonl" timeout 180 node --test --test-timeout=600000 --test-name-pattern="^R2 \(slot on\)" scripts/tests/engine-slot.test.cjs > "$OUT/run-$i.txt" 2>&1 )
  if grep -q "^# fail 0" "$OUT/run-$i.txt"; then pass=$((pass+1)); else fail=$((fail+1)); echo "run $i FAILED"; fi
  sleep 1
  left=$(ps -axo pid=,ppid=,pgid=,etime=,args= | grep "usap-contract-" | grep "sd-server" | grep -v grep || true)
  if [ -n "$left" ]; then echo "run $i leftover: $left" | tee -a "$OUT/leftovers.txt"; echo "$left" | awk '{print $1}' | xargs -r kill -9; fi
done
echo "{\"runs\": $N, \"pass\": $pass, \"fail\": $fail}" | tee "$OUT/summary.json"
