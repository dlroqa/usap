#!/usr/bin/env bash
# Bench only. Once per second until killed: wall clock (ms), 1-min load, node process count, summed node %CPU and the
# whole-machine CPU split (iostat runs separately). Output: $BENCH164_DIR/system.tsv
out="$BENCH164_DIR/system.tsv"
echo -e "t_ms\tload1\tnode_procs\tnode_pcpu\ttop_pcpu_procs" > "$out"
while :; do
  t=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  read -r n c <<<"$(ps -A -o pcpu=,comm= | awk '$2 ~ /node$/ {n++; c+=$1} END {printf "%d %.1f", n, c}')"
  top=$(ps -A -o pcpu=,comm= | sort -rn | head -3 | awk '{printf "%s:%s ", $1, $2}' | sed 's#/[^ ]*/##g')
  echo -e "$t\t$load\t$n\t$c\t$top" >> "$out"
  sleep 1
done
