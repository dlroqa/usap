#!/usr/bin/env bash
# Bench-only: run the patched 20-client refusal test N times in ./target and record pass/fail plus the observation records.
set -u
N="${1:-60}"; OUT="$PWD/out"; mkdir -p "$OUT"
pass=0; fail=0
for i in $(seq 1 "$N"); do
  ( cd target && DIAGF0="$OUT/diagf0.jsonl" perl -e 'alarm shift; exec @ARGV' 120 node --test --test-name-pattern="20 concurrent refused clients" scripts/tests/refusal-close.test.cjs > "$OUT/run-$i.txt" 2>&1 )
  if grep -q "^# fail 0" "$OUT/run-$i.txt" && grep -q "^# pass 1" "$OUT/run-$i.txt"; then pass=$((pass+1)); else fail=$((fail+1)); echo "run $i FAILED"; grep -E "AssertionError" "$OUT/run-$i.txt" | head -2; fi
done
echo "{\"runs\": $N, \"pass\": $pass, \"fail\": $fail}" | tee "$OUT/summary.json"
