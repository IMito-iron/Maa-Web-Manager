#!/bin/bash
# Test double for maa-cli. Behaviour comes from a top-level "fake_mode" in the run snapshot (the
# Manager runs a private copy named <run-id>-<n>.json), falling back to the file's base name.
set -eu
[[ "$1" == version ]] && { echo 'fake maa 1'; exit 0; }
mode=$(grep -o '"fake_mode":"[a-z]*"' "$2" 2>/dev/null | head -1 | cut -d'"' -f4 || true)
mode=${mode:-$(basename "$2" .json)}
echo "fake running $mode"
case "$mode" in
  fail) echo 'intentional failure' >&2; exit 7;;
  slow) trap 'echo stopped; exit 0' TERM; sleep 60 & wait;;
  stubborn) trap '' TERM; sleep 60 & wait;;
  *) echo '任务完成 ✓'; sleep 1;;
esac
